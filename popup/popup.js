const { MSG, STORAGE_KEYS, DEFAULT_SETTINGS } = WT;

const el = (id) => document.getElementById(id);
const statusLine = el('status-line');
const netflixNote = el('netflix-note');
const idleSection = el('idle-section');
const activeSection = el('active-section');
const roomCodeEl = el('room-code');
const peersLine = el('peers-line');
const openSamePageBtn = el('open-same-page-btn');
const nameInput = el('name-input');
const avatarInput = el('avatar-input');
const toast = el('toast');

function showToast(text) {
  toast.textContent = text;
  setTimeout(() => { if (toast.textContent === text) toast.textContent = ''; }, 4000);
}

function sendBg(message) {
  return chrome.runtime.sendMessage(Object.assign({ target: 'background' }, message));
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function render(state) {
  if (!state) return;
  if (state.active) {
    idleSection.classList.add('hidden');
    activeSection.classList.remove('hidden');
    roomCodeEl.textContent = state.roomCode || '—';
    const partner = state.peers && state.peers[0];
    if (state.connectionStatus === 'connected' && partner) {
      const quality = WT.latencyInfo(state.latencyMs);
      const qualityText = quality ? ` · ${quality.icon} ${quality.label} (${quality.ms}ms)` : '';
      peersLine.textContent = `🟢 Connected with ${partner.avatar || ''} ${partner.name}${qualityText}`.trim();
      statusLine.textContent = 'Watching together';
    } else if (state.connectionStatus === 'reconnecting') {
      peersLine.textContent = '🟡 Reconnecting…';
      statusLine.textContent = 'Reconnecting…';
    } else if (state.connectionStatus === 'ended') {
      peersLine.textContent = '🔴 Party ended';
      statusLine.textContent = 'Party ended';
    } else {
      peersLine.textContent = state.isHost ? 'Waiting for your partner to join…' : 'Connecting to host…';
      statusLine.textContent = 'Connecting…';
    }
    openSamePageBtn.classList.toggle('hidden', !(!state.isHost && state.hostPageUrl));
  } else {
    idleSection.classList.remove('hidden');
    activeSection.classList.add('hidden');
    statusLine.textContent = 'Not in a party';
  }
}

async function init() {
  const profileGot = await chrome.storage.sync.get(STORAGE_KEYS.PROFILE);
  const profile = profileGot[STORAGE_KEYS.PROFILE] || { name: '', avatar: '🙂' };
  nameInput.value = profile.name || '';
  avatarInput.value = profile.avatar || '🙂';

  const settingsGot = await chrome.storage.sync.get(STORAGE_KEYS.SETTINGS);
  const settings = Object.assign({}, DEFAULT_SETTINGS, settingsGot[STORAGE_KEYS.SETTINGS] || {});
  el('auto-pause-toggle').checked = settings.autoPauseOnBuffer;
  el('turn-url').value = settings.turnUrl || '';
  el('turn-username').value = settings.turnUsername || '';
  el('turn-credential').value = settings.turnCredential || '';

  const tab = await getActiveTab();
  if (tab && tab.url && /^https?:\/\/([^/]+\.)?netflix\.com\//i.test(tab.url)) {
    netflixNote.classList.remove('hidden');
  }

  const resp = await sendBg({ type: MSG.GET_PARTY_STATE }).catch(() => null);
  if (resp) render(resp.state);
}

async function saveProfile() {
  const profile = { name: nameInput.value.trim() || 'Guest', avatar: avatarInput.value.trim() || '🙂' };
  await chrome.storage.sync.set({ [STORAGE_KEYS.PROFILE]: profile });
}

nameInput.addEventListener('change', saveProfile);
avatarInput.addEventListener('change', saveProfile);

el('start-btn').addEventListener('click', async () => {
  await saveProfile();
  const tab = await getActiveTab();
  if (!tab) return;
  await sendBg({ type: MSG.START_PARTY, tabId: tab.id });
});

el('join-btn').addEventListener('click', async () => {
  const code = el('join-code').value.trim();
  if (!code) { showToast('Enter a room code first'); return; }
  await saveProfile();
  const tab = await getActiveTab();
  if (!tab) return;
  await sendBg({ type: MSG.JOIN_PARTY, tabId: tab.id, code });
});

el('leave-btn').addEventListener('click', async () => {
  await sendBg({ type: MSG.LEAVE_PARTY });
});

el('copy-code-btn').addEventListener('click', async () => {
  const code = roomCodeEl.textContent;
  if (!code || code === '—') return;
  await navigator.clipboard.writeText(code);
  showToast('Room code copied');
});

openSamePageBtn.addEventListener('click', async () => {
  await sendBg({ type: MSG.OPEN_SAME_PAGE });
});

el('settings-toggle').addEventListener('click', () => {
  el('settings-body').classList.toggle('hidden');
});

el('save-settings-btn').addEventListener('click', async () => {
  const settings = {
    autoPauseOnBuffer: el('auto-pause-toggle').checked,
    turnUrl: el('turn-url').value.trim(),
    turnUsername: el('turn-username').value.trim(),
    turnCredential: el('turn-credential').value.trim()
  };
  await chrome.storage.sync.set({ [STORAGE_KEYS.SETTINGS]: settings });
  await sendBg({ type: MSG.SETTINGS_UPDATED, autoPauseOnBuffer: settings.autoPauseOnBuffer });
  showToast('Settings saved');
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.target === 'ui' && msg.type === MSG.PARTY_STATE) {
    render(msg.state);
  }
});

init();
