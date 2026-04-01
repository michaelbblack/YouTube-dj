/**
 * MIDI Controller support for YouTube DJ.
 * Uses Web MIDI API with MIDI learn + default Hercules mappings.
 */

class MIDIController {
  constructor(djEngine) {
    this.engine = djEngine;
    this.midiAccess = null;
    this.activeInput = null;
    this.activeOutput = null;
    this.connected = false;
    this.deviceName = '';

    // MIDI learn state
    this.learning = false;
    this.learnTarget = null; // e.g. { action: 'crossfader' }
    this.onLearnComplete = null;

    // Callbacks
    this.onConnect = null;
    this.onDisconnect = null;
    this.onMIDIMessage = null; // for debug display
    this.onLog = null;

    // Mapping: key = "channel:type:number" -> { action, deck?, invert? }
    // type: 'cc' or 'note'
    this.mapping = {};
    this.loadMapping();
  }

  log(msg) {
    console.log(`[MIDI] ${msg}`);
    if (this.onLog) this.onLog(msg);
  }

  // ---- Connection ----

  async init() {
    if (!navigator.requestMIDIAccess) {
      this.log('Web MIDI API not available in this browser');
      return false;
    }

    try {
      this.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
      this.log('Web MIDI API initialized');

      // Listen for device connections
      this.midiAccess.onstatechange = (e) => this._onStateChange(e);

      // Check for already-connected devices
      this._scanDevices();
      return true;
    } catch (err) {
      this.log(`MIDI access denied: ${err.message}`);
      return false;
    }
  }

  _scanDevices() {
    const inputs = Array.from(this.midiAccess.inputs.values());
    const outputs = Array.from(this.midiAccess.outputs.values());

    this.log(`Found ${inputs.length} MIDI inputs, ${outputs.length} outputs`);

    for (const input of inputs) {
      this.log(`  Input: ${input.name} (${input.manufacturer})`);
    }

    // Auto-connect to first available input
    if (inputs.length > 0 && !this.activeInput) {
      this.connectDevice(inputs[0], outputs[0] || null);
    }
  }

  connectDevice(input, output) {
    if (this.activeInput) {
      this.activeInput.onmidimessage = null;
    }

    this.activeInput = input;
    this.activeOutput = output;
    this.deviceName = input.name || 'Unknown MIDI Device';
    this.connected = true;

    input.onmidimessage = (e) => this._onMessage(e);

    this.log(`Connected to: ${this.deviceName}`);

    // Apply device-specific default mapping if no saved mapping exists
    if (Object.keys(this.mapping).length === 0) {
      this._applyDefaultMapping();
    }

    // Hercules handshake: request all current knob/slider positions
    if (output && this.deviceName.toLowerCase().includes('hercules')) {
      try {
        output.send([0xB0, 0x7F, 0x7F]);
        this.log('Sent Hercules handshake (request knob positions)');
      } catch {}
    }

    if (this.onConnect) this.onConnect(this.deviceName);
  }

  disconnect() {
    if (this.activeInput) {
      this.activeInput.onmidimessage = null;
    }
    this.activeInput = null;
    this.activeOutput = null;
    this.connected = false;
    this.deviceName = '';
    if (this.onDisconnect) this.onDisconnect();
  }

  _onStateChange(event) {
    const port = event.port;
    this.log(`MIDI port ${port.state}: ${port.name} (${port.type})`);

    if (port.type === 'input') {
      if (port.state === 'connected' && !this.activeInput) {
        const outputs = Array.from(this.midiAccess.outputs.values());
        const matchingOutput = outputs.find(o => o.name === port.name) || outputs[0];
        this.connectDevice(port, matchingOutput || null);
      } else if (port.state === 'disconnected' && this.activeInput === port) {
        this.disconnect();
      }
    }
  }

  // ---- MIDI Message Handling ----

