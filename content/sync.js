// Drives play/pause/seek/rate sync for the single <video> element this
// frame currently controls. Handles echo suppression, heartbeat-based
// drift correction, and the buffering gate. Classic script.

(function (global) {
  function formatTime(seconds) {
    seconds = Math.max(0, Math.floor(seconds || 0));
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  class VideoSync {
    constructor(sendToBackground) {
      this.send = sendToBackground;
      this.video = null;
      this.active = false; // true once this frame is the chosen controller
      this.partyActive = false; // true once a party is connected
      this.ignoreEventsUntil = 0;
      this.lastCorrectionAt = 0;
      this.heartbeatTimer = null;
      this.isBuffering = false;
      this.bufferGateActive = false;
      this._wasPlayingBeforeGate = false;
      this._handlers = null;
      this._lastRemoteAppliedTime = null;
      this._lastRemoteAppliedAt = 0;
    }

    attach(video) {
      if (this.video === video) return;
      this.detach();
      this.video = video;
      const h = {
        play: () => this._onLocal('play'),
        pause: () => this._onLocal('pause'),
        seeked: () => this._onLocal('seek'),
        ratechange: () => this._onLocal('ratechange'),
        waiting: () => this._onWaiting(),
        playing: () => this._onPlaying(),
        canplay: () => this._onPlaying(),
        durationchange: () => this._onDuration()
      };
      Object.keys(h).forEach((ev) => video.addEventListener(ev, h[ev]));
      this._handlers = h;
      this._onDuration();
    }

    detach() {
      if (this.video && this._handlers) {
        Object.keys(this._handlers).forEach((ev) => this.video.removeEventListener(ev, this._handlers[ev]));
      }
      this.video = null;
      this._handlers = null;
      this._stopHeartbeat();
    }

    setControlling(isControlling) {
      this.active = isControlling;
      if (isControlling && this.partyActive) this._startHeartbeat();
      else this._stopHeartbeat();
    }

    setPartyActive(isPartyActive) {
      this.partyActive = isPartyActive;
      if (isPartyActive && this.active) this._startHeartbeat();
      else this._stopHeartbeat();
    }

    _startHeartbeat() {
      if (this.heartbeatTimer) return;
      this.heartbeatTimer = setInterval(() => {
        if (!this.video) return;
        this.send({
          type: 'HEARTBEAT_LOCAL',
          time: this.video.currentTime,
          paused: this.video.paused,
          rate: this.video.playbackRate
        });
      }, (global.WT.HEARTBEAT_INTERVAL_MS || 2500));
    }

    _stopHeartbeat() {
      if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    }

    _suppressed() {
      return Date.now() < this.ignoreEventsUntil;
    }

    _beginSuppress() {
      this.ignoreEventsUntil = Date.now() + (global.WT.ECHO_SUPPRESS_WINDOW_MS || 1200);
    }

    _onLocal(kind) {
      if (!this.active || !this.partyActive || !this.video) return;
      if (this._suppressed()) return;
      if (this.bufferGateActive) return; // our own pause/play from the buffer gate, not a real user action
      const video = this.video;
      // A slow/buffering seek can fire its native "seeked" event after the
      // suppression window above has already expired. Catch that case by
      // value too: if this looks like the correction we just applied
      // ourselves, it's an echo, not a new user action.
      if (kind === 'seek' && this._lastRemoteAppliedTime != null
          && Date.now() - this._lastRemoteAppliedAt < 5000
          && Math.abs(video.currentTime - this._lastRemoteAppliedTime) < 0.5) {
        return;
      }
      let label = null;
      let action = kind;
      if (kind === 'play') label = 'resumed';
      else if (kind === 'pause') label = `paused at ${formatTime(video.currentTime)}`;
      else if (kind === 'seek') label = `jumped to ${formatTime(video.currentTime)}`;
      this.send({ type: 'VIDEO_EVENT', action, time: video.currentTime, rate: video.playbackRate, label });
    }

    _onWaiting() {
      if (!this.active || !this.partyActive || this.isBuffering) return;
      this.isBuffering = true;
      this.send({ type: 'BUFFERING', isBuffering: true });
    }

    _onPlaying() {
      if (!this.active || !this.partyActive || !this.isBuffering) return;
      this.isBuffering = false;
      this.send({ type: 'BUFFERING', isBuffering: false });
    }

    _onDuration() {
      if (!this.active || !this.video || !isFinite(this.video.duration) || !this.video.duration) return;
      this.send({ type: 'DURATION_INFO', duration: this.video.duration });
    }

    applyRemoteAction({ action, time, rate, thenPlay, label }) {
      if (!this.video) return;
      this._beginSuppress();
      const video = this.video;
      try {
        if (typeof time === 'number' && isFinite(time) && Math.abs(video.currentTime - time) > 0.4) {
          video.currentTime = Math.max(0, time);
          this._lastRemoteAppliedTime = time;
          this._lastRemoteAppliedAt = Date.now();
        }
        if (typeof rate === 'number' && rate > 0 && rate !== video.playbackRate) {
          video.playbackRate = rate;
        }
      } catch (e) { /* ignore */ }
      if (action === 'play' || thenPlay === true) {
        video.play().catch(() => {});
      } else if (action === 'pause' || thenPlay === false) {
        video.pause();
      }
    }

    applyRemoteHeartbeat({ time, paused, rate, latencyMs, driftThreshold }) {
      if (!this.video || this.bufferGateActive) return;
      const now = Date.now();
      let estRemoteTime = time;
      if (!paused) estRemoteTime += (latencyMs || 0) / 1000;

      if (paused !== this.video.paused) {
        this._beginSuppress();
        if (paused) this.video.pause();
        else this.video.play().catch(() => {});
      }

      if (now - this.lastCorrectionAt < 3000) return; // cooldown, avoid correction loops
      const drift = Math.abs(this.video.currentTime - estRemoteTime);
      if (drift > (driftThreshold || 1.5)) {
        this._beginSuppress();
        try {
          this.video.currentTime = Math.max(0, estRemoteTime);
          this._lastRemoteAppliedTime = estRemoteTime;
          this._lastRemoteAppliedAt = now;
        } catch (e) { /* ignore */ }
        if (typeof rate === 'number' && rate > 0) {
          try { this.video.playbackRate = rate; } catch (e) { /* ignore */ }
        }
        this.lastCorrectionAt = now;
      }
    }

    // Called when a ready-check countdown hits zero. This is a genuine local
    // play, not a remote-applied one, so it's deliberately NOT suppressed:
    // the resulting native 'play' event flows through _onLocal() exactly
    // like a user clicking play, and gets broadcast to the peer normally.
    playNow() {
      if (!this.video) return;
      this.video.play().catch(() => {});
    }

    setBufferGate(wait) {
      if (!this.video) return;
      if (wait && !this.bufferGateActive) {
        this.bufferGateActive = true;
        this._wasPlayingBeforeGate = !this.video.paused;
        this._beginSuppress();
        this.video.pause();
      } else if (!wait && this.bufferGateActive) {
        this.bufferGateActive = false;
        if (this._wasPlayingBeforeGate) {
          this._beginSuppress();
          this.video.play().catch(() => {});
        }
      }
    }
  }

  global.WT = global.WT || {};
  global.WT.VideoSync = VideoSync;
  global.WT.formatTime = formatTime;
})(window);
