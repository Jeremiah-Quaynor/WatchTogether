// Runs inside the offscreen document. Holds the actual PeerJS / WebRTC
// connection(s) - this cannot live in the service worker (MV3 restriction).
const { MSG, WIRE } = WT;

let peer = null;
let isHost = false;
let selfProfile = { name: 'Guest', avatar: '🙂' };
let hostPageUrl = null;
let joinedRoomId = null; // joiner only: the host's peer id, kept so we can retry connecting to it
let joinedIceServers = null;
let expectingGracefulEnd = false; // set right after receiving an explicit WIRE.PEER_LEFT
/** @type {Map<string, {conn: any, profile: {name:string,avatar:string}}>} */
const connections = new Map();

function notifyBackground(message) {
  chrome.runtime.sendMessage(Object.assign({ target: 'background' }, message)).catch(() => {});
}

function currentPeerList() {
  return Array.from(connections.values()).map((c) => c.profile || {});
}

function reportStatus(status, extra) {
  notifyBackground(Object.assign({
    type: MSG.PEER_STATUS,
    status,
    selfPeerId: peer ? peer.id : null,
    peers: currentPeerList()
  }, extra || {}));
}

function wireUpConnection(conn, initialProfileGuess) {
  connections.set(conn.peer, { conn, profile: initialProfileGuess || { name: 'Partner', avatar: '🙂' } });

  conn.on('open', () => {
    conn.send({ kind: WIRE.HELLO, name: selfProfile.name, avatar: selfProfile.avatar, pageUrl: isHost ? hostPageUrl : null, isHost });
    reportStatus('connected', { justConnectedPeer: connections.get(conn.peer).profile, justConnectedPeerId: conn.peer });
    // If we're already in voice chat (joined before this peer finished
    // connecting, or they reconnected), call them now too.
    if (localStream) {
      try { wireUpVoiceCall(peer.call(conn.peer, localStream)); } catch (e) { /* ignore */ }
    }
  });

  conn.on('data', (data) => {
    if (data && data.kind === WIRE.HELLO) {
      connections.set(conn.peer, { conn, profile: { name: data.name, avatar: data.avatar } });
      reportStatus('connected');
      // Fall through (don't return): background also wants the raw HELLO,
      // e.g. to pick up the host's pageUrl for the joiner's "Open the same
      // page" button.
    }
    if (data && data.kind === WIRE.VOICE_STATE) {
      // Handled entirely here (mute/join status for the roster display) -
      // background doesn't need to know about this one.
      remoteVoiceInfo.set(conn.peer, { inVoice: !!data.inVoice, muted: !!data.muted });
      reportVoiceState();
      return;
    }
    if (data && data.kind === WIRE.PEER_LEFT) {
      // An explicit, unambiguous goodbye - no point guessing or retrying.
      expectingGracefulEnd = true;
      stopReconnecting();
      notifyBackground({ type: MSG.PARTY_ENDED, name: data.name, wasHost: !!data.wasHost });
      return;
    }
    notifyBackground({ type: MSG.PEER_INCOMING, payload: data, fromPeerId: conn.peer });
  });

  conn.on('close', () => {
    connections.delete(conn.peer);
    const wasGraceful = expectingGracefulEnd;
    expectingGracefulEnd = false;
    reportStatus(connections.size > 0 ? 'connected' : 'disconnected');
    if (!isHost && connections.size === 0 && !wasGraceful) {
      startReconnecting();
    }
  });

  conn.on('error', (err) => {
    notifyBackground({ type: MSG.PEER_ERROR, error: String(err && err.message || err) });
  });
}

function destroyPeer() {
  stopReconnecting();
  joinedRoomId = null;
  joinedIceServers = null;
  leaveVoice();
  for (const { conn } of connections.values()) {
    try { conn.close(); } catch (e) { /* ignore */ }
  }
  connections.clear();
  remoteVoiceInfo.clear();
  if (peer) {
    try { peer.destroy(); } catch (e) { /* ignore */ }
    peer = null;
  }
}