  _onMessage(event) {
    const [status, data1, data2] = event.data;
    const channel = status & 0x0F;
    const type = status & 0xF0;

    // Debug callback
    if (this.onMIDIMessage) {
      this.onMIDIMessage({ status, channel, type, data1, data2 });
    }

    // MIDI Learn mode
    if (this.learning && this.learnTarget) {
      const msgType = (type === 0xB0) ? 'cc' : 'note';
      // Only learn from note-on or CC with non-zero value
      if ((type === 0x90 && data2 > 0) || type === 0xB0) {
        const key = `${channel}:${msgType}:${data1}`;
        this.mapping[key] = { ...this.learnTarget };
        this.log(`Learned: ${key} -> ${this.learnTarget.action}`);
        this.saveMapping();
        this.learning = false;
        if (this.onLearnComplete) this.onLearnComplete(key, this.learnTarget);
        this.learnTarget = null;
      }
      return;
    }

    // Route message to mapped action
    let msgType, key;

    if (type === 0xB0) {
      // Control Change
      msgType = 'cc';
      key = `${channel}:cc:${data1}`;
    } else if (type === 0x90) {
      // Note On
      msgType = 'note';
      key = `${channel}:note:${data1}`;
    } else if (type === 0x80) {
      // Note Off — treat as note with value 0
      msgType = 'note';
      key = `${channel}:note:${data1}`;
      // Override data2 to 0 for note off
      this._executeAction(key, 0, msgType);
      return;
    } else {
      return; // Ignore other message types
    }

    this._executeAction(key, data2, msgType);
  }

  _executeAction(key, value, msgType) {
    const action = this.mapping[key];
    if (!action) return;

    const deck = action.deck || 'a';
    const normalizedValue = value / 127; // 0.0 - 1.0

    switch (action.action) {
      // ---- Transport ----
      case 'play':
        if (value > 0) {
          const ad = this.engine.audioDecks[deck];
          if (ad && ad.isPlaying()) {
            this.engine.pauseDeck(deck);
          } else {
            this.engine.playDeck(deck);
          }
        }
        break;

      case 'cue':
        if (value > 0) {
          // Cue: go to start
          const audioDeck = this.engine.audioDecks[deck];
          if (audioDeck) {
            this.engine.pauseDeck(deck);
            audioDeck.seekTo(0);
          }
        }
        break;

      case 'sync':
        if (value > 0 && this.engine.audioDecks.a && this.engine.audioDecks.b) {
          // Sync this deck's rate to the other deck's BPM
          const otherDeck = deck === 'a' ? 'b' : 'a';
          const thisBpm = this.engine.trackData?.[this.engine.currentTracks?.[deck]]?.bpm;
          const otherBpm = this.engine.trackData?.[this.engine.currentTracks?.[otherDeck]]?.bpm;
          if (thisBpm && otherBpm) {
            const rate = otherBpm / thisBpm;
            this.engine.audioDecks[deck].setPlaybackRate(rate);
            this.engine.playbackRate[deck] = rate;
            this.log(`Sync ${deck}: rate=${rate.toFixed(4)} (${thisBpm}->${otherBpm} BPM)`);
          }
        }
        break;

      // ---- Volume / Mix ----
      case 'volume':
        this.engine.setDeckVolume(deck, Math.round(normalizedValue * 100));
        break;

      case 'crossfader':
        this.engine.setCrossfade(Math.round(normalizedValue * 100));
        break;

      // ---- EQ ----
      case 'eq_low':
        if (this.engine.audioDecks[deck]?.setEQ) {
          this.engine.audioDecks[deck].setEQ('low', normalizedValue * 2); // 0-2 range (1 = center)
        }
        break;

      case 'eq_mid':
        if (this.engine.audioDecks[deck]?.setEQ) {
          this.engine.audioDecks[deck].setEQ('mid', normalizedValue * 2);
        }
        break;

      case 'eq_high':
        if (this.engine.audioDecks[deck]?.setEQ) {
          this.engine.audioDecks[deck].setEQ('high', normalizedValue * 2);
        }
        break;

      // ---- Jog wheel ----
      case 'jog': {
        const audioDeck = this.engine.audioDecks[deck];
        if (audioDeck && audioDeck.isPlaying()) {
          // Jog value: 0-63 = backward, 64 = center, 65-127 = forward
          const offset = (value - 64) * 0.05; // ~50ms per step
          const currentTime = audioDeck.getCurrentTime();
          audioDeck.seekTo(Math.max(0, currentTime + offset));
        }
        break;
      }

      // ---- Pitch/tempo ----
      case 'pitch': {
        // Pitch fader: 0 = -8%, 64 = 0%, 127 = +8%
        const pitchRange = 0.08;
        const pitchOffset = (normalizedValue - 0.5) * 2 * pitchRange;
        const rate = 1.0 + pitchOffset;
        this.engine.audioDecks[deck]?.setPlaybackRate(rate);
        if (this.engine.playbackRate) this.engine.playbackRate[deck] = rate;
        break;
      }

      // ---- Auto-mix / Transition ----
      case 'automix':
        if (value > 0) {
          if (this.engine.autoMixing) {
            this.engine.stopAutoMix();
          } else {
            this.engine.startAutoMix();
          }
        }
        break;

      case 'transition':
        if (value > 0) {
          this.engine.triggerTransition();
        }
        break;

      // ---- Hotcues ----
      case 'hotcue1':
      case 'hotcue2':
      case 'hotcue3':
      case 'hotcue4': {
        if (value > 0) {
          const num = parseInt(action.action.slice(-1));
          this._handleHotcue(deck, num);
        }
        break;
      }

      default:
        break;
    }
  }

