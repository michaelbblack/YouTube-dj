const express = require('express');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const YTDlpWrap = require('yt-dlp-wrap-plus').default || require('yt-dlp-wrap-plus');
const { generateAllDemoData } = require('./demo-generator');
const { analyzeTracks } = require('./analyze');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const AUDIO_DIR = path.join(__dirname, '..', 'audio_cache');
const ANALYSIS_DIR = path.join(__dirname, '..', 'analysis_cache');
const BIN_DIR = path.join(__dirname, '..', 'bin');
fs.mkdirSync(AUDIO_DIR, { recursive: true });
fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
fs.mkdirSync(BIN_DIR, { recursive: true });

// yt-dlp binary path (managed by yt-dlp-wrap-plus)
const YT_DLP_PATH = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
let ytdlp = null;  // YTDlpWrap instance, set after ensureYtDlp()

/**
 * Ensure yt-dlp binary is available. Downloads if missing.
 */
async function ensureYtDlp() {
  // Check if system yt-dlp exists first
  const systemCheck = spawnSync('yt-dlp', ['--version'], { timeout: 5000 });
  if (systemCheck.status === 0) {
    const version = systemCheck.stdout.toString().trim();
    console.log(`Using system yt-dlp: ${version}`);
    ytdlp = new YTDlpWrap('yt-dlp');
    return 'yt-dlp';
  }

  // Check if we already downloaded it
  if (fs.existsSync(YT_DLP_PATH)) {
    const check = spawnSync(YT_DLP_PATH, ['--version'], { timeout: 5000 });
    if (check.status === 0) {
      const version = check.stdout.toString().trim();
      console.log(`Using local yt-dlp: ${version} (${YT_DLP_PATH})`);
      ytdlp = new YTDlpWrap(YT_DLP_PATH);
      return YT_DLP_PATH;
    }
  }

  // Download yt-dlp binary from GitHub
  console.log('yt-dlp not found. Downloading from GitHub...');
  try {
    await YTDlpWrap.downloadFromGithub(YT_DLP_PATH);
    // Make executable on Unix
    if (process.platform !== 'win32') {
      fs.chmodSync(YT_DLP_PATH, 0o755);
    }
    const check = spawnSync(YT_DLP_PATH, ['--version'], { timeout: 5000 });
    const version = check.stdout?.toString().trim() || 'unknown';
    console.log(`Downloaded yt-dlp ${version} to ${YT_DLP_PATH}`);
    ytdlp = new YTDlpWrap(YT_DLP_PATH);
    return YT_DLP_PATH;
  } catch (err) {
    console.error('Failed to download yt-dlp:', err.message);
    throw new Error('yt-dlp is not installed and auto-download failed. Install manually: pip install yt-dlp');
  }
}

/**
 * Get the path to the yt-dlp binary.
 */
function getYtDlpBinaryPath() {
  return ytdlp?.getBinaryPath() || 'yt-dlp';
}

