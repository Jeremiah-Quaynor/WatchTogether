// Per-frame glue: wires the video detector, sync engine, and on-page
// overlay together, and is the only place that talks to the background
// service worker from this frame. Runs in every frame (all_frames: true).

(function () {
  const WT = window.WT;
  const MSG = WT.MSG;

  const isTop = window.top === window;
  let topHostname = location.hostname;
  try { topHostname = window.top.location.hostname; } catch (e) { /* cross-origin top, fall back to our own */ }

  function sendToBackground(partial) {
    chrome.runtime.sendMessage(partial).catch(() => {});
  }

  // ---- Netflix is explicitly out of scope -------------------------------
  if (isTop && WT.isNetflix(topHostname)) {
    const overlay = new WT.Overlay({ isTop: true, onReaction() {}, onChat() {}, onPickClick() {}, onSwitchClick() {} });
    overlay.showNetflixBanner();
    sendToBackground({ type: MSG.FRAME_HELLO, isTop: true, isNetflix: true });
    return; // no video detection / sync on netflix.com
  }
  if (!isTop && WT.isNetflix(topHostname)) {
    return; // sub-frames of a netflix.com tab do nothing either
  }

  // ---- Normal operation ---------------------------------------------------
  const detector = new WT.VideoDetector();
  const sync = new WT.VideoSync(sendToBackground);
  let isControllingFrame = false;
  let partyActive = false;
  let voiceState = { joined: false, muted: false };

  function isSafeHttpUrl(url) {
    try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch (e) { return false; }
  }

  function trySwitchToPlayerUrl(url) {
    // `url` comes from the remote peer (and is echoed into DOM navigation
    // below) - never allow a javascript: or other non-http(s) scheme.
    if (!isSafeHttpUrl(url)) return;
    const candidates = Array.from(document.querySelectorAll('iframe'))
      .map((f) => ({ f, r: f.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 200 && r.height > 150)
      .sort((a, b) => (b.r.width * b.r.height) - (a.r.width * a.r.height));
    if (candidates.length) {
      try { candidates[0].f.src = url; return; } catch (e) { /* fall through to new tab */ }
    }
    window.open(url, '_blank');
  }

  const overlay = new WT.Overlay({
    isTop,
    onReaction(emoji) {
      WT.emojiStore.recordRecentEmoji(emoji).then(() => overlay.refreshFsReactions());
      sendToBackground({ type: MSG.SEND_REACTION, emoji });
    },
    onChat(text) {
      sendToBackground({ type: MSG.SEND_CHAT, text });
    },
    onPickClick() {
      sendToBackground({ type: MSG.PICK_VIDEO_MODE, enable: true });
    },
    onSwitchClick(url) {
      trySwitchToPlayerUrl(url);
    },
    onReadyCheck() {
      sendToBackground({ type: MSG.START_READY_CHECK });
    },
    onCancelReadyCheck() {
      sendToBackground({ type: MSG.CANCEL_READY_CHECK });
    },
    onToggleVoice() {
      sendToBackground({ type: voiceState.joined ? MSG.LEAVE_VOICE : MSG.JOIN_VOICE });
    },
    onToggleMute() {
      sendToBackground({ type: MSG.SET_VOICE_MUTED, muted: !voiceState.muted });
    }
  });

  detector.start((status, video, score) => {
    if (status === 'found') {
      sync.attach(video);
      overlay.setVideoElement(video);
      if (isTop) overlay.setStatus('found');
      sendToBackground({ type: MSG.VIDEO_STATUS, status: 'found', score, duration: (isFinite(video.duration) && video.duration) || 0 });
    } else if (status === 'lost') {
      sync.detach();
      if (isTop) overlay.setStatus('lost');
      sendToBackground({ type: MSG.VIDEO_STATUS, status: 'lost' });
    } else {
      if (isTop) overlay.setStatus('none');
      sendToBackground({ type: MSG.VIDEO_STATUS, status: 'none' });
    }
  });

  sendToBackground({ type: MSG.FRAME_HELLO, isTop, isNetflix: false });
  sendToBackground({ type: MSG.GET_PARTY_STATE });

  // ---- Player-switch detection (top frame only) --------------------------
  // A large iframe's src changing is itself the signal that the host picked
  // a different "server" - we don't wait for the old frame to self-report
  // as lost first, since a torn-down iframe often never gets the chance to.
  if (isTop) {
    let lastKnownSrc = null;
    let hasBaseline = false; // the first big iframe we see is the initial page load, not a "switch"
    let debounceTimer = null;
    const maybeReportSwitch = (el) => {
      let rect;
      try { rect = el.getBoundingClientRect(); } catch (e) { return; }
      if (rect.width < 200 || rect.height < 150) return;
      let src = '';
      try { src = el.src; } catch (e) { return; }
      if (!src || src === lastKnownSrc) return;
      if (!hasBaseline) {
        hasBaseline = true;
        lastKnownSrc = src;
        return;
      }
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        lastKnownSrc = src;
        sendToBackground({ type: MSG.PLAYER_SWITCHED, url: src });
      }, 800);
    };
    const iframeObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes' && m.target.tagName === 'IFRAME') {
          maybeReportSwitch(m.target);
        } else if (m.type === 'childList') {
          m.addedNodes.forEach((node) => {
            if (node.tagName === 'IFRAME') maybeReportSwitch(node);
            else if (node.querySelectorAll) node.querySelectorAll('iframe').forEach(maybeReportSwitch);
          });
        }
      }
    });
    iframeObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
  }

  // ---- Messages from the background service worker -----------------------
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.target !== 'content') return;

    switch (msg.type) {
      case MSG.FRAME_HELLO: // re-hello ping after a service worker restart
        sendToBackground({ type: MSG.FRAME_HELLO, isTop, isNetflix: false });
        sendToBackground({ type: MSG.GET_PARTY_STATE });
        break;

      case MSG.PARTY_STATE: {
        const state = msg.state;
        partyActive = !!state.active;
        sync.setPartyActive(partyActive);
        if (isTop) {
          if (!partyActive) {
            overlay.setPartyLine('');
          } else if (state.connectionStatus === 'connected') {
            const partner = state.peers && state.peers[0];
            const quality = WT.latencyInfo(state.latencyMs);
            const qualityText = quality ? ` · ${quality.icon} ${quality.ms}ms` : '';
            overlay.setPartyLine(`🟢 Connected${partner ? ' with ' + partner.name : ''}${qualityText}`, 'connected');
          } else if (state.connectionStatus === 'reconnecting') {
            overlay.setPartyLine('🟡 Reconnecting…', 'connecting');
          } else if (state.connectionStatus === 'ended') {
            overlay.setPartyLine('🔴 Party ended', 'ended');
          } else {
            overlay.setPartyLine(`🟡 Room ${state.roomCode || ''} — waiting for your partner…`, 'connecting');
          }
        }
        if (state.voice) {
          voiceState = { joined: !!state.voice.joined, muted: !!state.voice.muted };
          overlay.setVoiceState({ joined: voiceState.joined, muted: voiceState.muted, connecting: !!state.voice.connecting });
        }
        break;
      }

      case MSG.YOU_ARE_CONTROLLING:
        isControllingFrame = true;
        sync.setControlling(true);
        break;

      case MSG.STAND_DOWN:
        isControllingFrame = false;
        sync.setControlling(false);
        break;

      case MSG.APPLY_REMOTE_ACTION:
        sync.applyRemoteAction(msg);
        break;

      case MSG.APPLY_REMOTE_HEARTBEAT:
        sync.applyRemoteHeartbeat(msg);
        break;

      case MSG.SET_BUFFER_WAIT:
        sync.setBufferGate(!!msg.wait);
        break;

      case MSG.READY_CHECK:
        overlay.showReadyCheck(msg.targetAt, msg.initiatorName, !!msg.self, () => sync.playNow());
        break;

      case MSG.READY_CHECK_CANCELLED:
        overlay.hideReadyCheck();
        break;

      case MSG.VOICE_STATE:
        voiceState = { joined: !!msg.joined, muted: !!msg.muted };
        overlay.setVoiceState({ joined: voiceState.joined, muted: voiceState.muted, connecting: !!msg.connecting });
        break;

      case MSG.DURATION_MISMATCH:
        if (isTop) overlay.showDurationMismatch(msg.local, msg.remote);
        break;

      case MSG.PLAYER_SWITCHED:
        if (isTop && msg.remote) overlay.showPlayerSwitchPrompt(msg.url);
        break;

      case MSG.SWITCH_TO_PLAYER_URL:
        if (isTop) trySwitchToPlayerUrl(msg.url);
        break;

      case MSG.PICK_VIDEO_MODE:
        if (msg.enable) {
          detector.enterPickMode((video) => {
            sync.attach(video);
            overlay.setVideoElement(video);
            sendToBackground({ type: MSG.VIDEO_PICKED });
          });
        } else {
          detector.exitPickMode();
        }
        break;

      case MSG.CHAT_MESSAGE:
        overlay.showChatToast(msg.message.self ? 'You' : msg.message.name, msg.message.text);
        break;

      case MSG.SYSTEM_MESSAGE:
        overlay.showChatToast('', msg.message.text);
        break;

      case MSG.REACTION:
        overlay.spawnReaction(msg.message.emoji, msg.message.self ? null : msg.message.name);
        break;

      default:
        break;
    }
  });
})();
