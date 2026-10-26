// Finds and scores <video> elements in THIS frame's document, including
// ones inside open shadow roots, ones added later (SPA navigation, players
// that swap their <video> element), and reports the best candidate.
// Classic script - exposes window.WT.VideoDetector.

(function (global) {
  function queryAllVideosDeep(root, out) {
    try {
      root.querySelectorAll('video').forEach((v) => out.push(v));
      root.querySelectorAll('*').forEach((el) => {
        if (el.shadowRoot) queryAllVideosDeep(el.shadowRoot, out);
      });
    } catch (e) { /* detached or inaccessible node, ignore */ }
  }

  function scoreVideo(video) {
    if (!video.isConnected) return -1;
    let rect;
    try { rect = video.getBoundingClientRect(); } catch (e) { return -1; }
    const area = Math.max(0, rect.width) * Math.max(0, rect.height);
    if (area < 400) return -1; // essentially invisible (e.g. 1x1 tracking videos)
    let s = Math.min(area, 1920 * 1080) / 10000;
    if (!video.paused && !video.ended) s += 500;
    if (video.duration && isFinite(video.duration) && video.duration > 0) s += 100;
    if (video.currentTime > 0.25) s += 20;
    if (video.muted) s -= 15;
    if (video.hasAttribute('data-wt-ignore')) s -= 100000;
    return s;
  }

  class VideoDetector {
    constructor() {
      this.tracked = new Set();
      this.chosen = null;
      this.lastStatus = null;
      this.onChange = null;
      this._rescanTimer = null;
      this._debounceTimer = null;
      this._boundEvents = new WeakMap();
      this._pickMode = false;
      this._pickOverlays = [];
      this._onPick = null;
    }

    start(onChange) {
      this.onChange = onChange;
      this._observer = new MutationObserver(() => this._scheduleRescan(250));
      this._observer.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['src']
      });
      this._rescanTimer = setInterval(() => this._rescan(), 1500);
      this._rescan();
    }

    stop() {
      if (this._observer) this._observer.disconnect();
      if (this._rescanTimer) clearInterval(this._rescanTimer);
      if (this._debounceTimer) clearTimeout(this._debounceTimer);
    }

    _scheduleRescan(delay) {
      if (this._debounceTimer) clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(() => this._rescan(), delay);
    }

    _trackVideo(video) {
      if (this.tracked.has(video)) return;
      this.tracked.add(video);
      const handler = () => this._scheduleRescan(50);
      ['play', 'pause', 'loadedmetadata', 'emptied', 'durationchange'].forEach((ev) => video.addEventListener(ev, handler));
      this._boundEvents.set(video, handler);
    }

    _untrackVideo(video) {
      const handler = this._boundEvents.get(video);
      if (handler) {
        ['play', 'pause', 'loadedmetadata', 'emptied', 'durationchange'].forEach((ev) => video.removeEventListener(ev, handler));
      }
      this.tracked.delete(video);
      this._boundEvents.delete(video);
    }

    listAll() {
      const found = [];
      queryAllVideosDeep(document, found);
      return found;
    }

    _rescan() {
      const found = this.listAll();
      const foundSet = new Set(found);

      for (const v of this.tracked) {
        if (!foundSet.has(v)) this._untrackVideo(v);
      }
      for (const v of found) {
        if (!this.tracked.has(v)) this._trackVideo(v);
      }

      if (this._forcedChoice && this.tracked.has(this._forcedChoice)) {
        this._selectChosen(this._forcedChoice);
        return;
      }
      if (this._forcedChoice && !this.tracked.has(this._forcedChoice)) {
        this._forcedChoice = null; // the forced pick disappeared, fall back to auto
      }

      let best = null;
      let bestScore = -Infinity;
      for (const v of this.tracked) {
        const s = scoreVideo(v);
        if (s > bestScore) { bestScore = s; best = v; }
      }
      this._bestScore = bestScore;
      this._selectChosen(bestScore > 0 ? best : null);
    }

    _selectChosen(video) {
      if (video === this.chosen) {
        // still report periodic "found" with updated score so background keeps fresh scores
        if (video && this.onChange) this.onChange('found', video, this._bestScore || 0);
        return;
      }
      const hadChosen = !!this.chosen;
      this.chosen = video;
      if (!video) {
        if (this.onChange) this.onChange(hadChosen ? 'lost' : 'none', null, 0);
      } else {
        if (this.onChange) this.onChange('found', video, this._bestScore || 0);
      }
    }

    pickVideo(video) {
      this._forcedChoice = video;
      this._selectChosen(video);
    }

    enterPickMode(onPick) {
      this._pickMode = true;
      this._onPick = onPick;
      this._renderPickOverlays();
    }

    exitPickMode() {
      this._pickMode = false;
      this._clearPickOverlays();
    }

    _renderPickOverlays() {
      this._clearPickOverlays();
      const candidates = this.listAll().filter((v) => {
        try { const r = v.getBoundingClientRect(); return r.width > 20 && r.height > 20; } catch (e) { return false; }
      });
      candidates.forEach((video, idx) => {
        const rect = video.getBoundingClientRect();
        const box = document.createElement('div');
        box.className = 'wt-pick-overlay';
        box.style.left = rect.left + 'px';
        box.style.top = rect.top + 'px';
        box.style.width = rect.width + 'px';
        box.style.height = rect.height + 'px';
        box.innerHTML = `<span class="wt-pick-label">Video ${idx + 1} - click to use</span>`;
        box.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.pickVideo(video);
          if (this._onPick) this._onPick(video);
          this.exitPickMode();
        });
        document.body.appendChild(box);
        this._pickOverlays.push(box);
      });
    }

    _clearPickOverlays() {
      this._pickOverlays.forEach((el) => el.remove());
      this._pickOverlays = [];
    }
  }

  global.WT = global.WT || {};
  global.WT.VideoDetector = VideoDetector;
})(window);
