const { MSG, STORAGE_KEYS, DEFAULT_SETTINGS, emojiStore } = WT;

const el = (id) => document.getElementById(id);
const headerStatus = el('header-status');
const emptyState = el('empty-state');
const chatArea = el('chat-area');
const messagesEl = el('messages');
const chatInput = el('chat-input');
const reactionBarEl = el('reaction-bar');
const barEditTools = el('bar-edit-tools');
const pickerPanel = el('picker-panel');
const pickerSearch = el('picker-search');
const pickerTabs = el('picker-tabs');
const pickerGrid = el('picker-grid');
const readyCheckBtn = el('ready-check-btn');
const voiceBtn = el('voice-btn');
const voiceMuteBtn = el('voice-mute-btn');
const voiceRoster = el('voice-roster');
const voiceSettingsBtn = el('voice-settings-btn');
const voiceDevicePanel = el('voice-device-panel');
const micSelect = el('mic-select');
const speakerSelect = el('speaker-select');
const speakerUnsupportedNote = el('speaker-unsupported-note');

let partyActive = false;
let editingBar = false;
let pickerMode = null; // 'reaction' | 'insert'
let reactionBar = [];
let readyCheckInFlight = false;
let voiceState = { joined: false, muted: false, connecting: false, peers: [] };
let deviceSettings = { micDeviceId: '', speakerDeviceId: '' };

function sendBg(message) {
  return chrome.runtime.sendMessage(Object.assign({ target: 'background' }, message));
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addMessage(kind, data) {
  const row = document.createElement('div');
  row.className = `msg msg-${kind}`;
  if (kind === 'chat') {
    row.innerHTML = `
      <div class="msg-head"><span class="msg-avatar">${escapeHtml(data.avatar || '🙂')}</span>
        <span class="msg-name">${escapeHtml(data.self ? 'You' : data.name)}</span>
        <span class="msg-time">${fmtTime(data.ts)}</span></div>
      <div class="msg-text">${escapeHtml(data.text)}</div>`;
  } else if (kind === 'system') {
    row.innerHTML = `<span class="msg-system-text">${escapeHtml(data.text)}</span>`;
  } else if (kind === 'reaction') {
    // data.emoji comes from the remote peer - never trust it as HTML.
    row.innerHTML = `<span class="msg-reaction-emoji">${escapeHtml(data.emoji)}</span><span class="msg-reaction-name">${escapeHtml(data.self ? 'You' : data.name)}</span>`;
  }
  messagesEl.appendChild(row);
  scrollToBottom();
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = String(s == null ? '' : s);
  return d.innerHTML;
}

function clearChat() {
  messagesEl.innerHTML = '';
}

function render(state) {
  partyActive = !!(state && state.active);
  emptyState.classList.toggle('hidden', partyActive);
  chatArea.classList.toggle('hidden', !partyActive);
  if (!partyActive) {
    clearChat();
    headerStatus.textContent = 'Not in a party';
    setReadyCheckInFlight(false);
    renderVoiceState({ joined: false, muted: false, connecting: false, peers: [] });
    return;
  }
  const partner = state.peers && state.peers[0];
  if (state.connectionStatus === 'connected' && partner) {
    const quality = WT.latencyInfo(state.latencyMs);
    const qualityText = quality ? ` · ${quality.icon} ${quality.ms}ms` : '';
    headerStatus.textContent = `🟢 ${partner.avatar || ''} ${partner.name}${qualityText}`.trim();
  } else if (state.connectionStatus === 'reconnecting') {
    headerStatus.textContent = '🟡 Reconnecting…';
  } else if (state.connectionStatus === 'ended') {
    headerStatus.textContent = '🔴 Party ended';
  } else {
    headerStatus.textContent = `🟡 Room ${state.roomCode || ''}`;
  }
  if (state.voice) renderVoiceState(state.voice);
}

// ---- reaction bar -------------------------------------------------------
async function loadReactionBar() {
  reactionBar = await emojiStore.getReactionBar();
  renderReactionBar();
}

function renderReactionBar() {
  reactionBarEl.innerHTML = '';
  reactionBar.forEach((emoji, idx) => {
    const btn = document.createElement('button');
    btn.className = 'bar-emoji';
    btn.textContent = emoji;
    btn.draggable = editingBar;
    btn.dataset.idx = idx;
    if (editingBar) {
      const rm = document.createElement('span');
      rm.className = 'bar-emoji-remove';
      rm.textContent = '×';
      rm.addEventListener('click', async (e) => {
        e.stopPropagation();
        reactionBar.splice(idx, 1);
        reactionBar = await emojiStore.setReactionBar(reactionBar);
        renderReactionBar();
      });
      btn.appendChild(rm);
      btn.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(idx)); });
      btn.addEventListener('dragover', (e) => e.preventDefault());
      btn.addEventListener('drop', async (e) => {
        e.preventDefault();
        const fromIdx = Number(e.dataTransfer.getData('text/plain'));
        const toIdx = idx;
        if (fromIdx === toIdx || Number.isNaN(fromIdx)) return;
        const [moved] = reactionBar.splice(fromIdx, 1);
        reactionBar.splice(toIdx, 0, moved);
        reactionBar = await emojiStore.setReactionBar(reactionBar);
        renderReactionBar();
      });
    } else {
      btn.addEventListener('click', () => sendReaction(emoji));
    }
    reactionBarEl.appendChild(btn);
  });
}

