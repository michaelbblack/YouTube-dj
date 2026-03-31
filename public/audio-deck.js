/**
 * AudioDeck - Web Audio API powered audio playback for a single DJ deck.
 *
 * Uses HTML5 <audio> element as source, routed through Web Audio API graph:
 *   <audio> -> MediaElementSource -> GainNode -> AnalyserNode -> destination
 *
 * This gives us:
 *   - Arbitrary playbackRate (not limited to YouTube's discrete values)
 *   - Precise gain control via GainNode (not YouTube's 0-100 integer volume)
 *   - AnalyserNode for real-time waveform/frequency visualization
 *   - Accurate currentTime and duration from the audio element
 */
class AudioDeck {
  /**
   * @param {string} deckId - 'a' or 'b'
   * @param {AudioContext} audioContext - shared AudioContext for both decks
   */
  constructor(deckId, audioContext) {
    this.deckId = deckId;
    this.ctx = audioContext;

    // Audio element for streaming playback
    this.audio = new Audio();
    this.audio.crossOrigin = 'anonymous';
    this.audio.preload = 'auto';

    // Web Audio API nodes
    this.sourceNode = null;  // Created once per audio element
    this.gainNode = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.8;

    // Connect: gain -> analyser -> destination
    this.gainNode.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    // State
    this.videoId = null;
    this.loaded = false;
    this.loading = false;
    this._sourceCreated = false;

    // Bind events
    this.audio.addEventListener('canplaythrough', () => {
      this.loaded = true;
      this.loading = false;
    });
    this.audio.addEventListener('error', (e) => {
      console.error(`AudioDeck ${deckId}: load error`, e);
      this.loading = false;
    });
  }

  /**
   * Load audio for a video ID from the server cache.
   * @param {string} videoId
   * @returns {Promise<void>} resolves when audio is ready to play
   */
  load(videoId) {
    return new Promise((resolve, reject) => {
      this.videoId = videoId;
      this.loaded = false;
      this.loading = true;

      // Reset playback rate
      this.audio.playbackRate = 1.0;

      const onReady = () => {
        cleanup();
        this.loaded = true;
        this.loading = false;

        // Create MediaElementSource only once per audio element
        if (!this._sourceCreated) {
          this.sourceNode = this.ctx.createMediaElementSource(this.audio);
          this.sourceNode.connect(this.gainNode);
          this._sourceCreated = true;
        }

        resolve();
      };

      const onError = (e) => {
        cleanup();
        this.loading = false;
        reject(new Error(`Failed to load audio for ${videoId}: ${e.message || 'unknown error'}`));
      };

      const cleanup = () => {
        this.audio.removeEventListener('canplaythrough', onReady);
        this.audio.removeEventListener('error', onError);
      };

      this.audio.addEventListener('canplaythrough', onReady, { once: true });
      this.audio.addEventListener('error', onError, { once: true });

      this.audio.src = `/api/audio/${videoId}`;
      this.audio.load();
    });
  }

  /**
   * Start playback from a specific time.
   * @param {number} [startTime] - seconds to seek to before playing
   */
  play(startTime) {
    if (!this.loaded) return;

    // Resume AudioContext if suspended (browser autoplay policy)
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }

    if (startTime !== undefined) {
      this.audio.currentTime = startTime;
    }
    this.audio.play().catch(e => console.warn(`AudioDeck ${this.deckId}: play failed`, e));
  }

  /**
   * Pause playback.
   */
  pause() {
    this.audio.pause();
  }

  /**
   * Seek to a specific time.
   * @param {number} time - seconds
   */
  seekTo(time) {
    this.audio.currentTime = time;
  }

  /**
   * Set gain (volume). Uses Web Audio GainNode for smooth, precise control.
   * @param {number} value - 0.0 to 1.0
   * @param {number} [rampTime] - optional ramp duration in seconds for smooth transitions
   */
  setGain(value, rampTime) {
    if (rampTime && rampTime > 0) {
      this.gainNode.gain.linearRampToValueAtTime(value, this.ctx.currentTime + rampTime);
    } else {
      this.gainNode.gain.setValueAtTime(value, this.ctx.currentTime);
    }
  }

  /**
   * Set playback rate. Supports any float value (not limited to YouTube's discrete rates).
   * @param {number} rate - e.g. 1.0156 for matching 128 BPM to 130 BPM
   */
  setPlaybackRate(rate) {
    this.audio.playbackRate = rate;
  }

  /**
   * Get current playback time in seconds.
   * @returns {number}
   */
  getCurrentTime() {
    return this.audio.currentTime;
  }

  /**
   * Get total duration in seconds.
   * @returns {number}
   */
  getDuration() {
    return this.audio.duration || 0;
  }

  /**
   * Check if currently playing.
   * @returns {boolean}
   */
  isPlaying() {
    return !this.audio.paused && !this.audio.ended;
  }

  /**
   * Get time-domain waveform data for visualization.
   * @returns {Uint8Array}
   */
  getWaveformData() {
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteTimeDomainData(data);
    return data;
  }

  /**
   * Get frequency spectrum data for visualization.
   * @returns {Uint8Array}
   */
  getFrequencyData() {
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(data);
    return data;
  }

  /**
   * Get current RMS level (0-1) for metering.
   * @returns {number}
   */
  getRMSLevel() {
    const data = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum += data[i] * data[i];
    }
    return Math.sqrt(sum / data.length);
  }

  /**
   * Clean up resources.
   */
  destroy() {
    this.audio.pause();
    this.audio.src = '';
    if (this.sourceNode) {
      this.sourceNode.disconnect();
    }
    this.gainNode.disconnect();
    this.analyser.disconnect();
  }
}

window.AudioDeck = AudioDeck;
