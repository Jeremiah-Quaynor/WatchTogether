// Shared constants and small helpers used across all extension contexts
// (content scripts, service worker, offscreen document, side panel, popup).
// Loaded as a plain classic script everywhere, so everything hangs off `self`.

(function (global) {
  const WT = {};

  // ---- Internal message types -------------------------------------------
  // Routed: content-script(video frame) <-> service worker <-> offscreen <-> peer <-> (mirror on the other browser)
  WT.MSG = {
    // --- Content frame -> background (per-tab video/frame bookkeeping) ---
    FRAME_HELLO: 'FRAME_HELLO', // a frame announces itself and whether it has a hostname match (e.g. netflix)
    VIDEO_STATUS: 'VIDEO_STATUS', // { status: 'found'|'none'|'lost', frameId }
    VIDEO_EVENT: 'VIDEO_EVENT', // local play/pause/seek/ratechange from the controlling frame, to be sent to peers
    HEARTBEAT_LOCAL: 'HEARTBEAT_LOCAL', // local heartbeat tick (currentTime/paused) from controlling frame
    REQUEST_PAGE_URL: 'REQUEST_PAGE_URL',
    PLAYER_SWITCHED: 'PLAYER_SWITCHED', // iframe src of the player changed (host switched "server")
    APPLY_REMOTE_ACTION: 'APPLY_REMOTE_ACTION', // background -> controlling frame: apply a remote play/pause/seek
    APPLY_REMOTE_HEARTBEAT: 'APPLY_REMOTE_HEARTBEAT', // background -> controlling frame: remote heartbeat for drift check
    SET_BUFFER_WAIT: 'SET_BUFFER_WAIT', // background -> frame: pause/resume because partner is buffering
    DURATION_INFO: 'DURATION_INFO', // frame -> background: duration of local video, for mismatch warnings
    DURATION_MISMATCH: 'DURATION_MISMATCH', // background -> top frame: show a warning overlay
    BUFFERING: 'BUFFERING', // frame -> background: this frame's video started/stopped buffering
    PICK_VIDEO_MODE: 'PICK_VIDEO_MODE', // top frame -> all frames: enter/exit "pick a video" highlight mode
    VIDEO_PICKED: 'VIDEO_PICKED', // a frame reports the user picked its video
    YOU_ARE_CONTROLLING: 'YOU_ARE_CONTROLLING', // background -> frame: you are now the chosen video frame
    STAND_DOWN: 'STAND_DOWN', // background -> frame: you are no longer the chosen video frame

    // --- Ready check (UI/content -> background -> content, relayed to peer) ---
    START_READY_CHECK: 'START_READY_CHECK',
    CANCEL_READY_CHECK: 'CANCEL_READY_CHECK',
    READY_CHECK: 'READY_CHECK', // background -> content: show the countdown (targetAt, initiatorName, self)
    READY_CHECK_CANCELLED: 'READY_CHECK_CANCELLED',

    // --- Voice chat (UI -> background -> offscreen, status relayed back) ---
    JOIN_VOICE: 'JOIN_VOICE',
    LEAVE_VOICE: 'LEAVE_VOICE',
    SET_VOICE_MUTED: 'SET_VOICE_MUTED',
    SET_VOICE_OUTPUT_DEVICE: 'SET_VOICE_OUTPUT_DEVICE', // UI -> background -> offscreen: live speaker swap, no rejoin needed
    VOICE_STATE: 'VOICE_STATE', // background -> UI: { joined, muted, connecting, error, peers: [{id,name,speaking,muted}] }
    VOICE_NEEDS_PERMISSION: 'VOICE_NEEDS_PERMISSION', // offscreen -> background -> background opens the mic-permission tab
    MIC_PERMISSION_GRANTED: 'MIC_PERMISSION_GRANTED', // mic-permission tab -> background -> offscreen: retry joining

    // --- Top-frame UI <-> background ---
    GET_PARTY_STATE: 'GET_PARTY_STATE',
    PARTY_STATE: 'PARTY_STATE', // background -> UI: current room/connection/video status snapshot
    START_PARTY: 'START_PARTY',
    JOIN_PARTY: 'JOIN_PARTY',
    LEAVE_PARTY: 'LEAVE_PARTY',
    OPEN_SAME_PAGE: 'OPEN_SAME_PAGE',
    SWITCH_TO_PLAYER_URL: 'SWITCH_TO_PLAYER_URL',

    // --- Chat / reactions (UI <-> background <-> offscreen <-> peer) ---
    SEND_CHAT: 'SEND_CHAT',
    CHAT_MESSAGE: 'CHAT_MESSAGE', // incoming chat message (local echo or remote), broadcast to UI + overlay
    SEND_REACTION: 'SEND_REACTION',
    REACTION: 'REACTION', // incoming reaction to animate (local echo or remote)
    SYSTEM_MESSAGE: 'SYSTEM_MESSAGE', // "X joined", "Y paused at 12:31" etc.

    // --- background <-> offscreen (PeerJS host) ---
    OFFSCREEN_READY: 'OFFSCREEN_READY',
    PEER_CREATE_HOST: 'PEER_CREATE_HOST',
    PEER_JOIN: 'PEER_JOIN',
    PEER_LEAVE: 'PEER_LEAVE',
    PEER_SEND: 'PEER_SEND', // background -> offscreen: send a payload to all connected peers
    PEER_INCOMING: 'PEER_INCOMING', // offscreen -> background: payload received from a peer
    PEER_STATUS: 'PEER_STATUS', // offscreen -> background: connection/room status changed
    PEER_ERROR: 'PEER_ERROR',

    GET_SETTINGS: 'GET_SETTINGS',
    SETTINGS_UPDATED: 'SETTINGS_UPDATED',

    PARTY_ENDED: 'PARTY_ENDED' // offscreen -> background: a definitive end (goodbye received, or reconnect attempts exhausted)
  };

  // Payload "kinds" exchanged over the actual peer data channel (wire protocol).
  WT.WIRE = {
    HELLO: 'hello', // { name, avatar, pageUrl, isHost }
    STATE_SNAPSHOT: 'state_snapshot', // host -> joiner on connect: full current state for late join
    VIDEO_ACTION: 'video_action', // { action: 'play'|'pause'|'seek'|'ratechange', time, rate, seq, originId }
    HEARTBEAT: 'heartbeat', // { time, paused, rate, sentAt, originId }
    BUFFERING: 'buffering', // { isBuffering, originId }
    DURATION: 'duration', // { duration, originId }
    PLAYER_SWITCHED: 'player_switched', // { url, originId }
    PICK_RESULT: 'pick_result',
    CHAT: 'chat', // { id, name, avatar, text, ts, originId }
    REACTION: 'reaction', // { emoji, name, ts, originId }
    SYSTEM: 'system', // { text, ts }
    PRESENCE: 'presence', // { peers: [{id,name,avatar}] }
    READY_CHECK: 'ready_check', // { targetAt, initiatorName, originId }
    READY_CHECK_CANCEL: 'ready_check_cancel', // { originId }
    VOICE_STATE: 'voice_state', // { inVoice, muted, originId } - mic join/leave/mute status, not the audio itself
    PEER_LEFT: 'peer_left' // { name, wasHost } - sent just before intentionally closing the connection
  };

  WT.STORAGE_KEYS = {
    PROFILE: 'wt_profile', // { name, avatar }
    REACTION_BAR: 'wt_reaction_bar', // array of emoji strings, up to 8
    RECENT_EMOJI: 'wt_recent_emoji', // array of emoji strings, most-recent-first, up to 16
    SETTINGS: 'wt_settings', // { turnUrl, turnUsername, turnCredential, autoPauseOnBuffer }
    ROOM: 'wt_room' // ephemeral-ish: last known room info, cleared on leave
  };

  WT.DEFAULT_REACTIONS = ['😂', '❤️', '😮', '😢', '🔥', '👏'];
  WT.MAX_REACTION_BAR = 8;
  WT.MAX_RECENT_EMOJI = 16;

  WT.DEFAULT_SETTINGS = {
    turnUrl: '',
    turnUsername: '',
    turnCredential: '',
    autoPauseOnBuffer: true,
    micDeviceId: '', // '' = system default. Applied next time voice chat is joined.
    speakerDeviceId: '' // '' = system default. Applied live via setSinkId(), where supported.
  };

  // Public PeerJS cloud signaling server (free tier) is used when no custom
  // config is given; passing nothing to `new Peer()` already defaults to it,
  // we only need to add STUN/TURN for the actual media/data path.
  WT.DEFAULT_ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];

  WT.DRIFT_THRESHOLD_SEC = 1.5;
  WT.HEARTBEAT_INTERVAL_MS = 2500;
  WT.ECHO_SUPPRESS_WINDOW_MS = 1200;
  WT.READY_CHECK_LEAD_MS = 3300; // "3, 2, 1, Go" - both sides count down to the same wall-clock target
  WT.PARTY_ENDED_RESET_DELAY_MS = 2500; // let the "party ended" message land before resetting to idle
  WT.RECONNECT_MAX_ATTEMPTS = 5;
  WT.RECONNECT_INTERVAL_MS = 3000;

  // ---- Connection quality, from the heartbeat RTT/2 latency estimate ----
  WT.LATENCY_BUCKETS = [
    { max: 150, key: 'excellent', label: 'Excellent', icon: '🟢' },
    { max: 300, key: 'good', label: 'Good', icon: '🟢' },
    { max: 600, key: 'fair', label: 'Fair', icon: '🟡' },
    { max: Infinity, key: 'poor', label: 'Poor', icon: '🔴' }
  ];

  WT.latencyInfo = function (ms) {
    if (ms == null || !isFinite(ms)) return null;
    const bucket = WT.LATENCY_BUCKETS.find((b) => ms < b.max) || WT.LATENCY_BUCKETS[WT.LATENCY_BUCKETS.length - 1];
    return { ms: Math.round(ms), key: bucket.key, label: bucket.label, icon: bucket.icon };
  };

  // ---- Room codes: "bright-panda-42" --------------------------------------
  const ADJECTIVES = [
    'bright', 'quiet', 'swift', 'calm', 'bold', 'lucky', 'gentle', 'brave',
    'cosmic', 'golden', 'silver', 'cozy', 'sunny', 'misty', 'jolly', 'mellow',
    'clever', 'breezy', 'amber', 'coral', 'dusty', 'electric', 'frosty', 'hazy'
  ];
  const ANIMALS = [
    'panda', 'otter', 'falcon', 'koala', 'tiger', 'rabbit', 'dolphin', 'fox',
    'owl', 'lynx', 'penguin', 'raccoon', 'heron', 'badger', 'gecko', 'puma',
    'sparrow', 'walrus', 'yak', 'wolf', 'crane', 'mantis', 'seal', 'moth'
  ];

  WT.generateRoomCode = function () {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
    const num = Math.floor(Math.random() * 90) + 10;
    return `${adj}-${animal}-${num}`;
  };

  WT.normalizeRoomCode = function (code) {
    return String(code || '').trim().toLowerCase().replace(/\s+/g, '-');
  };

  // ---- misc helpers --------------------------------------------------------
  WT.uid = function () {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  };

  WT.isNetflix = function (hostname) {
    return /(^|\.)netflix\.com$/i.test(hostname || '');
  };

  global.WT = WT;
})(typeof window !== 'undefined' ? window : self);
