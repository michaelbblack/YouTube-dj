/**
 * YouTube DJ Engine
 * Handles dual YouTube player management, beat synchronization,
 * crossfading, and automatic mix transitions.
 */

class DJEngine {
  constructor() {
    this.players = { a: null, b: null };
    this.tracks = {};          // Analysis data keyed by video_id
    this.activeDeck = 'a';     // Which deck is currently "live"
    this.queue = [];           // Ordered video IDs to play
    this.queueIndex = 0;
    this.mixPlan = null;       // Server-generated mix plan
    this.autoMixing = false;
    this.crossfadeValue = 0;   // 0 = full A, 100 = full B
    this.transitioning = false;
    this.transitionTimer = null;
    this.beatTracker = { a: null, b: null };
    this.deckVolumes = { a: 100, b: 100 };
    this.onUpdate = null;      // Callback for UI updates
    this.onLog = null;         // Callback for debug logging
    this.playbackRate = { a: 1.0, b: 1.0 };
    this._updateInterval = null;
    this._transitionScheduled = false;
  }

  init() {
    // Start the update loop
    this._updateInterval = setInterval(() => this._tick(), 50);
  }

  destroy() {
    clearInterval(this._updateInterval);
    clearTimeout(this.transitionTimer);
  }

  setPlayer(deck, player) {
    this.players[deck] = player;
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
   * Load a track onto a deck.
   */
  loadDeck(deck, videoId) {
    const player = this.players[deck];
    if (!player) return;

    const track = this.tracks[videoId];
    player.loadVideoById({
      videoId: videoId,
      startSeconds: 0,
    });
    player.pauseVideo();

    // Set playback rate to 1.0 initially
    this.playbackRate[deck] = 1.0;
    if (player.setPlaybackRate) player.setPlaybackRate(1.0);

    this._log('info', `Deck ${deck.toUpperCase()}: loaded ${track?.video_id || videoId} (${track?.bpm || '?'} BPM)`);

    if (this.onUpdate) this.onUpdate('load', { deck, videoId, track });
  }

  /**
   * Start playing on a deck from a specific time.
   */
  playDeck(deck, startTime) {
    const player = this.players[deck];
    if (!player) return;

    if (startTime !== undefined) {
      player.seekTo(startTime, true);
    }
    player.playVideo();
    this._log('info', `Deck ${deck.toUpperCase()}: playing from ${this._formatTime(startTime || 0)}`);
  }

  pauseDeck(deck) {
    this.players[deck]?.pauseVideo();
  }

  /**
   * Set volume for a deck (0-100).
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

  _applyVolumes() {
    const cf = this.crossfadeValue / 100;
    // Equal-power crossfade curve
    const volA = Math.cos(cf * Math.PI / 2);
    const volB = Math.sin(cf * Math.PI / 2);

    const finalA = Math.round(volA * this.deckVolumes.a);
    const finalB = Math.round(volB * this.deckVolumes.b);

    if (this.players.a) this.players.a.setVolume(finalA);
    if (this.players.b) this.players.b.setVolume(finalB);
  }

  /**
   * Start automatic mixing.
   */
  startAutoMix() {
    if (!this.mixPlan || this.queue.length < 2) {
      this._log('error', 'Need a mix plan with at least 2 tracks');
      return;
    }

    this.autoMixing = true;
    this.queueIndex = 0;

    // Load first two tracks
    const firstId = this.queue[0];
    const secondId = this.queue[1];

    this.loadDeck('a', firstId);
    this.loadDeck('b', secondId);

    // Start playing deck A from the beginning (or mix-in point)
    const firstTrack = this.tracks[firstId];
    const startTime = firstTrack?.transitions?.mix_in || 0;

    this.activeDeck = 'a';
    this.crossfadeValue = 0;
    this._applyVolumes();

    // Small delay to let YouTube buffer
    setTimeout(() => {
      this.playDeck('a', startTime);
      this._log('info', `Auto-mix started with ${this.queue.length} tracks`);
      this._scheduleNextTransition();
    }, 1000);

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
    const player = this.players[currentDeck];
    if (!player) return;

    this._transitionScheduled = true;

    // Calculate when to start the transition
    const checkInterval = setInterval(() => {
      if (!this.autoMixing) {
        clearInterval(checkInterval);
        return;
      }

      const currentTime = player.getCurrentTime?.() || 0;
      const outPoint = transition.fromOutPoint;
      const leadTime = transition.crossfadeDuration || 8;

      // Start transition when we're <leadTime> seconds before the out point
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

    // Prepare the incoming deck
    const toTrack = this.tracks[transition.to];
    const inPoint = transition.toInPoint || 0;

    // Sync playback rates for beat matching
    if (transition.type !== 'cut' && transition.bpmDiff > 0.5) {
      this._matchBPMs(fromDeck, toDeck, transition);
    }

    // Start the incoming track at its in-point
    this.playDeck(toDeck, inPoint);

    if (transition.type === 'cut') {
      // Hard cut: instant switch
      this._hardCut(fromDeck, toDeck);
    } else {
      // Crossfade
      this._crossfadeTransition(fromDeck, toDeck, transition);
    }

    if (this.onUpdate) this.onUpdate('transition-start', { transition, fromDeck, toDeck });
  }

  /**
   * Match BPMs between decks using playback rate adjustment.
   * YouTube IFrame API only supports discrete rates: 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2
   */
  _matchBPMs(fromDeck, toDeck, transition) {
    const YOUTUBE_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

    const fromBpm = transition.fromBpm;
    const toBpm = transition.toBpm;

    // Check if it's a double/half time relationship
    let targetBpm = fromBpm;
    let ratio = fromBpm / toBpm;

    if (ratio > 1.9 && ratio < 2.1) {
      targetBpm = fromBpm / 2;
    } else if (ratio > 0.48 && ratio < 0.52) {
      targetBpm = fromBpm * 2;
    }

    const idealRate = targetBpm / toBpm;

    // Snap to nearest YouTube-supported rate
    const snappedRate = YOUTUBE_RATES.reduce((best, rate) =>
      Math.abs(rate - idealRate) < Math.abs(best - idealRate) ? rate : best
    );

    // Only apply if the snapped rate actually helps (within 4% of target)
    const effectiveBpm = toBpm * snappedRate;
    const bpmError = Math.abs(effectiveBpm - targetBpm) / targetBpm;

    if (snappedRate !== 1 && bpmError < 0.04) {
      this.playbackRate[toDeck] = snappedRate;
      const player = this.players[toDeck];
      if (player?.setPlaybackRate) {
        player.setPlaybackRate(snappedRate);
        this._log('beat', `BPM match: ${toDeck.toUpperCase()} rate=${snappedRate} (${toBpm} -> ${effectiveBpm.toFixed(1)} BPM, target=${targetBpm.toFixed(1)}, err=${(bpmError*100).toFixed(1)}%)`);
      }
    } else if (snappedRate !== 1) {
      this._log('warn', `BPM match skipped: best rate ${snappedRate} gives ${(bpmError*100).toFixed(1)}% error (${toBpm} -> ${effectiveBpm.toFixed(1)} vs target ${targetBpm.toFixed(1)})`);
    }
  }

  /**
   * Hard cut transition: instant switch on the nearest downbeat.
   */
  _hardCut(fromDeck, toDeck) {
    // Wait for the next downbeat on the outgoing track
    const fromTrack = this.tracks[this.queue[this.queueIndex]];
    const player = this.players[fromDeck];
    const currentTime = player?.getCurrentTime?.() || 0;

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
      // Instant crossfade
      if (this.activeDeck === 'a') {
        this.crossfadeValue = 100;
      } else {
        this.crossfadeValue = 0;
      }
      this._applyVolumes();
      this.pauseDeck(fromDeck);

      this._finishTransition(toDeck);
    }, delay);

    this._log('beat', `Hard cut scheduled in ${(delay/1000).toFixed(2)}s`);
  }

  /**
   * Crossfade transition: smooth blend between decks over several beats.
   */
  _crossfadeTransition(fromDeck, toDeck, transition) {
    const duration = transition.crossfadeDuration * 1000; // ms
    const steps = 60; // Number of crossfade steps
    const stepDuration = duration / steps;

    const startCf = this.crossfadeValue;
    const endCf = toDeck === 'b' ? 100 : 0;
    const cfDelta = (endCf - startCf) / steps;

    let step = 0;

    // Apply EQ-style crossfade: bring in lows first, then full mix
    const fadeInterval = setInterval(() => {
      if (!this.autoMixing || step >= steps) {
        clearInterval(fadeInterval);
        this.crossfadeValue = endCf;
        this._applyVolumes();
        this.pauseDeck(fromDeck);
        this._finishTransition(toDeck);
        return;
      }

      // S-curve crossfade for smoother blending
      const t = step / steps;
      const sCurve = t * t * (3 - 2 * t); // Smoothstep
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
  _finishTransition(newActiveDeck) {
    this.activeDeck = newActiveDeck;
    this.transitioning = false;
    this.queueIndex++;

    this._log('event', `Transition complete. Now on Deck ${newActiveDeck.toUpperCase()}`);

    // Reset playback rate on the old deck
    const oldDeck = newActiveDeck === 'a' ? 'b' : 'a';
    this.playbackRate[oldDeck] = 1.0;

    // Pre-load next track on the now-free deck
    const nextIdx = this.queueIndex + 1;
    if (nextIdx < this.queue.length) {
      const nextId = this.queue[nextIdx];
      this.loadDeck(oldDeck, nextId);
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
   * Tracks beat positions and manages timing.
   */
  _tick() {
    for (const deck of ['a', 'b']) {
      const player = this.players[deck];
      if (!player || typeof player.getCurrentTime !== 'function') continue;

      const state = player.getPlayerState?.();
      if (state !== 1) continue; // 1 = playing

      const time = player.getCurrentTime();
      const videoId = this._getCurrentVideoId(deck);
      const track = this.tracks[videoId];

      if (track) {
        // Check beat position
        this._checkBeat(deck, time, track);
      }
    }
  }

  _checkBeat(deck, time, track) {
    if (!track.beat_grid || track.beat_grid.length === 0) return;

    // Find nearest beat
    const interval = track.beat_interval;
    const offset = track.beat_grid[0] || 0;
    const beatPos = ((time - offset) / interval);
    const nearestBeat = Math.round(beatPos);
    const distToBeat = Math.abs(beatPos - nearestBeat) * interval;

    // If we're very close to a beat (within 30ms), fire beat event
    if (distToBeat < 0.03) {
      const isDownbeat = nearestBeat % 4 === 0;
      if (this.onUpdate) {
        this.onUpdate('beat', { deck, time, isDownbeat, beatNum: nearestBeat });
      }
    }
  }

  _getCurrentVideoId(deck) {
    if (deck === 'a') {
      return this.queue[this.queueIndex] || null;
    } else {
      const idx = this.queueIndex + 1;
      return idx < this.queue.length ? this.queue[idx] : null;
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
      decks: {}
    };

    for (const deck of ['a', 'b']) {
      const player = this.players[deck];
      if (player && typeof player.getCurrentTime === 'function') {
        state.decks[deck] = {
          time: player.getCurrentTime(),
          duration: player.getDuration?.() || 0,
          state: player.getPlayerState?.() || -1,
          volume: player.getVolume?.() || 0,
        };
      }
    }

    return state;
  }
}

// Export for use in app.js
window.DJEngine = DJEngine;
