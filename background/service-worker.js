// Classic (non-module) service worker. Loads shared constants via importScripts.
importScripts('../shared/constants.js');
const { MSG, WIRE, STORAGE_KEYS, DEFAULT_SETTINGS, DEFAULT_ICE_SERVERS, DRIFT_THRESHOLD_SEC, READY_CHECK_LEAD_MS } = WT;

// ---------------------------------------------------------------------------
// In-memory state. `party` mirrors to chrome.storage.session so it survives
// the service worker being killed and woken back up; the live WebRTC
// connection itself lives in the offscreen document, which is NOT tied to
// the service worker's lifecycle, so it keeps running regardless.
// ---------------------------------------------------------------------------

function defaultParty() {
  return {
    active: false,
    isHost: false,
    roomCode: null,
    selfId: null,
    profile: { name: 'Guest', avatar: '🙂' },
    partyTabId: null,
    hostPageUrl: null,
    peers: [], // [{id, name, avatar}]
    connectionStatus: 'disconnected', // disconnected | connecting | connected | reconnecting
    latencyMs: 150,
    bufferAutoSync: true,
    localBuffering: false,
    remoteBuffering: false,
    pendingSnapshot: null, // snapshot received before a controlling frame existed
    lastDurations: { local: 0, remote: 0 },
    lastLocalHeartbeat: null,
    voice: { joined: false, muted: false, connecting: false, peers: [] } // cached mirror of offscreen's voice state
  };
}

let party = defaultParty();

// Per-tab frame bookkeeping. tabId -> { controllingFrameId, framesInfo: Map(frameId -> info), lastSwitchCandidate }
const tabFrames = new Map();

function getTabEntry(tabId) {
  let entry = tabFrames.get(tabId);
  if (!entry) {
    entry = { controllingFrameId: null, framesInfo: new Map(), netflixBlocked: false, lastCorrectionAt: 0 };
    tabFrames.set(tabId, entry);
  }
  return entry;
}

async function savePartyState() {
  try {
    await chrome.storage.session.set({ [STORAGE_KEYS.ROOM]: party });
  } catch (e) { /* ignore */ }
}

async function loadPartyState() {
  try {
    const got = await chrome.storage.session.get(STORAGE_KEYS.ROOM);
    return got[STORAGE_KEYS.ROOM] || null;
  } catch (e) { return null; }
}

async function getSettings() {
  const got = await chrome.storage.sync.get(STORAGE_KEYS.SETTINGS);
  return Object.assign({}, DEFAULT_SETTINGS, got[STORAGE_KEYS.SETTINGS] || {});
}

async function relayJoinVoice() {
  const settings = await getSettings();
  sendToOffscreen({ type: MSG.JOIN_VOICE, micDeviceId: settings.micDeviceId, speakerDeviceId: settings.speakerDeviceId });
}

async function getProfile() {
  const got = await chrome.storage.sync.get(STORAGE_KEYS.PROFILE);
  return got[STORAGE_KEYS.PROFILE] || { name: 'Guest', avatar: '🙂' };
}

function iceServersFromSettings(settings) {
  const servers = DEFAULT_ICE_SERVERS.slice();
  if (settings.turnUrl) {
    const turn = { urls: settings.turnUrl };
    if (settings.turnUsername) turn.username = settings.turnUsername;
    if (settings.turnCredential) turn.credential = settings.turnCredential;
    servers.push(turn);
  }
  return servers;
}

// ---------------------------------------------------------------------------
// Rehydrate on every (re)start of the service worker.
// ---------------------------------------------------------------------------
(async () => {
  const saved = await loadPartyState();
  if (saved && saved.active) {
    party = saved;
    // The offscreen document (and its live peer connection) survives SW
    // restarts independently. Ask it to report back its current status,
    // and ask the content frames in the party tab to re-announce themselves.
    try {
      const hasDoc = await chrome.offscreen.hasDocument();
      if (hasDoc) {
        chrome.runtime.sendMessage({ target: 'offscreen', type: MSG.GET_PARTY_STATE });
      } else {
        // Offscreen doc is gone too (e.g. browser restarted) - the session is over.
        party = defaultParty();
        await savePartyState();
      }
    } catch (e) { /* offscreen API not ready yet, ignore */ }
    if (party.partyTabId) {
      try {
        chrome.tabs.sendMessage(party.partyTabId, { target: 'content', type: MSG.FRAME_HELLO, ping: true });
      } catch (e) { /* ignore */ }
    }
  }
})();