// Extract video IDs from a YouTube playlist URL
app.post('/api/playlist', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  if (!ytdlp) {
    return res.status(503).json({ error: 'yt-dlp is still initializing. Try again in a moment.' });
  }

  try {
    // Use the managed yt-dlp binary via spawnSync with args array
    const binaryPath = getYtDlpBinaryPath();
    const result = spawnSync(binaryPath, [
      '--flat-playlist', '-J',
      '--no-check-certificates',
      '--no-warnings',
      url
    ], { timeout: 60000, maxBuffer: 10 * 1024 * 1024 });

    if (result.error) {
      throw result.error;
    }

    const stderr = result.stderr?.toString() || '';
    if (result.status !== 0) {
      throw new Error(stderr || `yt-dlp exited with code ${result.status}`);
    }

    const data = JSON.parse(result.stdout.toString());

    const videos = (data.entries || []).map(entry => ({
      id: entry.id || entry.url,
      title: entry.title || 'Unknown',
      duration: entry.duration || 0,
      thumbnail: entry.thumbnails?.[0]?.url || `https://img.youtube.com/vi/${entry.id || entry.url}/mqdefault.jpg`
    }));

    if (videos.length === 0) {
      return res.status(400).json({ error: 'No videos found in playlist. Check the URL.' });
    }

    res.json({ title: data.title || 'Playlist', videos });
  } catch (err) {
    const errMsg = err.message || '';
    const errStr = err.stderr?.toString?.() || errMsg;
    console.error('Playlist extraction error:', errStr);

    let errorMsg;
    if (errStr.includes('ENOENT')) {
      errorMsg = 'yt-dlp binary not found. Server is downloading it — restart and try again.';
    } else if (errStr.includes('proxy') || errStr.includes('Forbidden') || errStr.includes('Tunnel connection failed')) {
      errorMsg = 'Cannot reach YouTube (network/proxy blocked). Try the Offline Demo instead.';
    } else if (errStr.includes('not a valid URL') || errStr.includes('Unsupported URL')) {
      errorMsg = 'Invalid URL. Paste a YouTube playlist URL (e.g. https://www.youtube.com/playlist?list=...).';
    } else if (errStr.includes('Private') || errStr.includes('unavailable')) {
      errorMsg = 'This playlist is private or unavailable.';
    } else {
      errorMsg = `Failed to load playlist: ${errStr.slice(0, 200)}`;
    }
    res.status(500).json({ error: errorMsg });
  }
});

// Analyze tracks - returns analysis results with BPM, key, beats etc.
app.post('/api/analyze', async (req, res) => {
  const { videoIds } = req.body;
  if (!videoIds || !videoIds.length) return res.status(400).json({ error: 'videoIds required' });

  if (!ytdlp) {
    return res.status(503).json({ error: 'yt-dlp is still initializing. Try again in a moment.' });
  }

  // Check cache first
  const cached = [];
  const toAnalyze = [];
  for (const id of videoIds) {
    // Sanitize video ID (only allow alphanumeric, -, _)
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) continue;
    const cachePath = path.join(ANALYSIS_DIR, `${id}.json`);
    if (fs.existsSync(cachePath)) {
      cached.push(JSON.parse(fs.readFileSync(cachePath, 'utf8')));
    } else {
      toAnalyze.push(id);
    }
  }

  if (toAnalyze.length === 0) {
    return res.json({ tracks: cached });
  }

  console.log(`Analyzing ${toAnalyze.length} tracks (${cached.length} cached)...`);

  try {
    const binaryPath = getYtDlpBinaryPath();
    const results = analyzeTracks(toAnalyze, AUDIO_DIR, binaryPath);

    const succeeded = results.filter(t => !t.error);
    const failed = results.filter(t => t.error);

    // Cache successful results
    for (const track of succeeded) {
      const cachePath = path.join(ANALYSIS_DIR, `${track.video_id}.json`);
      fs.writeFileSync(cachePath, JSON.stringify(track, null, 2));
    }

    if (failed.length > 0) {
      console.warn(`${failed.length} tracks failed analysis:`,
        failed.map(t => `${t.video_id}: ${t.error}`).join('; '));
    }

    console.log(`Analysis complete: ${succeeded.length} succeeded, ${failed.length} failed`);
    res.json({ tracks: [...cached, ...results], partial: failed.length > 0 });
  } catch (err) {
    console.error('Analysis error:', err.message);

    let errorMsg = 'Analysis failed';
    const errStr = err.message || '';
    if (errStr.includes('proxy') || errStr.includes('Forbidden') || errStr.includes('Tunnel connection failed')) {
      errorMsg = 'Cannot download audio from YouTube (network/proxy blocked). Try the Offline Demo instead.';
    } else if (errStr.includes('ENOENT')) {
      errorMsg = 'yt-dlp or ffmpeg binary not found. Restart the server to trigger auto-download.';
    } else if (errStr.includes('Unable to download')) {
      errorMsg = 'yt-dlp failed to download audio. Check your internet connection.';
    } else {
      errorMsg = `Analysis failed: ${errStr.slice(0, 300)}`;
    }
    res.status(500).json({ error: errorMsg });
  }
});

