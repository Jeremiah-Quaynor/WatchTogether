// All on-page UI: the status badge, netflix/duration/player-switch banners,
// floating reactions over the video, and the compact fullscreen bar (quick
// reactions + mini chat) that stands in for the side panel when fullscreen
// hides it. Classic script, runs in every frame.

(function (global) {
  const WT = global.WT;

  class Overlay {
    constructor({ isTop, onReaction, onChat, onPickClick, onSwitchClick, onReadyCheck, onCancelReadyCheck, onToggleVoice, onToggleMute }) {
      this.isTop = isTop;
      this.onReaction = onReaction || function () {};
      this.onChat = onChat || function () {};
      this.onPickClick = onPickClick || function () {};
      this.onSwitchClick = onSwitchClick || function () {};
      this.onReadyCheck = onReadyCheck || function () {};
      this.onCancelReadyCheck = onCancelReadyCheck || function () {};
      this.onToggleVoice = onToggleVoice || function () {};
      this.onToggleMute = onToggleMute || function () {};
      this.video = null;
      this._root = null;
      this._readyCheckTimer = null;
      this._readyCheckFired = false;
      this._build();
      document.addEventListener('fullscreenchange', () => this._onFullscreenChange());
    }

    _el(tag, className, parent) {
      const e = document.createElement(tag);
      if (className) e.className = className;
      if (parent) parent.appendChild(e);
      return e;
    }

    _build() {
      const root = this._el('div', 'wt-root');
      root.setAttribute('data-wt-ignore', '1');
      this._root = root;

      this.reactionsLayer = this._el('div', 'wt-reactions-layer', root);
      this.readyCheckLayer = this._el('div', 'wt-readycheck-layer', root);

      if (this.isTop) {
        this.statusBadge = this._el('div', 'wt-status-badge wt-hidden', root);
        this.statusIcon = this._el('span', 'wt-status-icon', this.statusBadge);
        this.statusText = this._el('span', 'wt-status-text', this.statusBadge);
        this.partyLine = this._el('div', 'wt-party-line', this.statusBadge);
        this.pickLink = this._el('button', 'wt-pick-link', this.statusBadge);
        this.pickLink.textContent = 'Pick a different video';
        this.pickLink.addEventListener('click', () => this.onPickClick());

        this.toastStack = this._el('div', 'wt-toast-stack', root);
      }

      this.fsBar = this._el('div', 'wt-fs-bar wt-hidden', root);
      this._fsCollapsed = false;
      this._buildFsBar();
      this.fsCollapsedBtn = this._el('div', 'wt-fs-collapsed wt-hidden', root);
      this.fsCollapsedBtn.textContent = '💬';
      this.fsCollapsedBtn.title = 'Open WatchTogether';
      this.fsCollapsedBtn.addEventListener('click', () => this._setFsCollapsed(false));

      document.documentElement.appendChild(root);
    }

    _setFsCollapsed(collapsed) {
      this._fsCollapsed = collapsed;
      if (!this._inFullscreen) return;
      this.fsBar.classList.toggle('wt-hidden', collapsed);
      this.fsCollapsedBtn.classList.toggle('wt-hidden', !collapsed);
    }

    _buildFsBar() {
      const bar = this.fsBar;
      const header = this._el('div', 'wt-fs-header', bar);
      const label = this._el('span', 'wt-fs-header-label', header);
      label.textContent = 'WatchTogether';
      const minimizeBtn = this._el('button', 'wt-fs-minimize', header);
      minimizeBtn.textContent = '—';
      minimizeBtn.title = 'Minimize (reactions still float over the video)';
      minimizeBtn.addEventListener('click', () => this._setFsCollapsed(true));

      this.fsToolsRow = this._el('div', 'wt-fs-tools', bar);
      this.fsReadyCheckBtn = this._el('button', 'wt-fs-tool-btn', this.fsToolsRow);
      this.fsReadyCheckBtn.textContent = '⏱ Ready check';
      this.fsReadyCheckBtn.addEventListener('click', () => this.onReadyCheck());
      this.fsVoiceBtn = this._el('button', 'wt-fs-tool-btn', this.fsToolsRow);
      this.fsVoiceBtn.textContent = '🎙️ Join voice';
      this.fsVoiceBtn.addEventListener('click', () => this.onToggleVoice());
      this.fsMuteBtn = this._el('button', 'wt-fs-tool-btn wt-hidden', this.fsToolsRow);
      this.fsMuteBtn.textContent = '🎤';
      this.fsMuteBtn.addEventListener('click', () => this.onToggleMute());

      this.fsReactionRow = this._el('div', 'wt-fs-reactions', bar);
      this.fsRecentRow = this._el('div', 'wt-fs-recent', bar);
      const inputRow = this._el('div', 'wt-fs-input-row', bar);
      this.fsInput = this._el('input', 'wt-fs-input', inputRow);
      this.fsInput.type = 'text';
      this.fsInput.placeholder = 'Send a message…';
      this.fsSend = this._el('button', 'wt-fs-send', inputRow);
      this.fsSend.textContent = 'Send';
      const send = () => {
        const text = this.fsInput.value.trim();
        if (!text) return;
        this.onChat(text);
        this.fsInput.value = '';
      };
      this.fsSend.addEventListener('click', send);
      this.fsInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
      this.fsToasts = this._el('div', 'wt-fs-toasts', bar);

      this.refreshFsReactions();
    }

    async refreshFsReactions() {
      if (!WT.emojiStore) return;
      const [bar, recent] = await Promise.all([WT.emojiStore.getReactionBar(), WT.emojiStore.getRecentEmoji()]);
      this.fsReactionRow.innerHTML = '';
      bar.forEach((emoji) => {
        const btn = this._el('button', 'wt-fs-emoji-btn', this.fsReactionRow);
        btn.textContent = emoji;
        btn.addEventListener('click', () => this.onReaction(emoji));
      });
      this.fsRecentRow.innerHTML = '';
      if (recent.length) {
        const label = this._el('span', 'wt-fs-recent-label', this.fsRecentRow);
        label.textContent = 'Recent:';
        recent.slice(0, 8).forEach((emoji) => {
          const btn = this._el('button', 'wt-fs-emoji-btn wt-fs-emoji-small', this.fsRecentRow);
          btn.textContent = emoji;
          btn.addEventListener('click', () => this.onReaction(emoji));
        });
      }
    }

    _onFullscreenChange() {
      const fsEl = document.fullscreenElement;
      if (fsEl) {
        fsEl.appendChild(this._root);
        this._inFullscreen = true;
        this.fsBar.classList.toggle('wt-hidden', this._fsCollapsed);
        this.fsCollapsedBtn.classList.toggle('wt-hidden', !this._fsCollapsed);
      } else {
        document.documentElement.appendChild(this._root);
        this._inFullscreen = false;
        this.fsBar.classList.add('wt-hidden');
        this.fsCollapsedBtn.classList.add('wt-hidden');
      }
    }

    setVideoElement(video) {
      this.video = video;
    }

    // --- status badge (top frame only) ---
    setStatus(status) {
      if (!this.statusBadge) return;
      this.statusBadge.classList.remove('wt-hidden');
      const map = {
        none: { icon: '🔍', text: 'No video yet — press play once' },
        found: { icon: '✅', text: 'Video found' },
        lost: { icon: '♻️', text: 'Video lost — reattaching…' }
      };
      const info = map[status] || map.none;
      this.statusIcon.textContent = info.icon;
      this.statusText.textContent = info.text;
      this.pickLink.style.display = status === 'none' ? 'none' : 'block';
    }

    hideStatus() {
      if (this.statusBadge) this.statusBadge.classList.add('wt-hidden');
    }

    setPartyLine(text, kind) {
      if (!this.partyLine) return;
      this.partyLine.textContent = text || '';
      this.partyLine.className = 'wt-party-line' + (kind ? ` wt-party-${kind}` : '');
    }

    // --- banners / toasts (top frame only) ---
    showNetflixBanner() {
      if (!this.toastStack) return;
      const box = this._el('div', 'wt-banner wt-banner-netflix', this.toastStack);
      box.innerHTML = `<span>WatchTogether doesn't sync Netflix — use Teleparty for that.</span>`;
      const close = this._el('button', 'wt-banner-close', box);
      close.textContent = '×';
      close.addEventListener('click', () => box.remove());
    }

    showDurationMismatch(local, remote) {
      if (!this.toastStack) return;
      const box = this._el('div', 'wt-banner wt-banner-warning', this.toastStack);
      box.innerHTML = `<span>Your video (${WT.formatTime(local)}) and your partner's (${WT.formatTime(remote)}) have different lengths — could be an ad, or a different version.</span>`;
      const close = this._el('button', 'wt-banner-close', box);
      close.textContent = '×';
      close.addEventListener('click', () => box.remove());
      setTimeout(() => box.remove(), 10000);
    }

    showPlayerSwitchPrompt(url) {
      if (!this.toastStack) return;
      const box = this._el('div', 'wt-banner wt-banner-info', this.toastStack);
      const label = this._el('span', null, box);
      label.textContent = 'Your partner switched players.';
      const btn = this._el('button', 'wt-banner-action', box);
      btn.textContent = 'Switch too';
      btn.addEventListener('click', () => { this.onSwitchClick(url); box.remove(); });
      const close = this._el('button', 'wt-banner-close', box);
      close.textContent = '×';
      close.addEventListener('click', () => box.remove());
    }

    // --- ready-check countdown (whichever frame holds the video) ---
    showReadyCheck(targetAt, initiatorName, isSelf, onZero) {
      this.hideReadyCheck();
      this._readyCheckFired = false;

      const box = this._el('div', 'wt-readycheck', this.readyCheckLayer);
      this._positionOverVideo(box);
      const label = this._el('div', 'wt-readycheck-label', box);
      label.textContent = isSelf ? 'Get ready…' : `${initiatorName} started a ready check…`;
      const number = this._el('div', 'wt-readycheck-number', box);
      const cancelBtn = this._el('button', 'wt-readycheck-cancel', box);
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => this.onCancelReadyCheck());
      this._readyCheckBox = box;

      const tick = () => {
        const msLeft = targetAt - Date.now();
        if (msLeft <= 0) {
          number.textContent = 'Go!';
          if (!this._readyCheckFired) {
            this._readyCheckFired = true;
            onZero();
          }
          this._readyCheckTimer = setTimeout(() => this.hideReadyCheck(), 700);
          return;
        }
        number.textContent = String(Math.ceil(msLeft / 1000));
        this._readyCheckTimer = setTimeout(tick, 100);
      };
      tick();
    }

    hideReadyCheck() {
      if (this._readyCheckTimer) clearTimeout(this._readyCheckTimer);
      this._readyCheckTimer = null;
      if (this._readyCheckBox) { this._readyCheckBox.remove(); this._readyCheckBox = null; }
    }

    _positionOverVideo(el) {
      let rect = { left: window.innerWidth / 2 - 120, top: window.innerHeight / 2 - 80, width: 240, height: 160 };
      if (this.video && this.video.isConnected) {
        try { rect = this.video.getBoundingClientRect(); } catch (e) { /* ignore */ }
      }
      el.style.left = rect.left + 'px';
      el.style.top = rect.top + 'px';
      el.style.width = rect.width + 'px';
      el.style.height = rect.height + 'px';
    }

    // --- voice chat controls (fullscreen bar) ---
    setVoiceState({ joined, muted, connecting }) {
      if (!this.fsVoiceBtn) return;
      this.fsVoiceBtn.textContent = connecting ? '🎙️ Connecting…' : joined ? '🔴 Leave voice' : '🎙️ Join voice';
      this.fsMuteBtn.classList.toggle('wt-hidden', !joined);
      if (joined) this.fsMuteBtn.textContent = muted ? '🔇' : '🎤';
    }

    // --- floating reactions (any frame) ---
    spawnReaction(emoji, name) {
      let rect = { left: window.innerWidth / 2 - 100, top: window.innerHeight * 0.6, width: 200, height: 200 };
      if (this.video && this.video.isConnected) {
        try { rect = this.video.getBoundingClientRect(); } catch (e) { /* ignore */ }
      }
      const wrap = this._el('div', 'wt-reaction-float', this.reactionsLayer);
      const jitterX = rect.left + rect.width * (0.25 + Math.random() * 0.5);
      const bottomY = rect.top + rect.height * 0.75;
      wrap.style.left = jitterX + 'px';
      wrap.style.top = bottomY + 'px';
      // emoji/name come from the remote peer - never trust them as HTML.
      const emojiSpan = this._el('span', 'wt-reaction-emoji', wrap);
      emojiSpan.textContent = String(emoji == null ? '' : emoji).slice(0, 8);
      if (name) {
        const nameSpan = this._el('span', 'wt-reaction-name', wrap);
        nameSpan.textContent = name;
      }
      wrap.addEventListener('animationend', () => wrap.remove());
      // Fallback removal in case animationend doesn't fire (e.g. tab backgrounded).
      setTimeout(() => wrap.remove(), 4000);
    }

    // --- chat toast, fullscreen only ---
    showChatToast(name, text) {
      if (!this._inFullscreen) return;
      const box = this._el('div', 'wt-fs-toast', this.fsToasts);
      box.innerHTML = `<span class="wt-fs-toast-name">${escapeHtml(name)}</span><span class="wt-fs-toast-text">${escapeHtml(text)}</span>`;
      setTimeout(() => box.remove(), 6000);
    }
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = String(s == null ? '' : s);
    return div.innerHTML;
  }

  global.WT.Overlay = Overlay;
})(window);
