/**
 * Generate synthetic demo audio and analysis data.
 * Creates WAV files with different musical characteristics (BPM, key, energy)
 * so the DJ mixing engine can be fully tested without YouTube access.
 */

const fs = require('fs');
const path = require('path');

// Demo track definitions with distinct musical characteristics
const DEMO_TRACKS = [
  {
    id: 'demo_track_1',
    title: 'Neon Pulse',
    bpm: 128,
    key: 'C',
    mode: 'minor',
    camelot: '5A',
    duration: 45,
    genre: 'electronic/edm',
    baseFreq: 130.81, // C3
    character: 'driving',
  },
  {
    id: 'demo_track_2',
    title: 'Midnight Groove',
    bpm: 124,
    key: 'G',
    mode: 'minor',
    camelot: '6A',
    duration: 45,
    genre: 'house',
    baseFreq: 196.0, // G3
    character: 'smooth',
  },
  {
    id: 'demo_track_3',
    title: 'Solar Flare',
    bpm: 132,
    key: 'D',
    mode: 'major',
    camelot: '10B',
    duration: 45,
    genre: 'trance',
    baseFreq: 146.83, // D3
    character: 'energetic',
  },
  {
    id: 'demo_track_4',
    title: 'Deep Current',
    bpm: 120,
    key: 'A',
    mode: 'minor',
    camelot: '8A',
    duration: 45,
    genre: 'deep house',
    baseFreq: 220.0, // A3
    character: 'mellow',
  },
  {
    id: 'demo_track_5',
    title: 'Crystal Rain',
    bpm: 126,
    key: 'E',
    mode: 'minor',
    camelot: '9A',
    duration: 45,
    genre: 'progressive',
    baseFreq: 164.81, // E3
    character: 'atmospheric',
  },
];

/**
 * Generate a WAV file with a synthesized beat pattern.
 * Creates a rhythmic pattern with kick, hi-hat, and bass tones.
 */
function generateWav(track, outputPath) {
  const sampleRate = 44100;
  const numChannels = 1;
  const bitsPerSample = 16;
  const duration = track.duration;
  const numSamples = sampleRate * duration;

  // Create sample buffer
  const samples = new Float64Array(numSamples);
  const beatInterval = 60.0 / track.bpm;
  const samplesPerBeat = Math.round(sampleRate * beatInterval);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const beatPos = t / beatInterval;
    const beatFrac = beatPos % 1;
    const beatNum = Math.floor(beatPos);
    let sample = 0;

    // Kick drum on every beat (low frequency burst)
    if (beatFrac < 0.08) {
      const kickEnv = 1 - beatFrac / 0.08;
      const kickFreq = 60 * (1 + kickEnv * 2); // Pitch bend down
      sample += Math.sin(2 * Math.PI * kickFreq * t) * kickEnv * kickEnv * 0.6;
    }

    // Hi-hat on offbeats (noise burst)
    const offbeatFrac = (beatPos + 0.5) % 1;
    if (offbeatFrac < 0.03) {
      const hatEnv = 1 - offbeatFrac / 0.03;
      // Simple noise approximation using high-frequency sines
      sample += (Math.sin(t * 8000) * 0.3 + Math.sin(t * 12000) * 0.2 + Math.sin(t * 15000) * 0.15) * hatEnv * 0.25;
    }

    // Closed hi-hat on every 16th note (subtle)
    const sixteenthFrac = (beatPos * 4) % 1;
    if (sixteenthFrac < 0.015) {
      const tickEnv = 1 - sixteenthFrac / 0.015;
      sample += Math.sin(t * 10000) * tickEnv * 0.08;
    }

    // Bass line - plays a pattern based on the track's base frequency
    const barPos = (beatNum % 4);
    const bassFreq = track.baseFreq * (barPos === 0 ? 1 : barPos === 2 ? 1.25 : barPos === 3 ? 0.75 : 1);
    if (beatFrac < 0.4) {
      const bassEnv = beatFrac < 0.02 ? beatFrac / 0.02 : Math.max(0, 1 - (beatFrac - 0.02) / 0.38);
      sample += Math.sin(2 * Math.PI * bassFreq * t) * bassEnv * 0.35;
      // Add slight harmonics
      sample += Math.sin(4 * Math.PI * bassFreq * t) * bassEnv * 0.1;
    }

    // Pad/chord tone (sustained, filtered)
    const padFreq = track.baseFreq * 2;
    const padAmp = 0.08 + 0.04 * Math.sin(2 * Math.PI * t / 8); // Slow LFO
    sample += Math.sin(2 * Math.PI * padFreq * t) * padAmp;
    sample += Math.sin(2 * Math.PI * padFreq * 1.5 * t) * padAmp * 0.5; // Fifth
    if (track.mode === 'minor') {
      sample += Math.sin(2 * Math.PI * padFreq * 1.2 * t) * padAmp * 0.4; // Minor third
    } else {
      sample += Math.sin(2 * Math.PI * padFreq * 1.26 * t) * padAmp * 0.4; // Major third
    }

    // Energy shape: fade in first 4 beats, fade out last 4 beats
    const fadeBeats = 4;
    const fadeInEnd = fadeBeats * beatInterval;
    const fadeOutStart = duration - fadeBeats * beatInterval;
    let envelope = 1;
    if (t < fadeInEnd) envelope = t / fadeInEnd;
    if (t > fadeOutStart) envelope = (duration - t) / (fadeBeats * beatInterval);

    samples[i] = sample * envelope;
  }

  // Normalize
  let maxAbs = 0;
  for (let i = 0; i < numSamples; i++) {
    if (Math.abs(samples[i]) > maxAbs) maxAbs = Math.abs(samples[i]);
  }
  const normFactor = maxAbs > 0 ? 0.9 / maxAbs : 1;

  // Write WAV file
  const dataSize = numSamples * numChannels * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44 + dataSize);

  // WAV header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // Subchunk1Size
  buffer.writeUInt16LE(1, 20);  // PCM format
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(numChannels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Write samples
  for (let i = 0; i < numSamples; i++) {
    const val = Math.max(-1, Math.min(1, samples[i] * normFactor));
    const intVal = Math.round(val * 32767);
    buffer.writeInt16LE(intVal, 44 + i * 2);
  }

  fs.writeFileSync(outputPath, buffer);
}