// ---------------------------------------------------------------------------
// Offscreen document management
// ---------------------------------------------------------------------------
async function ensureOffscreenDocument() {
  const hasDoc = await chrome.offscreen.hasDocument();
  if (hasDoc) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['WEB_RTC', 'USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification: 'Hold the peer-to-peer WebRTC connection used to sync video playback and optional voice chat with a partner.'
  });
}

async function closeOffscreenDocument() {
  try {
    const hasDoc = await chrome.offscreen.hasDocument();
    if (hasDoc) await chrome.offscreen.closeDocument();
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Microphone permission tab: getUserMedia can't reliably prompt from an
// invisible offscreen document, so the first grant happens in a real tab
// (chrome-extension:// origin - the permission then persists for the
// offscreen document too, since permissions are origin-scoped).
// ---------------------------------------------------------------------------
let micPermissionTabId = null;

async function openMicPermissionTab() {
  if (micPermissionTabId != null) {
    try {
      await chrome.tabs.update(micPermissionTabId, { active: true });
      return;
    } catch (e) { micPermissionTabId = null; /* that tab's gone, open a fresh one below */ }
  }
  const tab = await chrome.tabs.create({ url: chrome.runtime.getURL('voice/mic-permission.html') });
  micPermissionTabId = tab.id;
}

function closeMicPermissionTab() {
  if (micPermissionTabId == null) return;
  chrome.tabs.remove(micPermissionTabId).catch(() => {});
  micPermissionTabId = null;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === micPermissionTabId) micPermissionTabId = null;
});

// ---------------------------------------------------------------------------
// Broadcasting helpers
// ---------------------------------------------------------------------------
function broadcastToUi(message) {
  chrome.runtime.sendMessage(Object.assign({ target: 'ui' }, message)).catch(() => {});
}

function sendToTab(tabId, message, frameId) {
  const opts = typeof frameId === 'number' ? { frameId } : undefined;
  chrome.tabs.sendMessage(tabId, Object.assign({ target: 'content' }, message), opts).catch(() => {});
}

function sendToOffscreen(message) {
  chrome.runtime.sendMessage(Object.assign({ target: 'offscreen' }, message)).catch(() => {});
}

// Reactions float over the actual video, so route them to whichever frame
// currently holds it (falling back to the top frame if none is known yet).
function videoFrameForTab(tabId) {
  const entry = tabFrames.get(tabId);
  return entry && entry.controllingFrameId != null ? entry.controllingFrameId : 0;
}

function pushPartyState() {
  broadcastToUi({ type: MSG.PARTY_STATE, state: publicPartyState() });
  if (party.partyTabId != null) {
    // Broadcast to every frame (not just top): whichever frame is currently
    // controlling the video needs to know the party is active, and only the
    // top frame's overlay happens to render a visible status line from it.
    sendToTab(party.partyTabId, { type: MSG.PARTY_STATE, state: publicPartyState() });
  }
}

function publicPartyState() {
  return {
    active: party.active,
    isHost: party.isHost,
    roomCode: party.roomCode,
    profile: party.profile,
    partyTabId: party.partyTabId,
    hostPageUrl: party.hostPageUrl,
    peers: party.peers,
    connectionStatus: party.connectionStatus,
    bufferAutoSync: party.bufferAutoSync,
    voice: party.voice,
    latencyMs: party.connectionStatus === 'connected' ? party.latencyMs : null
  };
}

function systemMessage(text) {
  const msg = { kind: 'system', text, ts: Date.now() };
  broadcastToUi({ type: MSG.SYSTEM_MESSAGE, message: msg });
  if (party.partyTabId) sendToTab(party.partyTabId, { type: MSG.SYSTEM_MESSAGE, message: msg });
}

// ---------------------------------------------------------------------------
// Party lifecycle
// ---------------------------------------------------------------------------
async function startParty(tabId) {
  const profile = await getProfile();
  const settings = await getSettings();
  party = defaultParty();
  party.active = true;
  party.isHost = true;
  party.roomCode = WT.generateRoomCode();
  party.selfId = WT.uid();
  party.profile = profile;
  party.partyTabId = tabId;
  party.connectionStatus = 'connecting';
  party.bufferAutoSync = settings.autoPauseOnBuffer;
  await savePartyState();
  await ensureOffscreenDocument();
  try {
    const tab = await chrome.tabs.get(tabId);
    party.hostPageUrl = tab.url || null;
  } catch (e) { /* ignore */ }
  await savePartyState();
  // give offscreen a moment to finish booting before messaging it
  setTimeout(() => {
    sendToOffscreen({
      type: MSG.PEER_CREATE_HOST,
      roomId: party.roomCode,
      iceServers: iceServersFromSettings(settings),
      profile,
      pageUrl: party.hostPageUrl
    });
  }, 150);
  pushPartyState();
}