// Tells any connected peer(s) we're intentionally leaving, gives the data
// channel a brief moment to actually flush it, then tears everything down -
// so the other side gets an unambiguous "party ended" instead of a bare
// connection drop it would otherwise have to guess about.
function leaveGracefully() {
  for (const { conn } of connections.values()) {
    if (conn && conn.open) {
      try { conn.send({ kind: WIRE.PEER_LEFT, name: selfProfile.name, wasHost: isHost }); } catch (e) { /* ignore */ }
    }
  }
  setTimeout(() => destroyPeer(), 250);
}

function createHost(roomId, iceServers, profile, pageUrl) {
  destroyPeer();
  isHost = true;
  selfProfile = profile;
  hostPageUrl = pageUrl || null;
  peer = new Peer(roomId, { config: { iceServers } });

  peer.on('open', (id) => {
    reportStatus('connecting', { selfPeerId: id });
  });

  peer.on('connection', (conn) => {
    wireUpConnection(conn);
  });

  peer.on('call', (call) => {
    call.answer(localStream || undefined);
    wireUpVoiceCall(call);
  });

  peer.on('error', (err) => {
    const type = err && err.type;
    if (type === 'unavailable-id') {
      // Extremely unlikely room-code collision - caller can just try starting again.
      notifyBackground({ type: MSG.PEER_ERROR, error: 'That room code is already in use, please try again.' });
    } else {
      notifyBackground({ type: MSG.PEER_ERROR, error: String(err && err.message || err) });
    }
  });

  peer.on('disconnected', () => {
    reportStatus('reconnecting');
    try { peer.reconnect(); } catch (e) { /* ignore */ }
  });
}

function joinRoom(roomId, iceServers, profile) {
  destroyPeer();
  isHost = false;
  selfProfile = profile;
  joinedRoomId = roomId;
  joinedIceServers = iceServers;
  peer = new Peer({ config: { iceServers } });

  peer.on('open', () => {
    const conn = peer.connect(roomId, { reliable: true });
    wireUpConnection(conn);
  });

  peer.on('call', (call) => {
    call.answer(localStream || undefined);
    wireUpVoiceCall(call);
  });

  peer.on('error', (err) => {
    const type = err && err.type;
    if (type === 'peer-unavailable') {
      notifyBackground({ type: MSG.PEER_ERROR, error: "Couldn't find that party. Check the room code and that your partner has started it." });
    } else {
      notifyBackground({ type: MSG.PEER_ERROR, error: String(err && err.message || err) });
    }
  });

  peer.on('disconnected', () => {
    reportStatus('reconnecting');
    try { peer.reconnect(); } catch (e) { /* ignore */ }
  });
}

// ---------------------------------------------------------------------------
// Joiner-side reconnect: the data CONNECTION to the host closing (as opposed
// to our own Peer losing its link to the signaling server, handled above by
// peer.on('disconnected')) has no built-in retry in PeerJS. Only the joiner
// can usefully retry, since the host's id (the room code) is stable while a
// joiner's own id is random - so a dropped joiner just calls the host again.
// ---------------------------------------------------------------------------
let reconnectTimer = null;
let reconnectAttempt = 0;

function stopReconnecting() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectAttempt = 0;
}

function startReconnecting() {
  if (isHost || !joinedRoomId || !peer || peer.destroyed) return;
  stopReconnecting();
  reportStatus('reconnecting');
  scheduleReconnectAttempt(0);
}

function scheduleReconnectAttempt(delay) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(doReconnectAttempt, delay);
}

