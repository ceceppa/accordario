import { t } from "./i18n.js";
// Playback transport: one clock for the whole app.
//
// Two modes:
//  - "video": the YouTube player is the clock and plays the audio.
//  - "audio": a local <audio> element is the clock (stems or original audio,
//    routed through Web Audio); the YouTube video is muted and follows it.

let ytApiPromise = null;

function loadYouTubeApi() {
  if (!ytApiPromise) {
    ytApiPromise = new Promise((resolve) => {
      if (window.YT?.Player) return resolve(window.YT);
      window.onYouTubeIframeAPIReady = () => resolve(window.YT);
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      document.head.append(script);
    });
  }
  return ytApiPromise;
}

const SEEK_SETTLE_MS = 1200;

export class Transport extends EventTarget {
  constructor(playerElementId) {
    super();
    this.playerElementId = playerElementId;
    this.player = null;
    this.ytState = -1;
    this.ytReady = false;
    this.mode = "video";
    this.videoEnabled = true; // false when the video can't be embedded
    this.rate = 1;
    this.loop = null; // {start, end} in seconds
    this.pendingSeek = null;
    this.lastLoopJump = 0;
    this.lastVideoResync = 0;
    this.clock = { reported: 0, at: 0 };

    // Audio engine (created lazily: AudioContext needs a user gesture).
    this.audio = new Audio();
    this.audio.preload = "auto";
    this.audio.preservesPitch = true;
    this.ctx = null;
    this.source = null;
    this.master = null;
    this.splitter = null;
    this.gains = [];
    this.audio.addEventListener("play", () => this.emitState());
    this.audio.addEventListener("pause", () => this.emitState());
    this.audio.addEventListener("ended", () => this.emitState());

    setInterval(() => this.syncVideoToAudio(), 300);
    // Loop check also on a timer: animation frames pause when the tab is hidden.
    setInterval(() => this.tick(), 40);
  }

  // ---------------------------------------------------------------- YouTube

  /** The YouTube player, or null when the video is disabled. */
  get video() {
    return this.videoEnabled ? this.player : null;
  }

  /** Turn the YouTube player off (embedding blocked) or back on. */
  setVideoEnabled(on) {
    if (!on) {
      try {
        this.player?.pauseVideo?.();
      } catch {
        /* player in error state */
      }
    }
    this.videoEnabled = on;
  }