async function joinParty(tabId, rawCode) {
  const code = WT.normalizeRoomCode(rawCode);
  const profile = await getProfile();
  const settings = await getSettings();
  party = defaultParty();
  party.active = true;
  party.isHost = false;
  party.roomCode = code;
  party.selfId = WT.uid();
  party.profile = profile;
  party.partyTabId = tabId;
  party.connectionStatus = 'connecting';
  party.bufferAutoSync = settings.autoPauseOnBuffer;
  await savePartyState();
  await ensureOffscreenDocument();
  setTimeout(() => {
    sendToOffscreen({
      type: MSG.PEER_JOIN,
      roomId: code,
      iceServers: iceServersFromSettings(settings),
      profile
    });
  }, 150);
  pushPartyState();
}

async function leaveParty(notifyPeer = true) {
  if (!party.active) return;
  const tabId = party.partyTabId;
  const shouldSayGoodbye = notifyPeer && party.connectionStatus === 'connected';
  if (notifyPeer) sendToOffscreen({ type: MSG.PEER_LEAVE });
  if (shouldSayGoodbye) {
    // Give the offscreen document's graceful-leave message (see
    // leaveGracefully() there) a moment to actually reach the peer before
    // we yank the whole document away - otherwise they'd just see a bare
    // connection drop instead of an explicit "party ended" message.
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  await closeOffscreenDocument();
  party = defaultParty();
  await savePartyState();
  if (tabId) sendToTab(tabId, { type: MSG.PARTY_STATE, state: publicPartyState() });
  pushPartyState();
}

// A definitive end: either we got an explicit goodbye from the peer, or the
// joiner-side reconnect loop in offscreen.js gave up. Shows a clear message
// (never the old misleading "trying to reconnect" for something that isn't
// actually retrying) and resets to the idle state shortly after, giving the
// user a moment to actually read it first.
function handlePartyEnded(name, wasHost, timedOut) {
  if (!party.active) return;

  // In a >2-person (star topology) party, a fellow JOINER leaving doesn't
  // end anything for anyone else - only the host leaving (who everyone
  // connects through) or giving up trying to reach the host does.
  if (!wasHost && !timedOut) {
    systemMessage(`${name || 'A partner'} left.`);
    // In a group party, only the host has a direct connection to whoever
    // just left - relay the news to everyone else too.
    if (party.isHost && party.peers.length > 1) {
      sendToOffscreen({ type: MSG.PEER_SEND, payload: { kind: WIRE.SYSTEM, text: `${name || 'A partner'} left.` } });
    }
    return;
  }

  const text = timedOut
    ? "Couldn't reconnect to your partner — the party may have ended."
    : 'Your partner ended the party.';
  party.connectionStatus = 'ended';
  systemMessage(text);
  pushPartyState();
  const endingSelfId = party.selfId;
  setTimeout(() => {
    // Guard against the user starting/joining a new party within the
    // display window - don't tear down a session that isn't this one.
    if (party.active && party.selfId === endingSelfId) leaveParty(false);
  }, WT.PARTY_ENDED_RESET_DELAY_MS);
}

// ---------------------------------------------------------------------------
// Video frame bookkeeping & sync relay
// ---------------------------------------------------------------------------
// A frame that's been torn down (e.g. its iframe navigated away during a
// player switch) simply stops sending updates - its last known status would
// otherwise linger forever and could keep "winning" the controller election
// over a genuinely live frame. Anything not heard from recently is ignored.
const FRAME_FRESHNESS_WINDOW_MS = 6000;

function maybeReassignController(tabId) {
  const entry = getTabEntry(tabId);
  const now = Date.now();
  if (entry.overrideFrameId != null) {
    const overrideInfo = entry.framesInfo.get(entry.overrideFrameId);
    if (overrideInfo && overrideInfo.status === 'found' && now - overrideInfo.lastSeen < FRAME_FRESHNESS_WINDOW_MS) {
      setController(tabId, entry.overrideFrameId);
      return;
    }
    entry.overrideFrameId = null; // the manually-picked video disappeared, fall back to automatic scoring
  }
  let bestFrameId = null;
  let bestScore = -Infinity;
  for (const [frameId, info] of entry.framesInfo) {
    if (info.status === 'found' && now - info.lastSeen < FRAME_FRESHNESS_WINDOW_MS && info.score > bestScore) {
      bestScore = info.score;
      bestFrameId = frameId;
    }
  }
  setController(tabId, bestFrameId);
}

function setController(tabId, frameId) {
  const entry = getTabEntry(tabId);
  if (entry.controllingFrameId === frameId) return;
  const prev = entry.controllingFrameId;
  entry.controllingFrameId = frameId;
  if (prev != null) sendToTab(tabId, { type: MSG.STAND_DOWN }, prev);
  if (frameId != null) {
    sendToTab(tabId, { type: MSG.YOU_ARE_CONTROLLING }, frameId);
    if (party.active && party.pendingSnapshot && tabId === party.partyTabId) {
      applySnapshotToFrame(tabId, frameId, party.pendingSnapshot);
      party.pendingSnapshot = null;
      savePartyState();
    }
  }
}

// ---------------------------------------------------------------------------
// Ready check: a synchronized "3, 2, 1, go" countdown before playback.
// Purely a client-side timing/visual feature - the actual play() each side
// triggers when its own countdown hits zero flows through the normal sync
// pipeline (sync.js's native 'play' handler), so no special echo-suppression
// or correctness logic is needed here beyond relaying the shared target time.
// ---------------------------------------------------------------------------
function startReadyCheck(initiatorName) {
  if (!party.active || party.partyTabId == null) return;
  const targetAt = Date.now() + READY_CHECK_LEAD_MS;
  sendToOffscreen({
    type: MSG.PEER_SEND,
    payload: { kind: WIRE.READY_CHECK, targetAt, initiatorName, originId: party.selfId }
  });
  sendToTab(party.partyTabId, { type: MSG.READY_CHECK, targetAt, initiatorName, self: true }, videoFrameForTab(party.partyTabId));
  broadcastToUi({ type: MSG.READY_CHECK, targetAt, initiatorName, self: true });
  systemMessage(`${initiatorName} started a ready check — 3, 2, 1…`);
}

function cancelReadyCheck() {
  if (!party.active || party.partyTabId == null) return;
  sendToOffscreen({ type: MSG.PEER_SEND, payload: { kind: WIRE.READY_CHECK_CANCEL, originId: party.selfId } });
  sendToTab(party.partyTabId, { type: MSG.READY_CHECK_CANCELLED }, videoFrameForTab(party.partyTabId));
  broadcastToUi({ type: MSG.READY_CHECK_CANCELLED });
}

function applySnapshotToFrame(tabId, frameId, snapshot) {
  sendToTab(tabId, {
    type: MSG.APPLY_REMOTE_ACTION,
    action: 'seek',
    time: snapshot.time,
    rate: snapshot.rate,
    thenPlay: !snapshot.paused
  }, frameId);
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  // Explicit target wins first: popup/side panel messages always carry
  // target:'background', even though Chrome may also populate sender.tab
  // for a side panel (it's associated with a tab). Only messages WITHOUT
  // that explicit target are treated as content-script messages.
  if (msg.target === 'background') {
    handleBackgroundTargetedMessage(msg, sendResponse);
    return true;
  }

  if (sender.tab && sender.tab.id != null) {
    handleContentMessage(msg, sender);
    return;
  }
});

