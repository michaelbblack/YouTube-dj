/**
 * Audio analysis pipeline for YouTube DJ — pure Node.js.
 * No Python, no librosa, no system ffmpeg needed.
 * Uses ffmpeg-static (npm) for conversion + custom DSP for analysis.
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const wavDecoder = require('wav-decoder');

// ffmpeg-static provides the binary path; fall back to system ffmpeg
let ffmpegPath;
try {
  ffmpegPath = require('ffmpeg-static');
} catch {
  ffmpegPath = 'ffmpeg';
}

// ---- Audio download & conversion ----

/**
 * Download audio from YouTube and convert to 44.1kHz mono WAV.
 */
function downloadAudio(videoId, audioDir, ytDlpBinary) {
  const outputPath = path.join(audioDir, `${videoId}.wav`);
  if (fs.existsSync(outputPath)) return outputPath;

  const tempPath = path.join(audioDir, `${videoId}_temp`);
  console.log(`Downloading audio for ${videoId}...`);

  // Download best audio
  const dlResult = spawnSync(ytDlpBinary, [
    '-x',
    '--audio-quality', '0',
    '--no-check-certificates',
    '--no-playlist',
    '--retries', '3',
    '--socket-timeout', '30',
    '-o', `${tempPath}.%(ext)s`,
    `https://www.youtube.com/watch?v=${videoId}`
  ], { timeout: 180000 });

  if (dlResult.status !== 0) {
    const err = dlResult.stderr?.toString() || 'unknown error';
    console.error(`yt-dlp error for ${videoId}:`, err.slice(0, 300));
    cleanupTemp(tempPath);
    return null;
  }

  // Find the downloaded file
  const exts = ['webm', 'opus', 'ogg', 'm4a', 'mp3', 'wav', 'aac', 'mp4'];
  let srcFile = null;
  for (const ext of exts) {
    const candidate = `${tempPath}.${ext}`;
    if (fs.existsSync(candidate)) {
      srcFile = candidate;
      break;
    }
  }

  // Also check for files matching the temp pattern (yt-dlp naming quirks)
  if (!srcFile) {
    const dir = path.dirname(tempPath);
    const base = path.basename(tempPath);
    const files = fs.readdirSync(dir).filter(f => f.startsWith(base));
    if (files.length > 0) {
      srcFile = path.join(dir, files[0]);
    }
  }

  if (!srcFile) {
    console.error(`No audio file found for ${videoId}`);
    return null;
  }

  // Convert to mono 44.1kHz WAV using ffmpeg-static
  if (srcFile !== outputPath) {
    console.log(`Converting to WAV for ${videoId}...`);
    const ffResult = spawnSync(ffmpegPath, [
      '-i', srcFile, '-ar', '44100', '-ac', '1', '-y', outputPath
    ], { timeout: 120000 });

    // Clean up source file
    try { fs.unlinkSync(srcFile); } catch {}

    if (ffResult.status !== 0) {
      console.error(`ffmpeg error for ${videoId}:`, ffResult.stderr?.toString().slice(0, 200));
      return null;
    }
  }

  return fs.existsSync(outputPath) ? outputPath : null;
}

function cleanupTemp(tempPath) {
  const dir = path.dirname(tempPath);
  const base = path.basename(tempPath);
  try {
    const files = fs.readdirSync(dir).filter(f => f.startsWith(base));
    files.forEach(f => { try { fs.unlinkSync(path.join(dir, f)); } catch {} });
  } catch {}
}

// ---- WAV loading ----

/**
 * Load WAV file and return Float32Array of samples + sample rate.
 */
function loadWav(filePath) {
  const buffer = fs.readFileSync(filePath);
  const decoded = wavDecoder.decode.sync(buffer);
  return {
    samples: decoded.channelData[0], // Mono (first channel)
    sampleRate: decoded.sampleRate,
    duration: decoded.channelData[0].length / decoded.sampleRate,
  };
}

// ---- DSP helpers ----

/**
 * Compute RMS energy in windows.
 */