// Generate demo data with synthetic audio + analysis (works offline)
app.post('/api/demo', (req, res) => {
  try {
    console.log('Generating demo data...');
    const playlist = generateAllDemoData(AUDIO_DIR, ANALYSIS_DIR);

    const tracks = [];
    for (const track of playlist) {
      const analysisPath = path.join(ANALYSIS_DIR, `${track.id}.json`);
      if (fs.existsSync(analysisPath)) {
        tracks.push(JSON.parse(fs.readFileSync(analysisPath, 'utf8')));
      }
    }

    const plan = generateMixPlan(tracks);
    res.json({ playlist, tracks, plan });
    console.log(`Demo data ready: ${playlist.length} synthetic tracks`);
  } catch (err) {
    console.error('Demo generation error:', err);
    res.status(500).json({ error: 'Failed to generate demo data: ' + err.message });
  }
});

// Serve cached audio files for Web Audio API playback
app.get('/api/audio/:videoId', (req, res) => {
  const videoId = req.params.videoId.replace(/[^a-zA-Z0-9_-]/g, '');
  const wavPath = path.join(AUDIO_DIR, `${videoId}.wav`);

  if (!fs.existsSync(wavPath)) {
    return res.status(404).json({ error: 'Audio not found. Analyze the track first.' });
  }

  const stat = fs.statSync(wavPath);
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'audio/wav',
    });
    fs.createReadStream(wavPath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': 'audio/wav',
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(wavPath).pipe(res);
  }
});

// Get cached analysis for a single track
app.get('/api/analysis/:videoId', (req, res) => {
  const cachePath = path.join(ANALYSIS_DIR, `${req.params.videoId}.json`);
  if (fs.existsSync(cachePath)) {
    res.json(JSON.parse(fs.readFileSync(cachePath, 'utf8')));
  } else {
    res.status(404).json({ error: 'Not analyzed yet' });
  }
});

// Generate mix plan from analyzed tracks
app.post('/api/mixplan', (req, res) => {
  const { tracks } = req.body;
  if (!tracks || tracks.length < 2) {
    return res.status(400).json({ error: 'Need at least 2 tracks' });
  }

  const plan = generateMixPlan(tracks);
  res.json(plan);
});

function generateMixPlan(tracks) {
  const ordered = orderTracksForMix(tracks);

  const transitions = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    const from = ordered[i];
    const to = ordered[i + 1];
    transitions.push(planTransition(from, to));
  }

  return { order: ordered.map(t => t.video_id), transitions };
}

