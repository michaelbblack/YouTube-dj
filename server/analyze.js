/**
 * Audio analysis pipeline for YouTube DJ — pure Node.js.
 * No Python, no librosa, no system ffmpeg needed.
 * Uses system ffmpeg (or ffmpeg-static) for conversion + custom DSP for analysis.
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

// ---- FFT Implementation (Cooley-Tukey radix-2) ----

/**
 * In-place radix-2 FFT. Arrays real/imag are modified in place.
 * n must be a power of 2.
 */
function fft(real, imag, n) {
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      let tmp = real[i]; real[i] = real[j]; real[j] = tmp;
      tmp = imag[i]; imag[i] = imag[j]; imag[j] = tmp;
    }
  }

  // Cooley-Tukey butterfly
  for (let len = 2; len <= n; len *= 2) {
    const halfLen = len / 2;
    const angle = -2 * Math.PI / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);

    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < halfLen; j++) {
        const a = i + j;
        const b = i + j + halfLen;
        const tRe = curRe * real[b] - curIm * imag[b];
        const tIm = curRe * imag[b] + curIm * real[b];
        real[b] = real[a] - tRe;
        imag[b] = imag[a] - tIm;
        real[a] += tRe;
        imag[a] += tIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/**
 * Compute magnitude spectrum using FFT. Returns Float32Array of magnitudes (first half).
 */
function fftMagnitude(frame, fftSize) {
  const real = new Float32Array(fftSize);
  const imag = new Float32Array(fftSize);
  for (let i = 0; i < frame.length && i < fftSize; i++) {
    real[i] = frame[i];
  }
  fft(real, imag, fftSize);

  const halfN = fftSize / 2;
  const mag = new Float32Array(halfN);
  for (let i = 0; i < halfN; i++) {
    mag[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
  }
  return mag;
}

// ---- Audio download & conversion ----

/**
 * Download audio from YouTube and convert to 22050Hz mono WAV (lower rate = faster analysis).
 */
function downloadAudio(videoId, audioDir, ytDlpBinary) {
  const outputPath = path.join(audioDir, `${videoId}.wav`);
  if (fs.existsSync(outputPath)) {
    // Verify file isn't empty/corrupt
    const stat = fs.statSync(outputPath);
    if (stat.size > 1000) {
      console.log(`Using cached audio for ${videoId} (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);
      return outputPath;
    }
    // Remove corrupt cache
    fs.unlinkSync(outputPath);
  }

  const tempPath = path.join(audioDir, `${videoId}_temp`);
  console.log(`Downloading audio for ${videoId}...`);

  // Verify ffmpeg is available first
  const ffCheck = spawnSync(ffmpegPath, ['-version'], { timeout: 5000 });
  if (ffCheck.status !== 0 && ffCheck.error) {
    console.error(`ffmpeg not found at ${ffmpegPath}:`, ffCheck.error?.message);
    return { error: `ffmpeg not available: ${ffCheck.error?.message}` };
  }
  console.log(`Using ffmpeg: ${ffmpegPath}`);

  // Download best audio with ffmpeg location specified
  const ffmpegDir = path.dirname(ffmpegPath === 'ffmpeg' ? '/usr/bin/ffmpeg' : ffmpegPath);
  const dlArgs = [
    '-x',
    '--audio-quality', '0',
    '--no-check-certificates',
    '--no-playlist',
    '--retries', '3',
    '--socket-timeout', '30',
    '--verbose',
    '-o', `${tempPath}.%(ext)s`,
    `https://www.youtube.com/watch?v=${videoId}`
  ];
  // Only add --ffmpeg-location if ffmpeg isn't on system PATH
  if (ffmpegPath !== 'ffmpeg') {
    dlArgs.splice(0, 0, '--ffmpeg-location', ffmpegDir);
  }

  console.log(`Running: ${ytDlpBinary} ${dlArgs.join(' ')}`);
  const dlResult = spawnSync(ytDlpBinary, dlArgs, {
    timeout: 300000, // 5 minutes per track
    maxBuffer: 10 * 1024 * 1024,
  });

  const dlStdout = dlResult.stdout?.toString() || '';
  const dlStderr = dlResult.stderr?.toString() || '';

  if (dlStdout) console.log(`yt-dlp stdout for ${videoId}:`, dlStdout.slice(-500));
  if (dlStderr) console.log(`yt-dlp stderr for ${videoId}:`, dlStderr.slice(-500));

  if (dlResult.error) {
    console.error(`yt-dlp spawn error for ${videoId}:`, dlResult.error.message);
    cleanupTemp(tempPath);
    return { error: `yt-dlp spawn error: ${dlResult.error.message}` };
  }

  if (dlResult.status !== 0) {
    const combined = dlStdout + dlStderr;
    console.error(`yt-dlp exited ${dlResult.status} for ${videoId}`);
    cleanupTemp(tempPath);
    return { error: `yt-dlp failed (exit ${dlResult.status}): ${combined.slice(-300)}` };
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
    try {
      const files = fs.readdirSync(dir).filter(f => f.startsWith(base));
      if (files.length > 0) {
        srcFile = path.join(dir, files[0]);
        console.log(`Found audio via glob: ${srcFile}`);
      }
    } catch {}
  }

  if (!srcFile) {
    // List audio_cache to help debug
    try {
      const dir = path.dirname(tempPath);
      const allFiles = fs.readdirSync(dir);
      console.error(`No audio file found for ${videoId}. Files in ${dir}:`, allFiles.slice(0, 20));
    } catch {}
    return { error: `No audio file found after download for ${videoId}` };
  }

  console.log(`Downloaded: ${srcFile} (${(fs.statSync(srcFile).size / 1024).toFixed(0)}KB)`);

  // Convert to mono 22050Hz WAV (lower sample rate = faster analysis, fine for BPM/key)
  if (srcFile !== outputPath) {
    console.log(`Converting to WAV for ${videoId}...`);
    const ffResult = spawnSync(ffmpegPath, [
      '-i', srcFile, '-ar', '22050', '-ac', '1', '-y', outputPath
    ], { timeout: 120000 });

    // Clean up source file
    try { fs.unlinkSync(srcFile); } catch {}

    if (ffResult.status !== 0 || ffResult.error) {
      const ffErr = ffResult.stderr?.toString() || ffResult.error?.message || 'unknown';
      console.error(`ffmpeg error for ${videoId}:`, ffErr.slice(0, 300));
      return { error: `ffmpeg conversion failed: ${ffErr.slice(0, 200)}` };
    }
  }

  if (!fs.existsSync(outputPath)) {
    return { error: 'WAV file not created after conversion' };
  }

  const size = fs.statSync(outputPath).size;
  console.log(`Converted: ${outputPath} (${(size / 1024 / 1024).toFixed(1)}MB)`);
  return outputPath;
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
    samples: decoded.channelData[0],
    sampleRate: decoded.sampleRate,
    duration: decoded.channelData[0].length / decoded.sampleRate,
  };
}

// ---- BPM detection ----

/**
 * Detect BPM using onset strength autocorrelation (FFT-based).
 */
function detectBPM(samples, sampleRate) {
  const hopSize = 512;
  const fftSize = 1024;
  const halfN = fftSize / 2;

  // Compute onset strength (spectral flux) using FFT
  const onsetStrength = [];
  let prevMag = null;
  const hannWindow = new Float32Array(fftSize);
  for (let j = 0; j < fftSize; j++) {
    hannWindow[j] = 0.5 * (1 - Math.cos(2 * Math.PI * j / (fftSize - 1)));
  }

  for (let i = 0; i < samples.length - fftSize; i += hopSize) {
    const frame = new Float32Array(fftSize);
    for (let j = 0; j < fftSize; j++) {
      frame[j] = (samples[i + j] || 0) * hannWindow[j];
    }

    const mag = fftMagnitude(frame, fftSize);

    if (prevMag) {
      let flux = 0;
      for (let k = 0; k < halfN; k++) {
        const diff = mag[k] - prevMag[k];
        if (diff > 0) flux += diff;
      }
      onsetStrength.push(flux);
    } else {
      onsetStrength.push(0);
    }
    prevMag = mag;
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
    const limit = Math.min(N - lag, 2000); // Cap correlation length for speed
    for (let i = 0; i < limit; i++) {
      corr += onsetStrength[i] * onsetStrength[i + lag];
    }
    corr /= limit;

    const bpm = (onsetRate * 60) / lag;
    if (corr > bestCorr) {
      bestCorr = corr;
      bestBPM = bpm;
    }
  }

  // Check double/half to pick the most common octave
  const candidates = [bestBPM, bestBPM * 2, bestBPM / 2].filter(b => b >= 70 && b <= 180);
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
 * Detect musical key using chroma features (FFT-based) and Krumhansl-Kessler profiles.
 */
function detectKey(samples, sampleRate) {
  const chroma = new Float32Array(12);
  const fftSize = 4096; // Power of 2 for FFT
  const hopSize = fftSize; // Non-overlapping for speed
  let windowCount = 0;

  const hannWindow = new Float32Array(fftSize);
  for (let j = 0; j < fftSize; j++) {
    hannWindow[j] = 0.5 * (1 - Math.cos(2 * Math.PI * j / (fftSize - 1)));
  }

  for (let i = 0; i < samples.length - fftSize; i += hopSize) {
    const frame = new Float32Array(fftSize);
    for (let j = 0; j < fftSize; j++) {
      frame[j] = samples[i + j] * hannWindow[j];
    }

    const mag = fftMagnitude(frame, fftSize);

    // Map FFT bins to chroma
    for (let k = 1; k < fftSize / 2; k++) {
      const freq = k * sampleRate / fftSize;
      if (freq < 65 || freq > 2000) continue;

      const semitone = 12 * Math.log2(freq / 261.63);
      const chromaBin = ((Math.round(semitone) % 12) + 12) % 12;
      chroma[chromaBin] += mag[k] * mag[k]; // Use power spectrum
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
  const fftSize = 2048;

  const hannWindow = new Float32Array(fftSize);
  for (let j = 0; j < fftSize; j++) {
    hannWindow[j] = 0.5 * (1 - Math.cos(2 * Math.PI * j / (fftSize - 1)));
  }

  const sections = [];

  for (let i = 0; i < samples.length; i += sectionSamples) {
    const end = Math.min(i + sectionSamples, samples.length);
    let sumSq = 0;
    for (let j = i; j < end; j++) {
      sumSq += samples[j] * samples[j];
    }
    const rms = Math.sqrt(sumSq / (end - i));

    // Spectral centroid for brightness using FFT
    const frameEnd = Math.min(i + fftSize, samples.length);
    const frame = new Float32Array(fftSize);
    for (let j = 0; j < frameEnd - i && j < fftSize; j++) {
      frame[j] = samples[i + j] * hannWindow[j];
    }
    const mag = fftMagnitude(frame, fftSize);

    let weightedSum = 0, magSum = 0;
    for (let k = 1; k < fftSize / 2; k++) {
      const freq = k * sampleRate / fftSize;
      weightedSum += freq * mag[k];
      magSum += mag[k];
    }
    const brightness = magSum > 0 ? weightedSum / magSum : 0;

    sections.push({ time: i / sampleRate, energy: rms, brightness });
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

  let mixIn = 0;
  for (const t of lowEnergyTimes) {
    if (t > 4 && t < duration * 0.3) {
      let nearestBeat = beats[0];
      for (const b of beats) {
        if (Math.abs(b - t) < Math.abs(nearestBeat - t)) nearestBeat = b;
      }
      mixIn = nearestBeat;
      break;
    }
  }

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

  return { genre_hint: genreHint, spectral_centroid: avgBrightness, rms_energy: avgEnergy };
}

// ---- Main analysis function ----

/**
 * Analyze a single track. Returns result object (never throws).
 */
function analyzeTrack(videoId, audioDir, ytDlpBinary) {
  console.log(`Analyzing ${videoId}...`);

  try {
    const audioResult = downloadAudio(videoId, audioDir, ytDlpBinary);

    // downloadAudio returns string path on success, or { error } on failure
    if (!audioResult || typeof audioResult === 'object') {
      const errMsg = audioResult?.error || `Failed to download audio for ${videoId}`;
      console.error(`Download failed for ${videoId}: ${errMsg}`);
      return { error: errMsg, video_id: videoId };
    }

    const audioPath = audioResult;
    console.log(`Loading audio for ${videoId}...`);
    const { samples, sampleRate, duration } = loadWav(audioPath);

    if (duration < 5) {
      return { error: `Audio too short (${duration.toFixed(1)}s)`, video_id: videoId };
    }

    console.log(`Detecting BPM for ${videoId} (${duration.toFixed(0)}s @ ${sampleRate}Hz)...`);
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
      beats: beatGrid.slice(0, 200),
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
 * Analyze multiple tracks asynchronously (doesn't block event loop).
 * Returns a Promise that resolves with results array.
 */
function analyzeTracks(videoIds, audioDir, ytDlpBinary) {
  return new Promise((resolve) => {
    const results = [];
    let index = 0;

    function next() {
      if (index >= videoIds.length) {
        resolve(results);
        return;
      }

      const id = videoIds[index++];
      const result = analyzeTrack(id, audioDir, ytDlpBinary);
      results.push(result);
      console.log(`Progress: ${results.length}/${videoIds.length}`);

      // Yield to event loop between tracks so HTTP responses can flow
      setImmediate(next);
    }

    // Start on next tick so the caller can set up response handling
    setImmediate(next);
  });
}

module.exports = { analyzeTrack, analyzeTracks };