function doReconnectAttempt() {
  if (isHost || !joinedRoomId || !peer || peer.destroyed) return;
  reconnectAttempt++;
  if (reconnectAttempt > WT.RECONNECT_MAX_ATTEMPTS) {
    notifyBackground({ type: MSG.PARTY_ENDED, wasHost: true, timedOut: true });
    return;
  }
  let settled = false;
  let conn;
  try {
    conn = peer.connect(joinedRoomId, { reliable: true });
  } catch (e) {
    scheduleReconnectAttempt(WT.RECONNECT_INTERVAL_MS);
    return;
  }
  const succeed = () => {
    if (settled) return;
    settled = true;
    stopReconnecting();
    wireUpConnection(conn);
  };
  const fail = () => {
    if (settled) return;
    settled = true;
    try { conn.close(); } catch (e) { /* ignore */ }
    scheduleReconnectAttempt(WT.RECONNECT_INTERVAL_MS);
  };
  conn.on('open', succeed);
  conn.on('error', fail);
  // PeerJS can just hang for an id that never answers - don't wait forever.
  setTimeout(fail, WT.RECONNECT_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Voice chat. Layered on the same Peer/connections as data sync - each
// voice call is a separate PeerJS MediaConnection to a peer we already have
// a data connection with. Scoped to direct pairs (not relayed through a
// star-topology host), matching the data-chat roster limitation.
// ---------------------------------------------------------------------------
let localStream = null;
let voiceMuted = false;
let voiceConnecting = false;
let micPermissionTimeout = null;
let currentSpeakerDeviceId = ''; // '' = system default
/** @type {Map<string, any>} peerId -> MediaConnection */
const voiceConnections = new Map();
/** @type {Map<string, HTMLAudioElement>} */
const remoteAudioEls = new Map();
/** @type {Map<string, {inVoice: boolean, muted: boolean}>} */
const remoteVoiceInfo = new Map();
let audioCtx = null;
/** @type {Map<string, {source:any, analyser:any, rafId:number|null, speaking:boolean}>} */
const speakingMeters = new Map();

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function broadcastVoiceState() {
  for (const [, { conn }] of connections) {
    if (conn && conn.open) {
      try { conn.send({ kind: WIRE.VOICE_STATE, inVoice: !!localStream, muted: voiceMuted }); } catch (e) { /* ignore */ }
    }
  }
}

function currentVoiceRoster() {
  const roster = [];
  for (const [peerId, { profile }] of connections) {
    const info = remoteVoiceInfo.get(peerId);
    if (!info || !info.inVoice) continue;
    const meter = speakingMeters.get(peerId);
    roster.push({
      id: peerId,
      name: profile && profile.name,
      avatar: profile && profile.avatar,
      muted: !!info.muted,
      speaking: !!(meter && meter.speaking)
    });
  }
  return roster;
}

function reportVoiceState() {
  notifyBackground({
    type: MSG.VOICE_STATE,
    joined: !!localStream,
    muted: voiceMuted,
    connecting: voiceConnecting,
    peers: currentVoiceRoster()
  });
}

async function getMicStream(deviceId) {
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const status = await navigator.permissions.query({ name: 'microphone' });
      if (status.state === 'denied') {
        const err = new Error('Microphone access is blocked for this extension.');
        err.code = 'denied';
        throw err;
      }
      if (status.state === 'prompt') {
        const err = new Error('needs-permission');
        err.code = 'needs-permission';
        throw err;
      }
    }
  } catch (e) {
    if (e && e.code) throw e;
    // permissions.query for 'microphone' isn't supported everywhere - fall
    // through and let getUserMedia itself be the source of truth below.
  }
  const constraints = deviceId ? { audio: { deviceId: { exact: deviceId } } } : { audio: true };
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
      const err = new Error('needs-permission');
      err.code = 'needs-permission';
      throw err;
    }
    if (deviceId && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) {
      // The saved microphone is gone (unplugged, etc.) - fall back to the
      // system default rather than failing to join voice chat entirely.
      return navigator.mediaDevices.getUserMedia({ audio: true });
    }
    throw e;
  }
}

let lastJoinMicDeviceId; // remembered so the post-permission-grant retry uses the same choice

