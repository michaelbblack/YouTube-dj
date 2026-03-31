/**
 * YouTube DJ Engine - Hybrid Audio Mode
 *
 * Uses Web Audio API (via AudioDeck) for precise audio control:
 *   - Arbitrary playbackRate for exact BPM matching
 *   - GainNode crossfading (no more YouTube setVolume() at 60fps)
 *   - AnalyserNode for real-time waveform visualization
 *
 * YouTube IFrame players are used ONLY for visuals (muted).
 * Audio position is the source of truth; YouTube video syncs to it.
 */

class DJEngine {
  constructor() {
    // YouTube players (visuals only, muted)
    this.players = { a: null, b: null };
    // Web Audio decks (actual audio playback)
    this.audioDecks = { a: null, b: null };
    this.audioContext = null;

    this.tracks = {};          // Analysis data keyed by video_id
    this.activeDeck = 'a';
    this.queue = [];           // Ordered video IDs
    this.queueIndex = 0;
    this.mixPlan = null;
    this.autoMixing = false;
    this.crossfadeValue = 0;   // 0 = full A, 100 = full B
    this.transitioning = false;
    this.transitionTimer = null;
    this.beatTracker = { a: null, b: null };
    this.deckVolumes = { a: 100, b: 100 };
    this.onUpdate = null;
    this.onLog = null;
    this.playbackRate = { a: 1.0, b: 1.0 };
    this._updateInterval = null;
    this._transitionScheduled = false;

    // Hybrid mode: sync YouTube video to audio position
    this._syncInterval = null;
    this._syncThreshold = 0.5; // seconds - re-sync YouTube if drift exceeds this

    // Track which video IDs are loaded on each deck
    this._deckVideoIds = { a: null, b: null };
  }

  init() {
    // Create shared AudioContext
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    this.audioDecks.a = new AudioDeck('a', this.audioContext);
    this.audioDecks.b = new AudioDeck('b', this.audioContext);

    // Start update loops
    this._updateInterval = setInterval(() => this._tick(), 50);
    this._syncInterval = setInterval(() => this._syncVideoToAudio(), 500);

    this._log('info', 'Hybrid audio mode initialized (Web Audio API + YouTube visuals)');
  }

  destroy() {
    clearInterval(this._updateInterval);
    clearInterval(this._syncInterval);
    clearTimeout(this.transitionTimer);
    this.audioDecks.a?.destroy();
    this.audioDecks.b?.destroy();
    this.audioContext?.close();
  }

  setPlayer(deck, player) {
    this.players[deck] = player;
    // Mute YouTube player - audio comes from AudioDeck
    player.mute();
  }

  setTrackData(videoId, data) {
    this.tracks[videoId] = data;
  }

  setMixPlan(plan) {
    this.mixPlan = plan;
    this.queue = plan.order;
    this.queueIndex = 0;
    this._log('info', `Mix plan loaded: ${plan.order.length} tracks, ${plan.transitions.length} transitions`);
  }

  /**
   * Load a track onto a deck (both audio and video).
   */
  async loadDeck(deck, videoId) {
    const player = this.players[deck];
    const audioDeck = this.audioDecks[deck];
    const track = this.tracks[videoId];

    this._deckVideoIds[deck] = videoId;

    // Load YouTube video (muted, for visuals)
    if (player) {
      player.loadVideoById({ videoId, startSeconds: 0 });
      player.pauseVideo();
      player.mute(); // Ensure muted
    }

    // Load audio from server cache
    try {
      await audioDeck.load(videoId);
      this._log('info', `Deck ${deck.toUpperCase()}: loaded ${videoId} (${track?.bpm || '?'} BPM) [hybrid audio]`);
    } catch (err) {
      this._log('error', `Deck ${deck.toUpperCase()}: audio load failed for ${videoId}: ${err.message}`);
    }

    // Reset playback rate
    this.playbackRate[deck] = 1.0;
    audioDeck.setPlaybackRate(1.0);

    if (this.onUpdate) this.onUpdate('load', { deck, videoId, track });
  }

  /**
   * Start playing on a deck from a specific time.
   */
  playDeck(deck, startTime) {
    const audioDeck = this.audioDecks[deck];
    const player = this.players[deck];

    // Resume AudioContext on first user gesture
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }

    // Play audio (source of truth)
    audioDeck.play(startTime);

    // Sync YouTube video to same position
    if (player) {
      if (startTime !== undefined) {
        player.seekTo(startTime, true);
      }
      player.playVideo();
      player.mute();
    }