  async loadVideo(videoId) {
    this.videoEnabled = true;
    const YT = await loadYouTubeApi();
    this.ytReady = false;
    if (this.player) {
      this.player.cueVideoById(videoId);
      this.ytReady = true;
      if (this.mode === "audio") this.player.mute();
      return;
    }
    await new Promise((resolve) => {
      this.player = new YT.Player(this.playerElementId, {
        videoId,
        width: "100%",
        height: "100%",
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1, iv_load_policy: 3 },
        events: {
          onReady: () => {
            this.ytReady = true;
            if (this.mode === "audio") this.player.mute();
            resolve();
          },
          onStateChange: (e) => this.onYouTubeState(e.data),
          onError: (e) => {
            const blocked = e.data === 101 || e.data === 150;
            this.dispatchEvent(new CustomEvent("videoerror", { detail: { code: e.data, blocked } }));
            resolve();
          },
        },
      });
    });
  }

  onYouTubeState(state) {
    this.ytState = state;
    if (this.mode === "video") this.emitState();
  }

  availableVideoRates() {
    return this.player?.getAvailablePlaybackRates?.() ?? [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  }

  nearestVideoRate(rate) {
    return this.availableVideoRates().reduce((best, r) =>
      Math.abs(r - rate) < Math.abs(best - rate) ? r : best, 1);
  }

  // ------------------------------------------------------------ Audio mode

  ensureAudioGraph() {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    this.source = this.ctx.createMediaElementSource(this.audio);
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
  }

  /**
   * Switch to audio mode with a file. `channels` > 1 means a multichannel
   * stem file: each channel gets its own gain (see setGains).
   */
  async enableAudio(url, channels = 0) {
    this.ensureAudioGraph();
    // Resolves only after a user gesture; play() resumes it again later.
    this.ctx.resume().catch(() => {});
    const at = this.time();
    const wasPlaying = this.isPlaying();

    this.source.disconnect();
    this.splitter?.disconnect();
    this.gains.forEach((g) => g.disconnect());
    this.gains = [];
    this.splitter = null;

    if (channels > 1) {
      this.splitter = this.ctx.createChannelSplitter(channels);
      this.source.connect(this.splitter);
      for (let i = 0; i < channels; i++) {
        const gain = this.ctx.createGain();
        this.splitter.connect(gain, i);
        gain.connect(this.master);
        this.gains.push(gain);
      }
    } else {
      this.source.connect(this.master);
    }

    if (this.audio.dataset.url !== url) {
      this.audio.dataset.url = url;
      this.audio.src = url;
      await new Promise((resolve, reject) => {
        this.audio.addEventListener("loadedmetadata", resolve, { once: true });
        this.audio.addEventListener("error", () => reject(new Error(t("Audio non caricabile"))), { once: true });
      });
    }

    if (this.video && this.ytState === 1) this.video.pauseVideo();
    this.video?.mute?.();
    this.mode = "audio";
    this.audio.playbackRate = this.rate;
    this.audio.currentTime = at;
    if (wasPlaying) this.play();
    this.emitState();
  }

  disableAudio() {
    if (this.mode !== "audio" || !this.videoEnabled) return;
    const at = this.time();
    const wasPlaying = this.isPlaying();
    this.audio.pause();
    this.mode = "video";
    if (this.player) {
      this.player.unMute();
      this.player.seekTo(at, true);
      if (wasPlaying) this.player.playVideo();
    }
    this.emitState();
  }

  /** Leave audio mode without resuming the video (used when switching song). */
  stopAudio() {
    this.audio.pause();
    if (this.mode !== "audio") return;
    this.mode = "video";
    this.player?.unMute?.();
    this.emitState();
  }

  setGains(values) {
    if (!this.ctx) return;
    values.forEach((v, i) => {
      if (this.gains[i]) this.gains[i].gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
    });
  }

  syncVideoToAudio() {
    if (this.mode !== "audio" || !this.video || !this.ytReady) return;
    const audioPlaying = !this.audio.paused;
    const videoPlaying = this.ytState === 1 || this.ytState === 3;
    if (audioPlaying && !videoPlaying) this.player.playVideo();
    if (!audioPlaying && this.ytState === 1) this.player.pauseVideo();
    const now = performance.now();
    const drift = this.player.getCurrentTime() - this.audio.currentTime;
    if (Math.abs(drift) > 0.3 && now - this.lastVideoResync > 1500) {
      this.lastVideoResync = now;
      this.player.seekTo(this.audio.currentTime + (audioPlaying ? 0.15 : 0), true);
    }
  }

  // --------------------------------------------------------------- Control

  isPlaying() {
    if (this.mode === "audio") return !this.audio.paused && !this.audio.ended;
    return this.ytState === 1 || this.ytState === 3;
  }

  duration() {
    if (this.mode === "audio") return this.audio.duration || 0;
    return this.player?.getDuration?.() || 0;
  }

  play() {
    if (this.mode === "audio") {
      this.ctx?.resume();
      this.audio.play().catch(() => {});
    }
    this.video?.playVideo?.();
  }

  pause() {
    if (this.mode === "audio") this.audio.pause();
    this.video?.pauseVideo?.();
  }

  toggle() {
    if (this.isPlaying()) this.pause();
    else this.play();
  }

  seek(seconds) {
    const t = Math.max(0, seconds);
    this.pendingSeek = { t, at: performance.now() };
    if (this.mode === "audio") {
      this.audio.currentTime = t;
      this.lastVideoResync = performance.now();
    }
    this.video?.seekTo?.(t, true);
    this.dispatchEvent(new CustomEvent("seek", { detail: { t } }));
  }

  setRate(rate) {
    this.rate = rate;
    if (this.mode === "audio") this.audio.playbackRate = rate;
    this.video?.setPlaybackRate?.(this.nearestVideoRate(rate));
  }

  /** Effective rate actually in use (YouTube may round it). */
  effectiveRate() {
    if (this.mode === "audio") return this.audio.playbackRate;
    return this.player?.getPlaybackRate?.() ?? this.rate;
  }

  /** Current position in seconds, smoothed between player updates. */
  time() {
    const now = performance.now();
    let reported;
    if (this.mode === "audio") reported = this.audio.currentTime;
    else reported = this.player?.getCurrentTime?.() ?? 0;

    // Right after a seek the player may still report the old position.
    if (this.pendingSeek) {
      const elapsed = now - this.pendingSeek.at;
      if (Math.abs(reported - this.pendingSeek.t) < 0.6 || elapsed > SEEK_SETTLE_MS) {
        this.pendingSeek = null;
      } else {
        const playingGuess = this.isPlaying() ? (elapsed / 1000) * this.effectiveRate() : 0;
        return this.pendingSeek.t + playingGuess;
      }
    }

    if (reported !== this.clock.reported) {
      this.clock = { reported, at: now };
      return reported;
    }
    if (this.isPlaying() && this.ytState !== 3) {
      return reported + Math.min((now - this.clock.at) / 1000, 0.25) * this.effectiveRate();
    }
    return reported;
  }

  /** Call every frame: handles A-B looping. Returns current time. */
  tick() {
    const t = this.time();
    if (this.loop && this.isPlaying()) {
      const now = performance.now();
      if (t >= this.loop.end && now - this.lastLoopJump > 250) {
        this.lastLoopJump = now;
        this.seek(this.loop.start);
        return this.loop.start;
      }
    }
    return t;
  }

  emitState() {
    this.dispatchEvent(new CustomEvent("state", { detail: { playing: this.isPlaying() } }));
  }
}