function handleContentMessage(msg, sender) {
  const tabId = sender.tab.id;
  const frameId = sender.frameId;
  const entry = getTabEntry(tabId);

  switch (msg.type) {
    case MSG.FRAME_HELLO: {
      if (msg.isTop && msg.isNetflix) {
        entry.netflixBlocked = true;
        if (tabId === party.partyTabId) pushPartyState();
      } else if (msg.isTop) {
        entry.netflixBlocked = false;
      }
      break;
    }
    case MSG.VIDEO_STATUS: {
      entry.framesInfo.set(frameId, { status: msg.status, score: msg.score || 0, duration: msg.duration || 0, lastSeen: Date.now() });
      if (msg.status === 'lost' && entry.controllingFrameId === frameId) {
        entry.controllingFrameId = null;
      }
      maybeReassignController(tabId);
      break;
    }
    case MSG.VIDEO_EVENT: {
      if (entry.controllingFrameId !== frameId) break; // only the controlling frame drives sync
      if (party.active && tabId === party.partyTabId) {
        sendToOffscreen({
          type: MSG.PEER_SEND,
          payload: {
            kind: WIRE.VIDEO_ACTION,
            action: msg.action,
            time: msg.time,
            rate: msg.rate,
            label: msg.label,
            originId: party.selfId
          }
        });
        if (msg.label) systemMessage(`You ${msg.label}`);
      }
      break;
    }
    case MSG.HEARTBEAT_LOCAL: {
      if (entry.controllingFrameId !== frameId) break;
      party.lastLocalHeartbeat = { time: msg.time, paused: msg.paused, rate: msg.rate };
      if (party.active && tabId === party.partyTabId) {
        sendToOffscreen({
          type: MSG.PEER_SEND,
          payload: {
            kind: WIRE.HEARTBEAT,
            time: msg.time,
            paused: msg.paused,
            rate: msg.rate,
            sentAt: Date.now(),
            originId: party.selfId
          }
        });
      }
      break;
    }
    case MSG.DURATION_INFO: {
      if (entry.controllingFrameId !== frameId) break;
      party.lastDurations.local = msg.duration;
      if (party.active && tabId === party.partyTabId) {
        sendToOffscreen({ type: MSG.PEER_SEND, payload: { kind: WIRE.DURATION, duration: msg.duration, originId: party.selfId } });
        checkDurationMismatch(tabId);
      }
      break;
    }
    case MSG.BUFFERING: {
      if (entry.controllingFrameId !== frameId) break;
      party.localBuffering = msg.isBuffering;
      if (party.active && tabId === party.partyTabId) {
        sendToOffscreen({ type: MSG.PEER_SEND, payload: { kind: WIRE.BUFFERING, isBuffering: msg.isBuffering, originId: party.selfId } });
        applyBufferGate(tabId);
      }
      break;
    }
    case MSG.PLAYER_SWITCHED: {
      if (party.active && tabId === party.partyTabId) {
        sendToOffscreen({ type: MSG.PEER_SEND, payload: { kind: WIRE.PLAYER_SWITCHED, url: msg.url, originId: party.selfId } });
        systemMessage(`You switched players — your partner was notified.`);
      }
      break;
    }
    case MSG.VIDEO_PICKED: {
      entry.overrideFrameId = frameId;
      setController(tabId, frameId);
      sendToTab(tabId, { type: MSG.PICK_VIDEO_MODE, enable: false });
      break;
    }
    case MSG.GET_PARTY_STATE: {
      sendToTab(tabId, { type: MSG.PARTY_STATE, state: publicPartyState(), netflixBlocked: entry.netflixBlocked }, frameId);
      break;
    }
    case MSG.START_READY_CHECK: { // triggered from the fullscreen overlay button
      if (tabId === party.partyTabId) startReadyCheck(party.profile.name);
      break;
    }
    case MSG.CANCEL_READY_CHECK: {
      if (tabId === party.partyTabId) cancelReadyCheck();
      break;
    }
    case MSG.JOIN_VOICE: {
      if (tabId === party.partyTabId) relayJoinVoice();
      break;
    }
    case MSG.LEAVE_VOICE: {
      if (tabId === party.partyTabId) sendToOffscreen({ type: MSG.LEAVE_VOICE });
      break;
    }
    case MSG.SET_VOICE_MUTED: {
      if (tabId === party.partyTabId) sendToOffscreen({ type: MSG.SET_VOICE_MUTED, muted: msg.muted });
      break;
    }
    default:
      break;
  }
}