function computeRMS(samples, windowSize) {
  const result = [];
  for (let i = 0; i < samples.length; i += windowSize) {
    let sum = 0;
    const end = Math.min(i + windowSize, samples.length);
    for (let j = i; j < end; j++) {
      sum += samples[j] * samples[j];
    }
    result.push(Math.sqrt(sum / (end - i)));
  }
  return result;
}

/**
 * Compute spectral centroid for each window (brightness measure).
 */
function computeSpectralCentroid(samples, sampleRate, windowSize) {
  const centroids = [];
  const fftSize = windowSize;

  for (let i = 0; i < samples.length; i += windowSize) {
    const end = Math.min(i + fftSize, samples.length);
    const frame = new Float32Array(fftSize);
    for (let j = 0; j < end - i; j++) {
      // Hann window
      const w = 0.5 * (1 - Math.cos(2 * Math.PI * j / (fftSize - 1)));
      frame[j] = samples[i + j] * w;
    }

    // Compute magnitude spectrum via DFT (simplified for centroid)
    const halfN = Math.floor(fftSize / 2);
    let weightedSum = 0;
    let magSum = 0;

    for (let k = 1; k < halfN; k++) {
      let re = 0, im = 0;
      for (let n = 0; n < fftSize; n++) {
        const angle = -2 * Math.PI * k * n / fftSize;
        re += frame[n] * Math.cos(angle);
        im += frame[n] * Math.sin(angle);
      }
      const mag = Math.sqrt(re * re + im * im);
      const freq = k * sampleRate / fftSize;
      weightedSum += freq * mag;
      magSum += mag;
    }

    centroids.push(magSum > 0 ? weightedSum / magSum : 0);
  }
  return centroids;
}

// ---- BPM detection ----

/**
 * Detect BPM using onset strength autocorrelation.
 */
function detectBPM(samples, sampleRate) {
  const hopSize = 512;
  const windowSize = 1024;

  // Compute onset strength (spectral flux)
  const onsetStrength = [];
  let prevSpectrum = null;

  for (let i = 0; i < samples.length - windowSize; i += hopSize) {
    const frame = new Float32Array(windowSize);
    for (let j = 0; j < windowSize; j++) {
      const w = 0.5 * (1 - Math.cos(2 * Math.PI * j / (windowSize - 1)));
      frame[j] = (samples[i + j] || 0) * w;
    }

    // Compute magnitude spectrum (first 256 bins)
    const nBins = Math.floor(windowSize / 2);
    const spectrum = new Float32Array(nBins);
    for (let k = 0; k < nBins; k++) {
      let re = 0, im = 0;
      for (let n = 0; n < windowSize; n++) {
        const angle = -2 * Math.PI * k * n / windowSize;
        re += frame[n] * Math.cos(angle);
        im += frame[n] * Math.sin(angle);
      }
      spectrum[k] = Math.sqrt(re * re + im * im);
    }

    if (prevSpectrum) {
      let flux = 0;
      for (let k = 0; k < nBins; k++) {
        const diff = spectrum[k] - prevSpectrum[k];
        if (diff > 0) flux += diff;
      }
      onsetStrength.push(flux);
    } else {
      onsetStrength.push(0);
    }
    prevSpectrum = spectrum;
  }

  // Autocorrelation of onset strength
  const minBPM = 70, maxBPM = 180;
  const onsetRate = sampleRate / hopSize;
  const minLag = Math.floor(onsetRate * 60 / maxBPM);
  const maxLag = Math.ceil(onsetRate * 60 / minBPM);
  const N = onsetStrength.length;

  let bestBPM = 120;
  let bestCorr = -Infinity;

  for (let lag = minLag; lag <= Math.min(maxLag, N - 1); lag++) {
    let corr = 0;
    let count = 0;
    for (let i = 0; i < N - lag; i++) {
      corr += onsetStrength[i] * onsetStrength[i + lag];
      count++;
    }
    corr = count > 0 ? corr / count : 0;

    const bpm = (onsetRate * 60) / lag;
    if (corr > bestCorr) {
      bestCorr = corr;
      bestBPM = bpm;
    }
  }

  // Also check double/half to pick the most common octave
  const candidates = [bestBPM, bestBPM * 2, bestBPM / 2].filter(b => b >= 70 && b <= 180);
  // Prefer the one closest to common dance music range (110-140)
  candidates.sort((a, b) => Math.abs(a - 125) - Math.abs(b - 125));

  return Math.round(candidates[0] * 100) / 100;
}

