const express = require('express');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const AUDIO_DIR = path.join(__dirname, '..', 'audio_cache');
const ANALYSIS_DIR = path.join(__dirname, '..', 'analysis_cache');
fs.mkdirSync(AUDIO_DIR, { recursive: true });
fs.mkdirSync(ANALYSIS_DIR, { recursive: true });

// Extract video IDs from a YouTube playlist URL
app.post('/api/playlist', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    // Use yt-dlp to get playlist info
    const result = execSync(
      `yt-dlp --flat-playlist -J "${url}"`,
      { timeout: 60000, maxBuffer: 10 * 1024 * 1024 }
    );
    const data = JSON.parse(result.toString());

    const videos = (data.entries || []).map(entry => ({
      id: entry.id || entry.url,
      title: entry.title || 'Unknown',
      duration: entry.duration || 0,
      thumbnail: entry.thumbnails?.[0]?.url || `https://img.youtube.com/vi/${entry.id}/mqdefault.jpg`
    }));

    res.json({ title: data.title || 'Playlist', videos });
  } catch (err) {
    console.error('Playlist extraction error:', err.message);
    res.status(500).json({ error: 'Failed to extract playlist. Check the URL.' });
  }
});

// Analyze tracks - returns analysis results with BPM, key, beats etc.
app.post('/api/analyze', (req, res) => {
  const { videoIds } = req.body;
  if (!videoIds || !videoIds.length) return res.status(400).json({ error: 'videoIds required' });

  // Check cache first
  const cached = [];
  const toAnalyze = [];
  for (const id of videoIds) {
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

  // Run Python analysis
  const py = spawn('python3', [
    path.join(__dirname, 'analyze.py'),
    toAnalyze.join(','),
    AUDIO_DIR
  ]);

  let stdout = '';
  let stderr = '';

  py.stdout.on('data', (data) => { stdout += data.toString(); });
  py.stderr.on('data', (data) => {
    stderr += data.toString();
    // Try to parse progress updates
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (line.trim()) console.log('[analyze]', line.trim());
    }
  });

  py.on('close', (code) => {
    if (code !== 0) {
      console.error('Analysis failed:', stderr);
      return res.status(500).json({ error: 'Analysis failed', details: stderr });
    }

    try {
      const results = JSON.parse(stdout);
      // Cache results
      for (const track of results) {
        if (!track.error) {
          const cachePath = path.join(ANALYSIS_DIR, `${track.video_id}.json`);
          fs.writeFileSync(cachePath, JSON.stringify(track, null, 2));
        }
      }
      res.json({ tracks: [...cached, ...results] });
    } catch (err) {
      res.status(500).json({ error: 'Failed to parse analysis results' });
    }
  });
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
    // Support range requests for seeking
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
  // Sort tracks for optimal mixing order considering BPM progression and key compatibility
  const ordered = orderTracksForMix(tracks);

  // Generate transitions between consecutive tracks
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

  // Greedy nearest-neighbor ordering based on BPM + key compatibility
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
      // Score: lower is better. BPM matters most, key is a bonus.
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
  if (num1 === num2 && letter1 !== letter2) return 0.85; // Relative major/minor
  if (Math.abs(num1 - num2) <= 2 || Math.abs(num1 - num2) >= 10) return 0.6;
  return 0.3;
}

function planTransition(from, to) {
  const bpmDiff = Math.abs(from.bpm - to.bpm);
  const bpmRatio = from.bpm / to.bpm;

  // With Web Audio API, we can use arbitrary playback rates (not limited to YouTube's discrete set).
  // Calculate the exact rate needed for perfect BPM matching.
  const exactRate = from.bpm / to.bpm;
  // Clamp to reasonable range where pitch artifacts aren't too noticeable
  const clampedRate = Math.max(0.5, Math.min(2.0, exactRate));
  const effectiveBpm = to.bpm * clampedRate;
  const rateError = Math.abs(effectiveBpm - from.bpm) / from.bpm;
  const canTempoMatch = rateError < 0.001; // Essentially perfect with arbitrary rates

  // Determine transition type
  let type, duration, technique;

  if (bpmDiff < 3) {
    // Very close BPMs - long smooth blend
    type = 'smooth';
    duration = 16; // 16 beats
    technique = 'crossfade with beat sync';
  } else if (bpmDiff < 12 && canTempoMatch) {
    // Moderate difference - precise tempo match via Web Audio playbackRate
    type = 'blend';
    duration = 12;
    technique = `beat-matched crossfade (rate=${clampedRate.toFixed(4)})`;
  } else if ((bpmRatio > 1.9 && bpmRatio < 2.1) || (bpmRatio > 0.48 && bpmRatio < 0.52)) {
    // Double/half time relationship
    type = 'double-time';
    duration = 8;
    technique = 'half-time blend';
  } else if (bpmDiff < 20) {
    // Larger difference but still blendable with rate adjustment
    type = 'blend';
    duration = 6;
    technique = `tempo-shifted crossfade (rate=${clampedRate.toFixed(4)})`;
  } else {
    // Very large difference - hard cut on a downbeat
    type = 'cut';
    duration = 1;
    technique = 'hard cut on downbeat';
  }

  // Find best transition point
  const outPoint = from.transitions?.mix_out || from.duration * 0.85;
  const inPoint = to.transitions?.mix_in || 0;

  // Calculate beat-aligned start/end
  const fromBeatInterval = 60 / from.bpm;
  const toBeatInterval = 60 / to.bpm;
  const transitionBeats = duration;

  // Snap outPoint to nearest beat grid position
  let snapOut = outPoint;
  if (from.beat_grid && from.beat_grid.length > 0) {
    const nearest = from.beat_grid.reduce((a, b) =>
      Math.abs(b - outPoint) < Math.abs(a - outPoint) ? b : a
    );
    // Snap to a downbeat (every 4 beats)
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`YouTube DJ server running on http://localhost:${PORT}`);
});