/**
 * Generate analysis JSON for a demo track.
 */
function generateAnalysis(track) {
  const beatInterval = 60.0 / track.bpm;
  const numBeats = Math.floor(track.duration / beatInterval);

  // Generate beat grid
  const beatGrid = [];
  for (let i = 0; i < numBeats; i++) {
    beatGrid.push(parseFloat((i * beatInterval).toFixed(4)));
  }

  // Generate beat times (slightly humanized for realism)
  const beats = beatGrid.map(b => parseFloat((b + (Math.random() - 0.5) * 0.005).toFixed(4)));

  // Generate energy sections (every 4 seconds)
  const energySections = [];
  const sectionLen = 4;
  for (let t = 0; t < track.duration; t += sectionLen) {
    const progress = t / track.duration;
    // Energy arc: build up -> peak -> sustain -> fade
    let energy;
    if (progress < 0.1) energy = 0.2 + progress * 3;
    else if (progress < 0.3) energy = 0.5 + (progress - 0.1) * 2.5;
    else if (progress < 0.7) energy = 0.8 + Math.sin(progress * Math.PI * 4) * 0.15;
    else if (progress < 0.85) energy = 0.9 - (progress - 0.7) * 2;
    else energy = 0.6 - (progress - 0.85) * 3;
    energy = Math.max(0.1, Math.min(1.0, energy));

    energySections.push({
      time: t,
      energy: energy * 0.15,
      brightness: 1500 + energy * 2500,
      energy_norm: energy,
    });
  }

  // Segments
  const segments = energySections.map((s, i) => {
    let type;
    if (s.energy_norm < 0.3) type = 'breakdown';
    else if (s.energy_norm > 0.8) type = 'peak';
    else if (i > 0 && s.energy_norm - energySections[i-1].energy_norm > 0.3) type = 'buildup';
    else if (i > 0 && energySections[i-1].energy_norm - s.energy_norm > 0.3) type = 'drop';
    else type = 'mid';
    return { time: s.time, type, energy: s.energy_norm };
  });

  return {
    video_id: track.id,
    duration: track.duration,
    bpm: track.bpm,
    beats,
    beat_grid: beatGrid,
    beat_interval: parseFloat(beatInterval.toFixed(4)),
    key: {
      key: track.key,
      mode: track.mode,
      camelot: track.camelot,
      confidence: 0.85 + Math.random() * 0.1,
    },
    energy_sections: energySections,
    transitions: {
      mix_in: beatGrid[4] || 0, // Start at beat 5
      mix_out: beatGrid[Math.max(0, numBeats - 8)] || track.duration * 0.85,
      segments,
    },
    genre: {
      genre_hint: track.genre,
      spectral_centroid: 2000 + Math.random() * 1500,
      spectral_rolloff: 4000 + Math.random() * 3000,
      zero_crossing_rate: 0.05 + Math.random() * 0.08,
      rms_energy: 0.05 + Math.random() * 0.1,
    },
    debug: {
      bpm_strategies: {
        default: track.bpm + (Math.random() - 0.5) * 2,
        onset: track.bpm + (Math.random() - 0.5) * 1,
        tempogram: track.bpm + (Math.random() - 0.5) * 3,
        percussive: track.bpm + (Math.random() - 0.5) * 1.5,
      },
      chosen_strategy: 'onset',
      audio_path: `(synthetic demo)`,
      synthetic: true,
    },
  };
}

/**
 * Generate all demo data: audio WAVs + analysis JSONs.
 * Returns the demo playlist for the client.
 */
function generateAllDemoData(audioDir, analysisDir) {
  const playlist = [];

  for (const track of DEMO_TRACKS) {
    const wavPath = path.join(audioDir, `${track.id}.wav`);
    const analysisPath = path.join(analysisDir, `${track.id}.json`);

    // Generate WAV if not cached
    if (!fs.existsSync(wavPath)) {
      console.log(`Generating demo audio: ${track.title} (${track.bpm} BPM, ${track.key}${track.mode === 'minor' ? 'm' : ''})`);
      generateWav(track, wavPath);
    }

    // Generate analysis JSON if not cached
    if (!fs.existsSync(analysisPath)) {
      const analysis = generateAnalysis(track);
      fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2));
    }

    playlist.push({
      id: track.id,
      title: track.title,
      duration: track.duration,
      thumbnail: null, // No thumbnail for synthetic tracks
    });
  }

  return playlist;
}

module.exports = { generateAllDemoData, DEMO_TRACKS };