/**
 * Estimate beat positions from BPM.
 */
function computeBeatGrid(samples, sampleRate, bpm) {
  const duration = samples.length / sampleRate;
  const beatInterval = 60.0 / bpm;

  // Find best phase by checking onset strength at each candidate offset
  const hopSize = 512;
  const onsetRate = sampleRate / hopSize;

  // Compute a simple onset envelope
  const onset = [];
  for (let i = 0; i < samples.length - hopSize; i += hopSize) {
    let energy = 0;
    for (let j = 0; j < hopSize; j++) {
      energy += samples[i + j] * samples[i + j];
    }
    onset.push(Math.sqrt(energy / hopSize));
  }

  // Try different phase offsets, pick the one with most onset energy on beats
  let bestOffset = 0;
  let bestScore = -Infinity;
  const testSteps = 32;

  for (let s = 0; s < testSteps; s++) {
    const offset = (s / testSteps) * beatInterval;
    let score = 0;
    let t = offset;
    while (t < duration) {
      const idx = Math.round(t * onsetRate);
      if (idx >= 0 && idx < onset.length) {
        score += onset[idx];
      }
      t += beatInterval;
    }
    if (score > bestScore) {
      bestScore = score;
      bestOffset = offset;
    }
  }

  // Generate beat grid
  const beats = [];
  let t = bestOffset;
  while (t < duration) {
    beats.push(Math.round(t * 10000) / 10000);
    t += beatInterval;
  }

  return beats;
}

// ---- Key detection ----

/**
 * Detect musical key using chroma features and Krumhansl-Kessler profiles.
 */
function detectKey(samples, sampleRate) {
  // Compute chroma (12 pitch classes) by binning DFT into semitones
  const chroma = new Float32Array(12);
  const windowSize = 8192;
  const hopSize = 4096;
  let windowCount = 0;

  for (let i = 0; i < samples.length - windowSize; i += hopSize) {
    const frame = new Float32Array(windowSize);
    for (let j = 0; j < windowSize; j++) {
      const w = 0.5 * (1 - Math.cos(2 * Math.PI * j / (windowSize - 1)));
      frame[j] = samples[i + j] * w;
    }

    // DFT magnitude for relevant frequency bins
    for (let k = 1; k < windowSize / 2; k++) {
      const freq = k * sampleRate / windowSize;
      if (freq < 65 || freq > 2000) continue; // Musical range: C2 to B6

      let re = 0, im = 0;
      for (let n = 0; n < windowSize; n++) {
        const angle = -2 * Math.PI * k * n / windowSize;
        re += frame[n] * Math.cos(angle);
        im += frame[n] * Math.sin(angle);
      }
      const mag = re * re + im * im; // Squared magnitude (skip sqrt for speed)

      // Map frequency to chroma bin (0=C, 1=C#, ..., 11=B)
      const semitone = 12 * Math.log2(freq / 261.63); // Reference: middle C
      const chromaBin = ((Math.round(semitone) % 12) + 12) % 12;
      chroma[chromaBin] += mag;
    }
    windowCount++;
  }

  // Normalize chroma
  if (windowCount > 0) {
    for (let i = 0; i < 12; i++) chroma[i] /= windowCount;
  }

  // Krumhansl-Kessler key profiles
  const majorProfile = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const minorProfile = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const keys = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  let bestCorr = -Infinity;
  let bestKey = 'C';
  let bestMode = 'major';

  for (let i = 0; i < 12; i++) {
    // Rotate chroma to test key i
    const rotated = new Float32Array(12);
    for (let j = 0; j < 12; j++) {
      rotated[j] = chroma[(j + i) % 12];
    }

    const corrMaj = pearsonCorrelation(rotated, majorProfile);
    if (corrMaj > bestCorr) {
      bestCorr = corrMaj;
      bestKey = keys[i];
      bestMode = 'major';
    }

    const corrMin = pearsonCorrelation(rotated, minorProfile);
    if (corrMin > bestCorr) {
      bestCorr = corrMin;
      bestKey = keys[i];
      bestMode = 'minor';
    }
  }

  // Camelot wheel mapping
  const camelotMajor = { B: '1B', 'F#': '2B', 'C#': '3B', 'G#': '4B', 'D#': '5B', 'A#': '6B', F: '7B', C: '8B', G: '9B', D: '10B', A: '11B', E: '12B' };
  const camelotMinor = { 'G#': '1A', 'D#': '2A', 'A#': '3A', F: '4A', C: '5A', G: '6A', D: '7A', A: '8A', E: '9A', B: '10A', 'F#': '11A', 'C#': '12A' };

  const camelot = bestMode === 'major'
    ? camelotMajor[bestKey] || '?'
    : camelotMinor[bestKey] || '?';

  return { key: bestKey, mode: bestMode, camelot, confidence: bestCorr };
}