function checkDurationMismatch(tabId) {
  const { local, remote } = party.lastDurations;
  if (!local || !remote) return;
  const diff = Math.abs(local - remote);
  const mismatch = diff > 20 && diff > Math.max(local, remote) * 0.08;
  if (mismatch) {
    sendToTab(tabId, { type: MSG.DURATION_MISMATCH, local, remote, diff });
  }
}

function applyBufferGate(tabId) {
  if (!party.bufferAutoSync) return;
  const entry = getTabEntry(tabId);
  if (entry.controllingFrameId == null) return;
  const shouldWait = party.localBuffering || party.remoteBuffering;
  sendToTab(tabId, { type: MSG.SET_BUFFER_WAIT, wait: shouldWait }, entry.controllingFrameId);
}

// ---------------------------------------------------------------------------
// Messages from offscreen document / popup / side panel (target: 'background')
// ---------------------------------------------------------------------------
async function handleBackgroundTargetedMessage(msg, sendResponse) {
  switch (msg.type) {
    case MSG.START_PARTY: {
      const tabId = msg.tabId || (await getActiveTabId());
      await startParty(tabId);
      sendResponse && sendResponse({ ok: true });
      break;
    }
    case MSG.JOIN_PARTY: {
      const tabId = msg.tabId || (await getActiveTabId());
      await joinParty(tabId, msg.code);
      sendResponse && sendResponse({ ok: true });
      break;
    }
    case MSG.LEAVE_PARTY: {
      await leaveParty(true);
      sendResponse && sendResponse({ ok: true });
      break;
    }
    case MSG.GET_PARTY_STATE: {
      sendResponse && sendResponse({ state: publicPartyState() });
      break;
    }
    case MSG.OPEN_SAME_PAGE: {
      if (party.hostPageUrl && party.partyTabId) {
        chrome.tabs.update(party.partyTabId, { url: party.hostPageUrl });
      }
      sendResponse && sendResponse({ ok: true });
      break;
    }
    case MSG.SEND_CHAT: {
      const chatMsg = {
        id: WT.uid(),
        name: party.profile.name,
        avatar: party.profile.avatar,
        text: msg.text,
        ts: Date.now(),
        originId: party.selfId,
        self: true
      };
      broadcastToUi({ type: MSG.CHAT_MESSAGE, message: chatMsg });
      if (party.partyTabId) sendToTab(party.partyTabId, { type: MSG.CHAT_MESSAGE, message: chatMsg });
      if (party.active) sendToOffscreen({ type: MSG.PEER_SEND, payload: Object.assign({ kind: WIRE.CHAT }, chatMsg) });
      sendResponse && sendResponse({ ok: true });
      break;
    }
    case MSG.SEND_REACTION: {
      const reactionMsg = { emoji: msg.emoji, name: party.profile.name, ts: Date.now(), originId: party.selfId, self: true };
      broadcastToUi({ type: MSG.REACTION, message: reactionMsg });
      if (party.partyTabId) sendToTab(party.partyTabId, { type: MSG.REACTION, message: reactionMsg }, videoFrameForTab(party.partyTabId));
      if (party.active) sendToOffscreen({ type: MSG.PEER_SEND, payload: Object.assign({ kind: WIRE.REACTION }, reactionMsg) });
      sendResponse && sendResponse({ ok: true });
      break;
    }
    case MSG.SWITCH_TO_PLAYER_URL: {
      if (party.partyTabId) sendToTab(party.partyTabId, { type: MSG.SWITCH_TO_PLAYER_URL, url: msg.url }, 0);
      sendResponse && sendResponse({ ok: true });
      break;
    }
    case MSG.START_READY_CHECK: {
      startReadyCheck(party.profile.name);
      sendResponse && sendResponse({ ok: true });
      break;
    }
    case MSG.CANCEL_READY_CHECK: {
      cancelReadyCheck();
      sendResponse && sendResponse({ ok: true });
      break;
    }
    case MSG.JOIN_VOICE: {
      if (party.active) await relayJoinVoice();
      sendResponse && sendResponse({ ok: true });
      break;
    }
    case MSG.LEAVE_VOICE: {
      if (party.active) sendToOffscreen({ type: MSG.LEAVE_VOICE });
      sendResponse && sendResponse({ ok: true });
      break;
    }
    case MSG.SET_VOICE_MUTED: {
      if (party.active) sendToOffscreen({ type: MSG.SET_VOICE_MUTED, muted: msg.muted });
      sendResponse && sendResponse({ ok: true });
      break;
    }
    case MSG.SET_VOICE_OUTPUT_DEVICE: {
      if (party.active) sendToOffscreen({ type: MSG.SET_VOICE_OUTPUT_DEVICE, deviceId: msg.deviceId });
      sendResponse && sendResponse({ ok: true });
      break;
    }
    case MSG.MIC_PERMISSION_GRANTED: { // sent by the mic-permission tab itself
      sendToOffscreen({ type: MSG.MIC_PERMISSION_GRANTED });
      closeMicPermissionTab();
      sendResponse && sendResponse({ ok: true });
      break;
    }
    case MSG.PICK_VIDEO_MODE: {
      if (party.partyTabId) sendToTab(party.partyTabId, { type: MSG.PICK_VIDEO_MODE, enable: msg.enable });
      sendResponse && sendResponse({ ok: true });
      break;
    }
    case MSG.SETTINGS_UPDATED: {
      if (typeof msg.autoPauseOnBuffer === 'boolean') party.bufferAutoSync = msg.autoPauseOnBuffer;
      sendResponse && sendResponse({ ok: true });
      break;
    }

    // --- From the offscreen document ---
    case MSG.OFFSCREEN_READY: {
      sendResponse && sendResponse({ ok: true });
      break;
    }
    case MSG.PEER_STATUS: {
      // 'ended' is authoritative and terminal (set by handlePartyEnded, which
      // already has a reset scheduled) - don't let the close event that
      // naturally follows a graceful goodbye flip it back to 'disconnected'.
      if (party.connectionStatus !== 'ended') party.connectionStatus = msg.status;
      if (msg.selfPeerId && party.isHost) party.roomCode = msg.selfPeerId;
      if (Array.isArray(msg.peers)) party.peers = msg.peers;
      if (msg.status === 'connected' && msg.justConnectedPeer) {
        systemMessage(`${msg.justConnectedPeer.name || 'Your partner'} joined`);
        if (party.isHost && party.lastLocalHeartbeat) {
          sendToOffscreen({
            type: MSG.PEER_SEND,
            targetPeerId: msg.justConnectedPeerId,
            payload: Object.assign({ kind: WIRE.STATE_SNAPSHOT, originId: party.selfId }, party.lastLocalHeartbeat)
          });
        }
      }
      // No system message for a bare 'disconnected'/'reconnecting' status -
      // the connection line already reflects it live, and the specifics
      // (graceful goodbye vs. an active retry vs. giving up) are handled
      // precisely by handlePartyEnded() instead of guessing here.
      await savePartyState();
      pushPartyState();
      sendResponse && sendResponse({ ok: true });
      break;
    }
    case MSG.PEER_ERROR: {
      systemMessage(`Connection error: ${msg.error || 'unknown error'}`);
      sendResponse && sendResponse({ ok: true });
      break;
    }
    case MSG.PARTY_ENDED: {
      handlePartyEnded(msg.name, msg.wasHost, msg.timedOut);
      sendResponse && sendResponse({ ok: true });
      break;
    }
    case MSG.VOICE_STATE: {
      party.voice = { joined: !!msg.joined, muted: !!msg.muted, connecting: !!msg.connecting, peers: msg.peers || [] };
      broadcastToUi({ type: MSG.VOICE_STATE, joined: party.voice.joined, muted: party.voice.muted, connecting: party.voice.connecting, peers: party.voice.peers });
      if (party.partyTabId != null) {
        sendToTab(party.partyTabId, { type: MSG.VOICE_STATE, joined: party.voice.joined, muted: party.voice.muted, connecting: party.voice.connecting, peers: party.voice.peers });
      }
      sendResponse && sendResponse({ ok: true });
      break;
    }
    case MSG.VOICE_NEEDS_PERMISSION: {
      openMicPermissionTab();
      sendResponse && sendResponse({ ok: true });
      break;
    }
    case MSG.PEER_INCOMING: {
      handlePeerIncoming(msg.payload, msg.fromPeerId);
      sendResponse && sendResponse({ ok: true });
      break;
    }
    default:
      sendResponse && sendResponse({ ok: false, error: 'unknown type' });
      break;
  }
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ? tab.id : null;
}