  _handleHotcue(deck, num) {
    // Simple hotcue system: store/recall positions
    if (!this._hotcues) this._hotcues = {};
    const key = `${deck}_${num}`;
    const audioDeck = this.engine.audioDecks[deck];
    if (!audioDeck) return;

    if (this._hotcues[key] !== undefined) {
      // Recall
      audioDeck.seekTo(this._hotcues[key]);
      this.log(`Hotcue ${num} recall: ${this._hotcues[key].toFixed(1)}s`);
    } else {
      // Store
      this._hotcues[key] = audioDeck.getCurrentTime();
      this.log(`Hotcue ${num} set: ${this._hotcues[key].toFixed(1)}s`);
    }
  }

  // ---- MIDI Learn ----

  startLearn(target) {
    this.learning = true;
    this.learnTarget = target;
    this.log(`MIDI Learn: move a control for "${target.action}" (deck ${target.deck || 'global'})`);
  }

  cancelLearn() {
    this.learning = false;
    this.learnTarget = null;
  }

  // ---- Mapping Persistence ----

  saveMapping() {
    try {
      localStorage.setItem('ytdj-midi-mapping', JSON.stringify(this.mapping));
    } catch {}
  }

  loadMapping() {
    try {
      const saved = localStorage.getItem('ytdj-midi-mapping');
      if (saved) {
        this.mapping = JSON.parse(saved);
        this.log(`Loaded saved mapping (${Object.keys(this.mapping).length} controls)`);
      }
    } catch {}
  }

  clearMapping() {
    this.mapping = {};
    localStorage.removeItem('ytdj-midi-mapping');
    this.log('Mapping cleared');
  }

  // ---- Default Mappings ----

  _applyDefaultMapping() {
    const name = this.deviceName.toLowerCase();

    if (name.includes('hercules') || name.includes('djcontrol')) {
      this._applyHerculesMapping();
    } else {
      this._applyGenericMapping();
    }

    this.saveMapping();
    this.log(`Applied default mapping for ${this.deviceName} (${Object.keys(this.mapping).length} controls)`);
  }