function pearsonCorrelation(x, y) {
  const n = x.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i]; sumY += y[i];
    sumXY += x[i] * y[i];
    sumX2 += x[i] * x[i];
    sumY2 += y[i] * y[i];
  }
  const num = n * sumXY - sumX * sumY;
  const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  return den === 0 ? 0 : num / den;
}

// ---- Energy profile ----

function analyzeEnergyProfile(samples, sampleRate) {
  const sectionDuration = 4; // seconds
  const sectionSamples = sectionDuration * sampleRate;

  const windowSize = 2048;
  const sections = [];

  for (let i = 0; i < samples.length; i += sectionSamples) {
    const end = Math.min(i + sectionSamples, samples.length);
    let sumSq = 0;
    for (let j = i; j < end; j++) {
      sumSq += samples[j] * samples[j];
    }
    const rms = Math.sqrt(sumSq / (end - i));

    // Simple spectral centroid for this section
    let weightedSum = 0, magSum = 0;
    const frameStart = i;
    const frameEnd = Math.min(i + windowSize, samples.length);
    for (let k = 1; k < windowSize / 4; k++) {
      let re = 0, im = 0;
      for (let n = frameStart; n < frameEnd; n++) {
        const angle = -2 * Math.PI * k * (n - frameStart) / windowSize;
        re += samples[n] * Math.cos(angle);
        im += samples[n] * Math.sin(angle);
      }
      const mag = Math.sqrt(re * re + im * im);
      const freq = k * sampleRate / windowSize;
      weightedSum += freq * mag;
      magSum += mag;
    }
    const brightness = magSum > 0 ? weightedSum / magSum : 0;

    sections.push({
      time: i / sampleRate,
      energy: rms,
      brightness,
    });
  }

  // Normalize energy
  const maxEnergy = Math.max(...sections.map(s => s.energy), 0.001);
  for (const s of sections) {
    s.energy_norm = s.energy / maxEnergy;
  }

  return sections;
}

// ---- Transition points ----

function findTransitionPoints(beats, energySections, duration) {
  if (!beats.length || !energySections.length) {
    return { mix_in: 0, mix_out: duration * 0.85, segments: [] };
  }

  const energies = energySections.map(s => s.energy_norm);
  const times = energySections.map(s => s.time);
  const avgEnergy = energies.reduce((a, b) => a + b, 0) / energies.length;

  const lowEnergyTimes = times.filter((t, i) => energies[i] < avgEnergy * 0.6);

  // Mix-in: first low-energy point in first 30% of track
  let mixIn = 0;
  for (const t of lowEnergyTimes) {
    if (t > 4 && t < duration * 0.3) {
      // Snap to nearest beat
      let nearestBeat = beats[0];
      for (const b of beats) {
        if (Math.abs(b - t) < Math.abs(nearestBeat - t)) nearestBeat = b;
      }
      mixIn = nearestBeat;
      break;
    }
  }

  // Mix-out: last low-energy point in last 40%
  let mixOut = duration * 0.85;
  for (let i = lowEnergyTimes.length - 1; i >= 0; i--) {
    const t = lowEnergyTimes[i];
    if (t > duration * 0.6 && t < duration * 0.95) {
      let nearestBeat = beats[0];
      for (const b of beats) {
        if (Math.abs(b - t) < Math.abs(nearestBeat - t)) nearestBeat = b;
      }
      mixOut = nearestBeat;
      break;
    }
  }

  // Classify segments
  const segments = energySections.map((sec, i) => {
    let type;
    if (sec.energy_norm < 0.3) type = 'breakdown';
    else if (sec.energy_norm > 0.8) type = 'peak';
    else if (i > 0 && energies[i] - energies[i - 1] > 0.3) type = 'buildup';
    else if (i > 0 && energies[i - 1] - energies[i] > 0.3) type = 'drop';
    else type = 'mid';
    return { time: sec.time, type, energy: sec.energy_norm };
  });

  return { mix_in: mixIn, mix_out: mixOut, segments };
}

