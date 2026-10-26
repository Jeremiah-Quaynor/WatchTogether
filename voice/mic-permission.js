const btn = document.getElementById('allow-btn');
const statusEl = document.getElementById('status');

btn.addEventListener('click', async () => {
  btn.disabled = true;
  statusEl.className = '';
  statusEl.textContent = 'Requesting…';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // We only needed this call to record the permission grant for this
    // extension's origin - the offscreen document opens its own stream.
    stream.getTracks().forEach((t) => t.stop());
    statusEl.className = 'success';
    statusEl.textContent = "You're all set — this tab will close in a moment.";
    chrome.runtime.sendMessage({ target: 'background', type: WT.MSG.MIC_PERMISSION_GRANTED }).catch(() => {});
    setTimeout(() => window.close(), 1200);
  } catch (e) {
    btn.disabled = false;
    statusEl.className = 'error';
    statusEl.textContent = (e && e.name === 'NotAllowedError')
      ? "Microphone access was denied. You can allow it later from Chrome's site settings for this extension, then try again."
      : "Couldn't access your microphone. Check another app isn't already using it, then try again.";
  }
});