async function joinVoice(micDeviceId, speakerDeviceId) {
  if (localStream || voiceConnecting) return;
  if (speakerDeviceId !== undefined) currentSpeakerDeviceId = speakerDeviceId || '';
  lastJoinMicDeviceId = micDeviceId;
  voiceConnecting = true;
  reportVoiceState();

  let stream;
  try {
    stream = await getMicStream(micDeviceId);
  } catch (e) {
    if (e && e.code === 'needs-permission') {
      notifyBackground({ type: MSG.VOICE_NEEDS_PERMISSION });
      // Stay "connecting" until the permission tab reports success (MIC_PERMISSION_GRANTED
      // retries us) or this times out, so the join button doesn't look stuck forever.
      clearTimeout(micPermissionTimeout);
      micPermissionTimeout = setTimeout(() => {
        if (voiceConnecting && !localStream) {
          voiceConnecting = false;
          reportVoiceState();
        }
      }, 60000);
      return;
    }
    voiceConnecting = false;
    notifyBackground({
      type: MSG.PEER_ERROR,
      error: e && e.code === 'denied'
        ? "Microphone access is blocked for WatchTogether. Allow it in Chrome's site settings for this extension, then try again."
        : "Couldn't access your microphone - check another app isn't already using it, then try again."
    });
    reportVoiceState();
    return;
  }

  clearTimeout(micPermissionTimeout);
  localStream = stream;
  voiceMuted = false;
  voiceConnecting = false;
  setupSpeakingMeter('local', localStream);
  for (const peerId of connections.keys()) {
    try { wireUpVoiceCall(peer.call(peerId, localStream)); } catch (e) { /* ignore */ }
  }
  broadcastVoiceState();
  reportVoiceState();
}

function leaveVoice() {
  clearTimeout(micPermissionTimeout);
  if (!localStream && !voiceConnecting) return;
  voiceConnecting = false;
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  teardownSpeakingMeter('local');
  for (const [, call] of voiceConnections) {
    try { call.close(); } catch (e) { /* ignore */ }
  }
  voiceConnections.clear();
  for (const peerId of Array.from(remoteAudioEls.keys())) detachRemoteAudio(peerId);
  voiceMuted = false;
  broadcastVoiceState();
  reportVoiceState();
}

function setVoiceMuted(muted) {
  if (!localStream) return;
  voiceMuted = !!muted;
  localStream.getAudioTracks().forEach((t) => { t.enabled = !voiceMuted; });
  broadcastVoiceState();
  reportVoiceState();
}

function wireUpVoiceCall(call) {
  const existing = voiceConnections.get(call.peer);
  if (existing && existing !== call) {
    try { existing.close(); } catch (e) { /* ignore */ }
  }
  voiceConnections.set(call.peer, call);
  call.on('stream', (remoteStream) => {
    if (voiceConnections.get(call.peer) !== call) return; // superseded by a newer call, ignore
    attachRemoteAudio(call.peer, remoteStream);
    reportVoiceState();
  });
  const cleanup = () => {
    if (voiceConnections.get(call.peer) !== call) return; // a newer call already took over this peer
    voiceConnections.delete(call.peer);
    detachRemoteAudio(call.peer);
    reportVoiceState();
  };
  call.on('close', cleanup);
  call.on('error', cleanup);
}

function attachRemoteAudio(peerId, stream) {
  let audioEl = remoteAudioEls.get(peerId);
  if (!audioEl) {
    audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    document.body.appendChild(audioEl);
    remoteAudioEls.set(peerId, audioEl);
  }
  audioEl.srcObject = stream;
  applySinkId(audioEl, currentSpeakerDeviceId);
  setupSpeakingMeter(peerId, stream);
}

function supportsSinkId() {
  return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
}

async function applySinkId(audioEl, deviceId) {
  if (!deviceId || !supportsSinkId()) return;
  try {
    await audioEl.setSinkId(deviceId);
  } catch (e) {
    // The saved speaker is gone, or this browser/version restricts
    // setSinkId - fall back to the system default rather than silence.
    notifyBackground({ type: MSG.PEER_ERROR, error: "Couldn't switch to the saved output device - using the system default instead." });
    try { await audioEl.setSinkId(''); } catch (e2) { /* ignore */ }
  }
}