    this._log('info', `Deck ${deck.toUpperCase()}: playing from ${this._formatTime(startTime || 0)}`);
  }

  pauseDeck(deck) {
    this.audioDecks[deck]?.pause();
    this.players[deck]?.pauseVideo();
  }

  /**
   * Set volume for a deck (0-100, mapped to gain 0-1).
   */
  setDeckVolume(deck, vol) {
    this.deckVolumes[deck] = vol;
    this._applyVolumes();
  }

  /**
   * Set crossfade position (0 = full A, 100 = full B).
   */
  setCrossfade(value) {
    this.crossfadeValue = value;
    this._applyVolumes();
  }

  /**
   * Apply volumes using Web Audio GainNodes (not YouTube setVolume).
   * Equal-power crossfade curve for consistent perceived loudness.
   */
  _applyVolumes() {
    const cf = this.crossfadeValue / 100;

    // Equal-power crossfade curve
    const cfGainA = Math.cos(cf * Math.PI / 2);
    const cfGainB = Math.sin(cf * Math.PI / 2);

    // Combine crossfade with per-deck volume
    const gainA = cfGainA * (this.deckVolumes.a / 100);
    const gainB = cfGainB * (this.deckVolumes.b / 100);

    // Apply via GainNode (precise, smooth, no stepping artifacts)
    this.audioDecks.a.setGain(gainA);
    this.audioDecks.b.setGain(gainB);
  }

  /**
   * Sync YouTube video position to audio position.
   * Audio is the source of truth. YouTube just shows the video.
   */
  _syncVideoToAudio() {
    for (const deck of ['a', 'b']) {
      const audioDeck = this.audioDecks[deck];
      const player = this.players[deck];
      if (!audioDeck || !player || !audioDeck.isPlaying()) continue;
      if (typeof player.getCurrentTime !== 'function') continue;

      const audioTime = audioDeck.getCurrentTime();
      const videoTime = player.getCurrentTime();
      const drift = Math.abs(audioTime - videoTime);

      if (drift > this._syncThreshold) {
        player.seekTo(audioTime, true);
        this._log('beat', `Sync: Deck ${deck.toUpperCase()} video re-synced (drift: ${drift.toFixed(2)}s)`);
      }

      // Sync playback rate too
      const audioRate = audioDeck.audio.playbackRate;
      const availableRates = player.getAvailablePlaybackRates?.() || [1];
      // YouTube only supports discrete rates - pick closest
      const closestYTRate = availableRates.reduce((best, rate) =>
        Math.abs(rate - audioRate) < Math.abs(best - audioRate) ? rate : best
      );
      if (player.getPlaybackRate?.() !== closestYTRate) {
        player.setPlaybackRate(closestYTRate);
      }
    }
  }

  /**
   * Start automatic mixing.
   */
  async startAutoMix() {
    if (!this.mixPlan || this.queue.length < 2) {
      this._log('error', 'Need a mix plan with at least 2 tracks');
      return;
    }

    this.autoMixing = true;
    this.queueIndex = 0;

    // Load first two tracks
    const firstId = this.queue[0];
    const secondId = this.queue[1];

    await this.loadDeck('a', firstId);
    await this.loadDeck('b', secondId);

    // Start playing deck A from mix-in point
    const firstTrack = this.tracks[firstId];
    const startTime = firstTrack?.transitions?.mix_in || 0;

    this.activeDeck = 'a';
    this.crossfadeValue = 0;
    this._applyVolumes();

    // Small delay for buffering
    setTimeout(() => {
      this.playDeck('a', startTime);
      this._log('info', `Auto-mix started with ${this.queue.length} tracks [hybrid audio mode]`);
      this._scheduleNextTransition();
    }, 500);

    if (this.onUpdate) this.onUpdate('automix-start', { queue: this.queue });
  }

  /**
   * Stop auto-mixing.
   */
  stopAutoMix() {
    this.autoMixing = false;
    this._transitionScheduled = false;
    clearTimeout(this.transitionTimer);
    this.pauseDeck('a');
    this.pauseDeck('b');
    this._log('info', 'Auto-mix stopped');
    if (this.onUpdate) this.onUpdate('automix-stop', {});
  }

  /**
   * Manually trigger the next transition immediately.
   */
  triggerTransition() {
    if (!this.autoMixing) return;
    clearTimeout(this.transitionTimer);
    this._executeTransition();
  }

  /**
   * Schedule the next transition based on the mix plan.
   * Uses audio position (not YouTube) for timing.
   */
  _scheduleNextTransition() {
    if (!this.autoMixing || this._transitionScheduled) return;

    const transIdx = this.queueIndex;
    if (transIdx >= this.mixPlan.transitions.length) {
      this._log('info', 'Mix complete - no more transitions');
      return;
    }

    const transition = this.mixPlan.transitions[transIdx];
    const currentDeck = this.activeDeck;
    const audioDeck = this.audioDecks[currentDeck];
    if (!audioDeck) return;

    this._transitionScheduled = true;

    const checkInterval = setInterval(() => {
      if (!this.autoMixing) {
        clearInterval(checkInterval);
        return;
      }

      const currentTime = audioDeck.getCurrentTime();
      const outPoint = transition.fromOutPoint;
      const leadTime = transition.crossfadeDuration || 8;

      if (currentTime >= outPoint - leadTime) {
        clearInterval(checkInterval);
        this._executeTransition();
      }
    }, 100);
  }

  /**
   * Execute a transition between decks.
   */
  _executeTransition() {
    const transIdx = this.queueIndex;
    if (transIdx >= this.mixPlan.transitions.length) return;

    const transition = this.mixPlan.transitions[transIdx];
    const fromDeck = this.activeDeck;
    const toDeck = fromDeck === 'a' ? 'b' : 'a';

    this.transitioning = true;
    this._transitionScheduled = false;

    this._log('event', `Transition: ${transition.type} | ${transition.from} -> ${transition.to}`);
    this._log('info', `  BPM: ${transition.fromBpm} -> ${transition.toBpm} (diff: ${transition.bpmDiff.toFixed(1)})`);
    this._log('info', `  Technique: ${transition.technique}`);

    // Match BPMs using precise arbitrary playback rate
    if (transition.type !== 'cut' && transition.bpmDiff > 0.5) {
      this._matchBPMs(fromDeck, toDeck, transition);
    }

    // Start the incoming track at its in-point
    const inPoint = transition.toInPoint || 0;
    this.playDeck(toDeck, inPoint);

    if (transition.type === 'cut') {
      this._hardCut(fromDeck, toDeck);
    } else {
      this._crossfadeTransition(fromDeck, toDeck, transition);
    }

    if (this.onUpdate) this.onUpdate('transition-start', { transition, fromDeck, toDeck });
  }

  /**
   * Match BPMs using precise arbitrary playback rate.
   * No longer constrained to YouTube's discrete rates!
   */
  _matchBPMs(fromDeck, toDeck, transition) {
    const fromBpm = transition.fromBpm;
    const toBpm = transition.toBpm;

    // Handle double/half time relationships
    let targetBpm = fromBpm;
    let ratio = fromBpm / toBpm;

    if (ratio > 1.9 && ratio < 2.1) {
      targetBpm = fromBpm / 2;
    } else if (ratio > 0.48 && ratio < 0.52) {
      targetBpm = fromBpm * 2;
    }

    const rate = targetBpm / toBpm;

    // Clamp to reasonable range to avoid pitch artifacts
    const clampedRate = Math.max(0.5, Math.min(2.0, rate));

    if (Math.abs(clampedRate - 1.0) > 0.001) {
      this.playbackRate[toDeck] = clampedRate;
      this.audioDecks[toDeck].setPlaybackRate(clampedRate);
      this._log('beat', `BPM match: ${toDeck.toUpperCase()} rate=${clampedRate.toFixed(4)} (${toBpm} -> ${(toBpm * clampedRate).toFixed(1)} BPM, target=${targetBpm.toFixed(1)})`);
    }
  }

  /**
   * Hard cut transition: instant switch on the nearest downbeat.
   */
  _hardCut(fromDeck, toDeck) {
    const fromTrack = this.tracks[this._deckVideoIds[fromDeck]];
    const audioDeck = this.audioDecks[fromDeck];
    const currentTime = audioDeck.getCurrentTime();

    // Find next downbeat (every 4 beats)
    let cutTime = currentTime;
    if (fromTrack?.beat_grid) {
      for (let i = 0; i < fromTrack.beat_grid.length; i++) {
        if (fromTrack.beat_grid[i] > currentTime && i % 4 === 0) {
          cutTime = fromTrack.beat_grid[i];
          break;
        }
      }
    }

    const delay = Math.max(0, (cutTime - currentTime) * 1000);

    setTimeout(() => {
      // Instant crossfade via GainNode
      if (this.activeDeck === 'a') {
        this.crossfadeValue = 100;
      } else {
        this.crossfadeValue = 0;
      }
      this._applyVolumes();
      this.pauseDeck(fromDeck);
      this._finishTransition(toDeck);
    }, delay);

    this._log('beat', `Hard cut scheduled in ${(delay / 1000).toFixed(2)}s`);
  }

  /**
   * Crossfade transition using Web Audio GainNodes.
   * S-curve smoothing for natural-sounding blend.
   */
  _crossfadeTransition(fromDeck, toDeck, transition) {
    const duration = transition.crossfadeDuration * 1000; // ms
    const steps = 60;
    const stepDuration = duration / steps;

    const startCf = this.crossfadeValue;
    const endCf = toDeck === 'b' ? 100 : 0;

    let step = 0;

    const fadeInterval = setInterval(() => {
      if (!this.autoMixing || step >= steps) {
        clearInterval(fadeInterval);
        this.crossfadeValue = endCf;
        this._applyVolumes();
        this.pauseDeck(fromDeck);
        this._finishTransition(toDeck);
        return;
      }

      // S-curve (smoothstep) for natural crossfade
      const t = step / steps;
      const sCurve = t * t * (3 - 2 * t);
      this.crossfadeValue = startCf + (endCf - startCf) * sCurve;
      this._applyVolumes();

      step++;

      if (this.onUpdate) {
        this.onUpdate('crossfade', {
          progress: t,
          crossfade: this.crossfadeValue,
          fromDeck,
          toDeck
        });
      }
    }, stepDuration);
  }

  /**
   * Complete a transition and prepare for the next one.
   */
  async _finishTransition(newActiveDeck) {
    this.activeDeck = newActiveDeck;
    this.transitioning = false;
    this.queueIndex++;

    this._log('event', `Transition complete. Now on Deck ${newActiveDeck.toUpperCase()}`);

    // Reset playback rate on the old deck
    const oldDeck = newActiveDeck === 'a' ? 'b' : 'a';
    this.playbackRate[oldDeck] = 1.0;
    this.audioDecks[oldDeck].setPlaybackRate(1.0);

    // Pre-load next track on the now-free deck
    const nextIdx = this.queueIndex + 1;
    if (nextIdx < this.queue.length) {
      const nextId = this.queue[nextIdx];
      await this.loadDeck(oldDeck, nextId);
      this._log('info', `Pre-loaded next track on Deck ${oldDeck.toUpperCase()}: ${nextId}`);
    }

    // Schedule next transition
    if (this.autoMixing) {
      this._scheduleNextTransition();
    }

    if (this.onUpdate) {
      this.onUpdate('transition-complete', {
        activeDeck: newActiveDeck,
        queueIndex: this.queueIndex
      });
    }
  }

  /**
   * Main update tick - runs every 50ms.
   * Uses audio position for beat tracking (more accurate than YouTube).
   */
  _tick() {
    for (const deck of ['a', 'b']) {
      const audioDeck = this.audioDecks[deck];
      if (!audioDeck?.isPlaying()) continue;

      const time = audioDeck.getCurrentTime();
      const videoId = this._deckVideoIds[deck];
      const track = this.tracks[videoId];

      if (track) {
        this._checkBeat(deck, time, track);
      }
    }
  }

  _checkBeat(deck, time, track) {
    if (!track.beat_grid || track.beat_grid.length === 0) return;

    const interval = track.beat_interval;
    const offset = track.beat_grid[0] || 0;
    const beatPos = ((time - offset) / interval);
    const nearestBeat = Math.round(beatPos);
    const distToBeat = Math.abs(beatPos - nearestBeat) * interval;

    // Fire beat event within 30ms of beat position
    if (distToBeat < 0.03) {
      const isDownbeat = nearestBeat % 4 === 0;
      if (this.onUpdate) {
        this.onUpdate('beat', { deck, time, isDownbeat, beatNum: nearestBeat });
      }
    }
  }

  _log(type, message) {
    const entry = {
      time: new Date().toISOString(),
      type,
      message
    };
    if (this.onLog) this.onLog(entry);
    console.log(`[DJ ${type}] ${message}`);
  }

  _formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  /**
   * Get current state for UI/debug.
   */
  getState() {
    const state = {
      activeDeck: this.activeDeck,
      crossfade: this.crossfadeValue,
      autoMixing: this.autoMixing,
      transitioning: this.transitioning,
      queueIndex: this.queueIndex,
      queueLength: this.queue.length,
      playbackRates: { ...this.playbackRate },
      hybridMode: true,
      decks: {}
    };

    for (const deck of ['a', 'b']) {
      const audioDeck = this.audioDecks[deck];
      if (audioDeck) {
        state.decks[deck] = {
          time: audioDeck.getCurrentTime(),
          duration: audioDeck.getDuration(),
          playing: audioDeck.isPlaying(),
          gain: audioDeck.gainNode.gain.value,
          rmsLevel: audioDeck.isPlaying() ? audioDeck.getRMSLevel() : 0,
          playbackRate: audioDeck.audio.playbackRate,
        };
      }
    }

    return state;
  }
}

window.DJEngine = DJEngine;