  /**
   * Default mapping for Hercules DJControl Mix Ultra.
   * From Mixxx source code analysis:
   * - Channel 0 (0xB0/0x90): Master controls
   * - Channel 1 (0xB1/0x91): Deck A faders/knobs/buttons
   * - Channel 2 (0xB2/0x92): Deck B faders/knobs/buttons
   * - Channel 6 (0x96): Deck A performance pads
   * - Channel 7 (0x97): Deck B performance pads
   * - Shift moves to channels 4/5 (Deck A/B)
   * - Jog wheel: CC 9 = pitch bend, CC 10 = scratch (relative, 64 = center)
   * - Pitch fader: 14-bit via CC 8 (MSB) + CC 40 (LSB)
   */
  _applyHerculesMapping() {
    // ---- Master controls (channel 0) ----
    this.mapping['0:cc:0']   = { action: 'crossfader' };              // Crossfader
    this.mapping['0:cc:3']   = { action: 'volume', deck: 'a' };      // Master volume (map to deck A vol)

    // ---- Deck A buttons (channel 1, note on) ----
    this.mapping['1:note:7']  = { action: 'play', deck: 'a' };       // Play
    this.mapping['1:note:6']  = { action: 'cue', deck: 'a' };        // Cue
    this.mapping['1:note:5']  = { action: 'sync', deck: 'a' };       // Sync

    // ---- Deck A faders/knobs (channel 1, CC) ----
    this.mapping['1:cc:0']    = { action: 'volume', deck: 'a' };     // Volume fader
    this.mapping['1:cc:2']    = { action: 'eq_low', deck: 'a' };     // EQ Low
    this.mapping['1:cc:3']    = { action: 'eq_mid', deck: 'a' };     // EQ Mid
    this.mapping['1:cc:4']    = { action: 'eq_high', deck: 'a' };    // EQ High / Gain
    this.mapping['1:cc:8']    = { action: 'pitch', deck: 'a' };      // Pitch fader (MSB)
    this.mapping['1:cc:9']    = { action: 'jog', deck: 'a' };        // Jog wheel (pitch bend mode)
    this.mapping['1:cc:10']   = { action: 'jog', deck: 'a' };        // Jog wheel (scratch mode)

    // ---- Deck B buttons (channel 2, note on) ----
    this.mapping['2:note:7']  = { action: 'play', deck: 'b' };       // Play
    this.mapping['2:note:6']  = { action: 'cue', deck: 'b' };        // Cue
    this.mapping['2:note:5']  = { action: 'sync', deck: 'b' };       // Sync

    // ---- Deck B faders/knobs (channel 2, CC) ----
    this.mapping['2:cc:0']    = { action: 'volume', deck: 'b' };     // Volume fader
    this.mapping['2:cc:2']    = { action: 'eq_low', deck: 'b' };     // EQ Low
    this.mapping['2:cc:3']    = { action: 'eq_mid', deck: 'b' };     // EQ Mid
    this.mapping['2:cc:4']    = { action: 'eq_high', deck: 'b' };    // EQ High / Gain
    this.mapping['2:cc:8']    = { action: 'pitch', deck: 'b' };      // Pitch fader (MSB)
    this.mapping['2:cc:9']    = { action: 'jog', deck: 'b' };        // Jog wheel (pitch bend mode)
    this.mapping['2:cc:10']   = { action: 'jog', deck: 'b' };        // Jog wheel (scratch mode)

    // ---- Performance pads - Deck A (channel 6) ----
    this.mapping['6:note:0']  = { action: 'hotcue1', deck: 'a' };    // Hot Cue 1
    this.mapping['6:note:1']  = { action: 'hotcue2', deck: 'a' };    // Hot Cue 2
    this.mapping['6:note:2']  = { action: 'hotcue3', deck: 'a' };    // Hot Cue 3
    this.mapping['6:note:3']  = { action: 'hotcue4', deck: 'a' };    // Hot Cue 4

    // ---- Performance pads - Deck B (channel 7) ----
    this.mapping['7:note:0']  = { action: 'hotcue1', deck: 'b' };    // Hot Cue 1
    this.mapping['7:note:1']  = { action: 'hotcue2', deck: 'b' };    // Hot Cue 2
    this.mapping['7:note:2']  = { action: 'hotcue3', deck: 'b' };    // Hot Cue 3
    this.mapping['7:note:3']  = { action: 'hotcue4', deck: 'b' };    // Hot Cue 4

    // ---- Also map DJControl Compact layout (channel 0 for everything) ----
    // This ensures compatibility with older Hercules controllers
    this.mapping['0:note:33'] = { action: 'play', deck: 'a' };       // 0x21
    this.mapping['0:note:34'] = { action: 'cue', deck: 'a' };        // 0x22
    this.mapping['0:note:35'] = { action: 'sync', deck: 'a' };       // 0x23
    this.mapping['0:note:81'] = { action: 'play', deck: 'b' };       // 0x51
    this.mapping['0:note:82'] = { action: 'cue', deck: 'b' };        // 0x52
    this.mapping['0:note:83'] = { action: 'sync', deck: 'b' };       // 0x53
    this.mapping['0:cc:54']   = { action: 'crossfader' };             // 0x36
    this.mapping['0:cc:48']   = { action: 'jog', deck: 'a' };        // 0x30
    this.mapping['0:cc:49']   = { action: 'jog', deck: 'b' };        // 0x31
  }