// ---------------------------------------------------------------------------
// Incoming data from the remote peer (relayed by the offscreen document)
// ---------------------------------------------------------------------------
const RELAYABLE_KINDS = new Set([
  WIRE.VIDEO_ACTION, WIRE.HEARTBEAT, WIRE.BUFFERING, WIRE.DURATION,
  WIRE.PLAYER_SWITCHED, WIRE.CHAT, WIRE.REACTION,
  WIRE.READY_CHECK, WIRE.READY_CHECK_CANCEL
]);

function handlePeerIncoming(payload, fromPeerId) {
  if (!payload || !party.partyTabId) return;
  const tabId = party.partyTabId;
  const entry = getTabEntry(tabId);

  // Host-centric star topology (nice-to-have, >2 people): the host is the
  // only one every joiner connects to, so when it hears from one joiner it
  // re-sends the same payload on to every other joiner.
  if (party.isHost && party.peers.length > 1 && RELAYABLE_KINDS.has(payload.kind)) {
    sendToOffscreen({ type: MSG.PEER_SEND, excludePeerId: fromPeerId, payload });
  }

  switch (payload.kind) {
    case WIRE.STATE_SNAPSHOT: {
      if (entry.controllingFrameId != null) {
        applySnapshotToFrame(tabId, entry.controllingFrameId, payload);
      } else {
        party.pendingSnapshot = payload;
        savePartyState();
      }
      break;
    }
    case WIRE.VIDEO_ACTION: {
      if (entry.controllingFrameId == null) break;
      sendToTab(tabId, {
        type: MSG.APPLY_REMOTE_ACTION,
        action: payload.action,
        time: payload.time,
        rate: payload.rate
      }, entry.controllingFrameId);
      if (payload.label) systemMessage(`${peerName()} ${payload.label}`);
      break;
    }
    case WIRE.HEARTBEAT: {
      // Lightweight RTT ping/pong carried on the heartbeat itself.
      sendToOffscreen({ type: MSG.PEER_SEND, payload: { kind: 'heartbeat_ack', echoSentAt: payload.sentAt, originId: party.selfId } });
      if (entry.controllingFrameId == null) break;
      sendToTab(tabId, {
        type: MSG.APPLY_REMOTE_HEARTBEAT,
        time: payload.time,
        paused: payload.paused,
        rate: payload.rate,
        latencyMs: party.latencyMs,
        driftThreshold: DRIFT_THRESHOLD_SEC
      }, entry.controllingFrameId);
      break;
    }
    case 'heartbeat_ack': {
      const rtt = Date.now() - payload.echoSentAt;
      if (rtt >= 0 && rtt < 5000) {
        const prevBucket = WT.latencyInfo(party.latencyMs);
        party.latencyMs = Math.round(party.latencyMs * 0.7 + (rtt / 2) * 0.3);
        const nextBucket = WT.latencyInfo(party.latencyMs);
        // Only push a UI update when the user-visible quality label actually
        // changes, not on every few-ms wobble within the same bucket.
        if (!prevBucket || prevBucket.key !== nextBucket.key) pushPartyState();
      }
      break;
    }
    case WIRE.BUFFERING: {
      party.remoteBuffering = payload.isBuffering;
      applyBufferGate(tabId);
      break;
    }
    case WIRE.DURATION: {
      party.lastDurations.remote = payload.duration;
      checkDurationMismatch(tabId);
      break;
    }
    case WIRE.PLAYER_SWITCHED: {
      sendToTab(tabId, { type: MSG.PLAYER_SWITCHED, url: payload.url, remote: true }, 0);
      systemMessage(`${peerName()} switched players`);
      break;
    }
    case WIRE.READY_CHECK: {
      sendToTab(tabId, {
        type: MSG.READY_CHECK,
        targetAt: payload.targetAt,
        initiatorName: payload.initiatorName,
        self: false
      }, videoFrameForTab(tabId));
      broadcastToUi({ type: MSG.READY_CHECK, targetAt: payload.targetAt, initiatorName: payload.initiatorName, self: false });
      systemMessage(`${payload.initiatorName || peerName()} started a ready check — 3, 2, 1…`);
      break;
    }
    case WIRE.READY_CHECK_CANCEL: {
      sendToTab(tabId, { type: MSG.READY_CHECK_CANCELLED }, videoFrameForTab(tabId));
      broadcastToUi({ type: MSG.READY_CHECK_CANCELLED });
      break;
    }
    case WIRE.CHAT: {
      const chatMsg = Object.assign({}, payload, { self: false });
      broadcastToUi({ type: MSG.CHAT_MESSAGE, message: chatMsg });
      sendToTab(tabId, { type: MSG.CHAT_MESSAGE, message: chatMsg });
      break;
    }
    case WIRE.SYSTEM: {
      systemMessage(payload.text);
      break;
    }
    case WIRE.REACTION: {
      const reactionMsg = Object.assign({}, payload, { self: false });
      broadcastToUi({ type: MSG.REACTION, message: reactionMsg });
      sendToTab(tabId, { type: MSG.REACTION, message: reactionMsg }, videoFrameForTab(tabId));
      break;
    }
    case WIRE.PRESENCE: {
      party.peers = payload.peers || [];
      savePartyState();
      pushPartyState();
      break;
    }
    case WIRE.HELLO: {
      // A peer introduced itself with name/avatar/pageUrl - update roster + host page url for joiners.
      if (payload.pageUrl && !party.isHost) party.hostPageUrl = payload.pageUrl;
      savePartyState();
      pushPartyState();
      break;
    }
    default:
      break;
  }
}

function peerName() {
  const p = party.peers && party.peers[0];
  return (p && p.name) || 'Your partner';
}

// Accept the offscreen document's keep-alive port (its traffic alone resets
// the service worker's idle timer; we don't need to do anything with it).
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'wt-keepalive') return;
  port.onMessage.addListener(() => {});
});

// Clean up if the party tab is closed.
chrome.tabs.onRemoved.addListener((tabId) => {
  tabFrames.delete(tabId);
  if (party.active && party.partyTabId === tabId) {
    leaveParty(true);
  }
});