function orderTracksForMix(tracks) {
  if (tracks.length <= 2) return tracks;

  const remaining = [...tracks];
  const ordered = [remaining.shift()];

  while (remaining.length > 0) {
    const last = ordered[ordered.length - 1];
    let bestIdx = 0;
    let bestScore = Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const bpmDiff = Math.abs(last.bpm - candidate.bpm);
      const keyCompat = keyCompatibility(last.key?.camelot, candidate.key?.camelot);
      const score = bpmDiff * 2 + (1 - keyCompat) * 10;
      if (score < bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    ordered.push(remaining.splice(bestIdx, 1)[0]);
  }

  return ordered;
}

function keyCompatibility(camelot1, camelot2) {
  if (!camelot1 || !camelot2) return 0.5;

  const num1 = parseInt(camelot1);
  const num2 = parseInt(camelot2);
  const letter1 = camelot1.slice(-1);
  const letter2 = camelot2.slice(-1);

  if (camelot1 === camelot2) return 1.0;
  if (letter1 === letter2 && (Math.abs(num1 - num2) === 1 || Math.abs(num1 - num2) === 11)) return 0.9;
  if (num1 === num2 && letter1 !== letter2) return 0.85;
  if (Math.abs(num1 - num2) <= 2 || Math.abs(num1 - num2) >= 10) return 0.6;
  return 0.3;
}

function planTransition(from, to) {
  const bpmDiff = Math.abs(from.bpm - to.bpm);
  const bpmRatio = from.bpm / to.bpm;

  const exactRate = from.bpm / to.bpm;
  const clampedRate = Math.max(0.5, Math.min(2.0, exactRate));
  const effectiveBpm = to.bpm * clampedRate;
  const rateError = Math.abs(effectiveBpm - from.bpm) / from.bpm;
  const canTempoMatch = rateError < 0.001;

  let type, duration, technique;

  if (bpmDiff < 3) {
    type = 'smooth';
    duration = 16;
    technique = 'crossfade with beat sync';
  } else if (bpmDiff < 12 && canTempoMatch) {
    type = 'blend';
    duration = 12;
    technique = `beat-matched crossfade (rate=${clampedRate.toFixed(4)})`;
  } else if ((bpmRatio > 1.9 && bpmRatio < 2.1) || (bpmRatio > 0.48 && bpmRatio < 0.52)) {
    type = 'double-time';
    duration = 8;
    technique = 'half-time blend';
  } else if (bpmDiff < 20) {
    type = 'blend';
    duration = 6;
    technique = `tempo-shifted crossfade (rate=${clampedRate.toFixed(4)})`;
  } else {
    type = 'cut';
    duration = 1;
    technique = 'hard cut on downbeat';
  }

  const outPoint = from.transitions?.mix_out || from.duration * 0.85;
  const inPoint = to.transitions?.mix_in || 0;
  const fromBeatInterval = 60 / from.bpm;
  const transitionBeats = duration;

  let snapOut = outPoint;
  if (from.beat_grid && from.beat_grid.length > 0) {
    const nearest = from.beat_grid.reduce((a, b) =>
      Math.abs(b - outPoint) < Math.abs(a - outPoint) ? b : a
    );
    const beatIdx = from.beat_grid.indexOf(nearest);
    const downbeatIdx = Math.round(beatIdx / 4) * 4;
    snapOut = from.beat_grid[Math.min(downbeatIdx, from.beat_grid.length - 1)];
  }

  let snapIn = inPoint;
  if (to.beat_grid && to.beat_grid.length > 0) {
    const nearest = to.beat_grid.reduce((a, b) =>
      Math.abs(b - inPoint) < Math.abs(a - inPoint) ? b : a
    );
    const beatIdx = to.beat_grid.indexOf(nearest);
    const downbeatIdx = Math.round(beatIdx / 4) * 4;
    snapIn = to.beat_grid[Math.min(downbeatIdx, to.beat_grid.length - 1)];
  }

  return {
    from: from.video_id,
    to: to.video_id,
    type,
    technique,
    transitionBeats,
    fromOutPoint: snapOut,
    toInPoint: snapIn,
    fromBpm: from.bpm,
    toBpm: to.bpm,
    bpmDiff,
    keyCompat: keyCompatibility(from.key?.camelot, to.key?.camelot),
    crossfadeDuration: transitionBeats * fromBeatInterval,
  };
}

// ---- Server startup ----
const PORT = process.env.PORT || 3000;

async function start() {
  try {
    const binaryPath = await ensureYtDlp();
    console.log(`yt-dlp ready: ${binaryPath}`);
  } catch (err) {
    console.warn(`WARNING: ${err.message}`);
    console.warn('YouTube playlist loading and analysis will not work.');
    console.warn('The Offline Demo will still work.');
  }

  app.listen(PORT, () => {
    console.log(`YouTube DJ server running on http://localhost:${PORT} (pure Node.js — no Python)`);
  });
}

start();