async function sendReaction(emoji) {
  if (!partyActive) return;
  await emojiStore.recordRecentEmoji(emoji);
  await sendBg({ type: MSG.SEND_REACTION, emoji });
}

el('edit-bar-btn').addEventListener('click', () => {
  editingBar = !editingBar;
  barEditTools.classList.toggle('hidden', !editingBar);
  renderReactionBar();
});

el('reset-bar-btn').addEventListener('click', async () => {
  reactionBar = await emojiStore.resetReactionBar();
  renderReactionBar();
});

// ---- emoji picker ---------------------------------------------------------
function openPicker(mode) {
  pickerMode = mode;
  pickerPanel.classList.remove('hidden');
  pickerSearch.value = '';
  renderPickerTabs();
  renderPickerGrid('');
  pickerSearch.focus();
}

function closePicker() {
  pickerPanel.classList.add('hidden');
  pickerMode = null;
}

el('add-emoji-btn').addEventListener('click', () => openPicker('reaction'));
el('insert-emoji-btn').addEventListener('click', () => openPicker('insert'));
el('picker-close').addEventListener('click', closePicker);

function renderPickerTabs() {
  pickerTabs.innerHTML = '';
  const allBtn = document.createElement('button');
  allBtn.className = 'picker-tab';
  allBtn.textContent = 'All';
  allBtn.addEventListener('click', () => scrollToGroup(null));
  pickerTabs.appendChild(allBtn);
  (WT.EMOJI_GROUPS || []).forEach((group) => {
    const btn = document.createElement('button');
    btn.className = 'picker-tab';
    btn.textContent = group.split(' ')[0];
    btn.title = group;
    btn.addEventListener('click', () => scrollToGroup(group));
    pickerTabs.appendChild(btn);
  });
}

function scrollToGroup(group) {
  if (!group) { pickerGrid.scrollTop = 0; return; }
  const header = pickerGrid.querySelector(`[data-group-header="${group}"]`);
  if (header) header.scrollIntoView({ block: 'start' });
}

async function renderPickerGrid(query) {
  const q = query.trim().toLowerCase();
  const recent = await emojiStore.getRecentEmoji();
  pickerGrid.innerHTML = '';

  if (!q && recent.length) {
    const header = document.createElement('div');
    header.className = 'picker-group-header';
    header.textContent = 'Recent';
    pickerGrid.appendChild(header);
    const row = document.createElement('div');
    row.className = 'picker-row';
    recent.forEach((emoji) => row.appendChild(makeEmojiCell({ e: emoji, n: '' })));
    pickerGrid.appendChild(row);
  }

  const data = (WT.EMOJI_DATA || []).filter((item) => !q || item.n.toLowerCase().includes(q));
  const groups = WT.EMOJI_GROUPS || [];
  let currentGroupIdx = -1;
  let row = null;
  data.forEach((item) => {
    if (item.g !== currentGroupIdx) {
      currentGroupIdx = item.g;
      const header = document.createElement('div');
      header.className = 'picker-group-header';
      header.dataset.groupHeader = groups[item.g] || '';
      header.textContent = groups[item.g] || 'Other';
      pickerGrid.appendChild(header);
      row = document.createElement('div');
      row.className = 'picker-row';
      pickerGrid.appendChild(row);
    }
    row.appendChild(makeEmojiCell(item));
  });

  if (!data.length && !(recent.length && !q)) {
    const empty = document.createElement('div');
    empty.className = 'picker-empty';
    empty.textContent = 'No emoji found';
    pickerGrid.appendChild(empty);
  }
}

