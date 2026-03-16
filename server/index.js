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

  // YouTube only supports these discrete playback rates
  const YOUTUBE_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  // Check if tempo matching is feasible with YouTube's discrete rates
  const idealRate = from.bpm / to.bpm;
  const bestRate = YOUTUBE_RATES.reduce((best, rate) =>
    Math.abs(rate - idealRate) < Math.abs(best - idealRate) ? rate : best
  );
  const rateError = Math.abs((to.bpm * bestRate) - from.bpm) / from.bpm;
  const canTempoMatch = rateError < 0.04; // Within 4%

  // Determine transition type
  let type, duration, technique;

  if (bpmDiff < 3) {
    // Very close BPMs - long smooth blend (no rate change needed)
    type = 'smooth';
    duration = 16; // 16 beats
    technique = 'crossfade with beat sync';
  } else if (bpmDiff < 8 && canTempoMatch) {
    // Moderate difference but rate-matchable - blend with tempo adjustment
    type = 'blend';
    duration = 8;
    technique = `crossfade with tempo shift (rate=${bestRate})`;
  } else if ((bpmRatio > 1.9 && bpmRatio < 2.1) || (bpmRatio > 0.48 && bpmRatio < 0.52)) {
    // Double/half time relationship
    type = 'double-time';
    duration = 8;
    technique = 'half-time blend';
  } else if (bpmDiff < 15) {
    // Moderate difference, can't rate-match - shorter crossfade to mask it
    type = 'blend';
    duration = 4;
    technique = 'quick crossfade (tempo mismatch too large for rate adjust)';
  } else {
    // Large difference - hard cut on a downbeat
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