// ---- Genre estimation ----

function estimateGenre(energySections) {
  const avgBrightness = energySections.reduce((s, e) => s + e.brightness, 0) / energySections.length;
  const avgEnergy = energySections.reduce((s, e) => s + e.energy, 0) / energySections.length;

  let genreHint;
  if (avgBrightness > 3000) genreHint = 'electronic/edm';
  else if (avgBrightness < 1500 && avgEnergy < 0.05) genreHint = 'ambient/chill';
  else if (avgBrightness > 2500) genreHint = 'rock/pop';
  else if (avgBrightness < 2000) genreHint = 'hip-hop/r&b';
  else genreHint = 'pop';

  return {
    genre_hint: genreHint,
    spectral_centroid: avgBrightness,
    rms_energy: avgEnergy,
  };
}

// ---- Main analysis function ----

/**
 * Analyze a single track. Returns result object (never throws).
 */
function analyzeTrack(videoId, audioDir, ytDlpBinary) {
  console.log(`Analyzing ${videoId}...`);

  try {
    const audioPath = downloadAudio(videoId, audioDir, ytDlpBinary);
    if (!audioPath) {
      return { error: `Failed to download audio for ${videoId}`, video_id: videoId };
    }

    console.log(`Loading audio for ${videoId}...`);
    const { samples, sampleRate, duration } = loadWav(audioPath);

    if (duration < 5) {
      return { error: `Audio too short (${duration.toFixed(1)}s)`, video_id: videoId };
    }

    console.log(`Detecting BPM for ${videoId}...`);
    const bpm = detectBPM(samples, sampleRate);

    console.log(`Detecting key for ${videoId}...`);
    const keyInfo = detectKey(samples, sampleRate);

    console.log(`Computing energy profile for ${videoId}...`);
    const energySections = analyzeEnergyProfile(samples, sampleRate);

    const beatInterval = 60.0 / bpm;
    const beatGrid = computeBeatGrid(samples, sampleRate, bpm);
    const transitions = findTransitionPoints(beatGrid, energySections, duration);
    const genre = estimateGenre(energySections);

    console.log(`Done: ${videoId} = ${bpm} BPM, ${keyInfo.camelot}, ${duration.toFixed(0)}s`);

    return {
      video_id: videoId,
      duration,
      bpm,
      beats: beatGrid.slice(0, 200), // First 200 detected beats
      beat_grid: beatGrid,
      beat_interval: Math.round(beatInterval * 10000) / 10000,
      key: keyInfo,
      energy_sections: energySections,
      transitions,
      genre,
      debug: {
        bpm_strategies: { onset_autocorrelation: bpm },
        chosen_strategy: 'onset_autocorrelation',
        audio_path: audioPath,
      },
    };
  } catch (err) {
    console.error(`Analysis error for ${videoId}:`, err.message);
    return { error: err.message, video_id: videoId };
  }
}

/**
 * Analyze multiple tracks.
 */
function analyzeTracks(videoIds, audioDir, ytDlpBinary) {
  const results = [];
  for (const id of videoIds) {
    const result = analyzeTrack(id, audioDir, ytDlpBinary);
    results.push(result);
    console.log(`Progress: ${results.length}/${videoIds.length}`);
  }
  return results;
}

module.exports = { analyzeTrack, analyzeTracks };