function makeEmojiCell(item) {
  const cell = document.createElement('button');
  cell.className = 'picker-cell';
  cell.title = item.n;
  cell.textContent = item.e;
  cell.addEventListener('click', async () => {
    await emojiStore.recordRecentEmoji(item.e);
    if (pickerMode === 'insert') {
      insertAtCursor(chatInput, item.e);
      chatInput.focus();
    } else {
      sendReaction(item.e);
    }
    closePicker();
  });
  const pin = document.createElement('span');
  pin.className = 'picker-pin';
  pin.textContent = '+';
  pin.title = 'Add to reaction bar';
  pin.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (reactionBar.includes(item.e)) return;
    const next = reactionBar.concat([item.e]);
    reactionBar = await emojiStore.setReactionBar(next);
    renderReactionBar();
    pin.textContent = '✓';
  });
  cell.appendChild(pin);
  return cell;
}

function insertAtCursor(input, text) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  const newPos = start + text.length;
  input.setSelectionRange(newPos, newPos);
}

let searchDebounce = null;
pickerSearch.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => renderPickerGrid(pickerSearch.value), 120);
});

// ---- chat input -----------------------------------------------------------
// ---- ready check -----------------------------------------------------------
readyCheckBtn.addEventListener('click', async () => {
  if (!partyActive) return;
  if (readyCheckInFlight) {
    await sendBg({ type: MSG.CANCEL_READY_CHECK });
  } else {
    await sendBg({ type: MSG.START_READY_CHECK });
  }
});

function setReadyCheckInFlight(inFlight) {
  readyCheckInFlight = inFlight;
  readyCheckBtn.textContent = inFlight ? '✕ Cancel ready check' : '⏱ Ready check';
  readyCheckBtn.classList.toggle('active', inFlight);
}

// ---- voice chat --------------------------------------------------------------
voiceBtn.addEventListener('click', async () => {
  if (!partyActive) return;
  await sendBg({ type: voiceState.joined ? MSG.LEAVE_VOICE : MSG.JOIN_VOICE });
});

voiceMuteBtn.addEventListener('click', async () => {
  if (!voiceState.joined) return;
  await sendBg({ type: MSG.SET_VOICE_MUTED, muted: !voiceState.muted });
});

function renderVoiceState(state) {
  voiceState = Object.assign({ joined: false, muted: false, connecting: false, peers: [] }, state);
  voiceBtn.textContent = voiceState.connecting ? '🎙️ Connecting…' : voiceState.joined ? '🔴 Leave voice' : '🎙️ Join voice';
  voiceBtn.classList.toggle('active', voiceState.joined);
  voiceMuteBtn.classList.toggle('hidden', !voiceState.joined);
  if (voiceState.joined) voiceMuteBtn.textContent = voiceState.muted ? '🔇' : '🎤';

  voiceRoster.innerHTML = '';
  const showRoster = voiceState.joined && voiceState.peers && voiceState.peers.length;
  voiceRoster.classList.toggle('hidden', !showRoster);
  if (showRoster) {
    voiceState.peers.forEach((p) => {
      const chip = document.createElement('span');
      chip.className = 'voice-peer' + (p.speaking ? ' speaking' : '') + (p.muted ? ' voice-peer-muted' : '');
      chip.innerHTML = `<span class="voice-peer-avatar">${escapeHtml(p.avatar || '🙂')}</span><span>${escapeHtml(p.name || 'Partner')}${p.muted ? ' 🔇' : ''}</span>`;
      voiceRoster.appendChild(chip);
    });
  }
}

// ---- microphone / speaker device selection ---------------------------------
function supportsSinkId() {
  return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
}