  /**
   * Generic mapping for unknown controllers.
   * Assumes standard 2-channel DJ layout.
   */
  _applyGenericMapping() {
    // Channel 0 common
    this.mapping['0:cc:1']   = { action: 'crossfader' };

    // Deck A on channel 0
    this.mapping['0:note:36'] = { action: 'play', deck: 'a' };
    this.mapping['0:note:37'] = { action: 'cue', deck: 'a' };
    this.mapping['0:cc:7']    = { action: 'volume', deck: 'a' };
    this.mapping['0:cc:16']   = { action: 'eq_high', deck: 'a' };
    this.mapping['0:cc:17']   = { action: 'eq_mid', deck: 'a' };
    this.mapping['0:cc:18']   = { action: 'eq_low', deck: 'a' };

    // Deck B on channel 1
    this.mapping['1:note:36'] = { action: 'play', deck: 'b' };
    this.mapping['1:note:37'] = { action: 'cue', deck: 'b' };
    this.mapping['1:cc:7']    = { action: 'volume', deck: 'b' };
    this.mapping['1:cc:16']   = { action: 'eq_high', deck: 'b' };
    this.mapping['1:cc:17']   = { action: 'eq_mid', deck: 'b' };
    this.mapping['1:cc:18']   = { action: 'eq_low', deck: 'b' };
  }

  // ---- Get available actions for learn UI ----

  static getActions() {
    return [
      { action: 'play', label: 'Play/Pause', perDeck: true },
      { action: 'cue', label: 'Cue (Return to Start)', perDeck: true },
      { action: 'sync', label: 'Sync BPM', perDeck: true },
      { action: 'volume', label: 'Volume Fader', perDeck: true },
      { action: 'crossfader', label: 'Crossfader', perDeck: false },
      { action: 'eq_high', label: 'EQ High', perDeck: true },
      { action: 'eq_mid', label: 'EQ Mid', perDeck: true },
      { action: 'eq_low', label: 'EQ Low', perDeck: true },
      { action: 'jog', label: 'Jog Wheel', perDeck: true },
      { action: 'pitch', label: 'Pitch/Tempo Fader', perDeck: true },
      { action: 'hotcue1', label: 'Hot Cue 1', perDeck: true },
      { action: 'hotcue2', label: 'Hot Cue 2', perDeck: true },
      { action: 'hotcue3', label: 'Hot Cue 3', perDeck: true },
      { action: 'hotcue4', label: 'Hot Cue 4', perDeck: true },
      { action: 'automix', label: 'Auto Mix Toggle', perDeck: false },
      { action: 'transition', label: 'Trigger Transition', perDeck: false },
    ];
  }

  // ---- LED Feedback (if controller supports it) ----

  sendLED(channel, note, on) {
    if (!this.activeOutput) return;
    try {
      this.activeOutput.send([0x90 | channel, note, on ? 0x7F : 0x00]);
    } catch {}
  }
}