// Called live (no rejoin needed) when the speaker selection changes.
function setOutputDevice(deviceId) {
  currentSpeakerDeviceId = deviceId || '';
  for (const audioEl of remoteAudioEls.values()) applySinkId(audioEl, currentSpeakerDeviceId);
}

function detachRemoteAudio(peerId) {
  const audioEl = remoteAudioEls.get(peerId);
  if (audioEl) { audioEl.srcObject = null; audioEl.remove(); remoteAudioEls.delete(peerId); }
  teardownSpeakingMeter(peerId);
}

function setupSpeakingMeter(key, stream) {
  teardownSpeakingMeter(key);
  try {
    const ctx = getAudioCtx();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const entry = { source, analyser, rafId: null, speaking: false };
    speakingMeters.set(key, entry);
    const loop = () => {
      if (!speakingMeters.has(key)) return;
      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const nowSpeaking = (sum / dataArray.length) > 14;
      if (nowSpeaking !== entry.speaking) {
        entry.speaking = nowSpeaking;
        reportVoiceState();
      }
      entry.rafId = requestAnimationFrame(loop);
    };
    loop();
  } catch (e) { /* speaking indicator is a nice-to-have, ignore failures */ }
}

function teardownSpeakingMeter(key) {
  const entry = speakingMeters.get(key);
  if (entry) {
    if (entry.rafId) cancelAnimationFrame(entry.rafId);
    try { entry.source.disconnect(); } catch (e) { /* ignore */ }
    speakingMeters.delete(key);
  }
}

// Keep the service worker from idling out while a party is active, by
// holding a long-lived port and pinging it periodically.
let keepAlivePort = null;
function ensureKeepAlive() {
  if (keepAlivePort) return;
  keepAlivePort = chrome.runtime.connect({ name: 'wt-keepalive' });
  keepAlivePort.onDisconnect.addListener(() => { keepAlivePort = null; });
  const interval = setInterval(() => {
    if (!peer) { clearInterval(interval); return; }
    try { keepAlivePort.postMessage({ ping: Date.now() }); } catch (e) { clearInterval(interval); }
  }, 20000);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;

  switch (msg.type) {
    case MSG.PEER_CREATE_HOST:
      createHost(msg.roomId, msg.iceServers, msg.profile, msg.pageUrl);
      ensureKeepAlive();
      break;
    case MSG.PEER_JOIN:
      joinRoom(msg.roomId, msg.iceServers, msg.profile);
      ensureKeepAlive();
      break;
    case MSG.PEER_LEAVE:
      leaveGracefully();
      break;
    case MSG.PEER_SEND: {
      for (const [peerId, { conn }] of connections) {
        if (msg.excludePeerId && peerId === msg.excludePeerId) continue;
        if (msg.targetPeerId && peerId !== msg.targetPeerId) continue;
        if (conn && conn.open) {
          try { conn.send(msg.payload); } catch (e) { /* ignore */ }
        }
      }
      break;
    }
    case MSG.GET_PARTY_STATE:
      // Background woke up after a restart and wants our current status.
      if (peer) reportStatus(connections.size > 0 ? 'connected' : 'connecting');
      break;
    case MSG.JOIN_VOICE:
      joinVoice(msg.micDeviceId, msg.speakerDeviceId);
      break;
    case MSG.LEAVE_VOICE:
      leaveVoice();
      break;
    case MSG.SET_VOICE_MUTED:
      setVoiceMuted(!!msg.muted);
      break;
    case MSG.SET_VOICE_OUTPUT_DEVICE:
      setOutputDevice(msg.deviceId);
      break;
    case MSG.MIC_PERMISSION_GRANTED:
      clearTimeout(micPermissionTimeout);
      voiceConnecting = false; // let joinVoice()'s guard pass through again
      joinVoice(lastJoinMicDeviceId, undefined);
      break;
    default:
      break;
  }
});

notifyBackground({ type: MSG.OFFSCREEN_READY });