async function loadDeviceSettings() {
  const got = await chrome.storage.sync.get(STORAGE_KEYS.SETTINGS);
  const settings = Object.assign({}, DEFAULT_SETTINGS, got[STORAGE_KEYS.SETTINGS] || {});
  deviceSettings = { micDeviceId: settings.micDeviceId || '', speakerDeviceId: settings.speakerDeviceId || '' };
}

async function saveDeviceSetting(key, value) {
  const got = await chrome.storage.sync.get(STORAGE_KEYS.SETTINGS);
  const settings = Object.assign({}, DEFAULT_SETTINGS, got[STORAGE_KEYS.SETTINGS] || {}, { [key]: value });
  await chrome.storage.sync.set({ [STORAGE_KEYS.SETTINGS]: settings });
  deviceSettings[key] = value;
}

async function refreshDeviceLists() {
  speakerUnsupportedNote.classList.toggle('hidden', supportsSinkId());
  speakerSelect.disabled = !supportsSinkId();

  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch (e) {
    return; // e.g. mic permission never granted yet - selects just stay at "System default"
  }

  fillDeviceSelect(micSelect, devices.filter((d) => d.kind === 'audioinput'), deviceSettings.micDeviceId, 'Microphone');
  if (supportsSinkId()) {
    fillDeviceSelect(speakerSelect, devices.filter((d) => d.kind === 'audiooutput'), deviceSettings.speakerDeviceId, 'Speaker');
  }
}

function fillDeviceSelect(selectEl, devices, selectedId, fallbackLabel) {
  selectEl.innerHTML = '';
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = 'System default';
  selectEl.appendChild(defaultOpt);
  devices.forEach((d, idx) => {
    if (!d.deviceId || d.deviceId === 'default' || d.deviceId === 'communications') return;
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `${fallbackLabel} ${idx + 1}`;
    selectEl.appendChild(opt);
  });
  // If the saved device is no longer present, this just falls back to "System default" visually.
  selectEl.value = devices.some((d) => d.deviceId === selectedId) ? selectedId : '';
}

voiceSettingsBtn.addEventListener('click', async () => {
  const opening = voiceDevicePanel.classList.contains('hidden');
  voiceDevicePanel.classList.toggle('hidden', !opening);
  voiceSettingsBtn.classList.toggle('active', opening);
  if (opening) await refreshDeviceLists();
});

micSelect.addEventListener('change', () => saveDeviceSetting('micDeviceId', micSelect.value));

speakerSelect.addEventListener('change', async () => {
  await saveDeviceSetting('speakerDeviceId', speakerSelect.value);
  if (voiceState.joined) await sendBg({ type: MSG.SET_VOICE_OUTPUT_DEVICE, deviceId: speakerSelect.value });
});

if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    if (!voiceDevicePanel.classList.contains('hidden')) refreshDeviceLists();
  });
}

async function sendChat() {
  const text = chatInput.value.trim();
  if (!text || !partyActive) return;
  await sendBg({ type: MSG.SEND_CHAT, text });
  chatInput.value = '';
}

el('send-btn').addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

// ---- incoming messages ------------------------------------------------------
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== 'ui') return;
  switch (msg.type) {
    case MSG.PARTY_STATE:
      render(msg.state);
      break;
    case MSG.CHAT_MESSAGE:
      addMessage('chat', msg.message);
      break;
    case MSG.SYSTEM_MESSAGE:
      addMessage('system', msg.message);
      break;
    case MSG.REACTION:
      addMessage('reaction', msg.message);
      break;
    case MSG.READY_CHECK:
      setReadyCheckInFlight(true);
      setTimeout(() => setReadyCheckInFlight(false), Math.max(0, msg.targetAt - Date.now()) + 800);
      break;
    case MSG.READY_CHECK_CANCELLED:
      setReadyCheckInFlight(false);
      break;
    case MSG.VOICE_STATE:
      renderVoiceState(msg);
      break;
    default:
      break;
  }
});

async function init() {
  await loadReactionBar();
  await loadDeviceSettings();
  const resp = await sendBg({ type: MSG.GET_PARTY_STATE }).catch(() => null);
  if (resp) render(resp.state);
}

init();
