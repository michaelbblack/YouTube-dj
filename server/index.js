const express = require('express');
const { spawn, spawnSync, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { generateAllDemoData } = require('./demo-generator');

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
    // Use spawnSync with args array to avoid shell interpretation of URL characters (?, &, etc.)
    const result = spawnSync('yt-dlp', [
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
    if (errStr.includes('proxy') || errStr.includes('Forbidden') || errStr.includes('Tunnel connection failed')) {
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
app.post('/api/analyze', (req, res) => {
  const { videoIds } = req.body;
  if (!videoIds || !videoIds.length) return res.status(400).json({ error: 'videoIds required' });

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

  // Run Python analysis with generous timeout (3 min per track)
  const timeoutMs = toAnalyze.length * 3 * 60 * 1000;
  const py = spawn('python3', [
    path.join(__dirname, 'analyze.py'),
    toAnalyze.join(','),
    AUDIO_DIR
  ], { timeout: timeoutMs });

  let stdout = '';
  let stderr = '';
  let responded = false;

  py.stdout.on('data', (data) => { stdout += data.toString(); });
  py.stderr.on('data', (data) => {
    stderr += data.toString();
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (line.trim()) console.log('[analyze]', line.trim());
    }
  });

  py.on('error', (err) => {
    if (responded) return;
    responded = true;
    console.error('Failed to start analysis:', err.message);
    res.status(500).json({ error: `Failed to start analysis: ${err.message}` });
  });

  py.on('close', (code) => {
    if (responded) return;
    responded = true;

    if (code !== 0) {
      console.error('Analysis process exited with code', code);

      // Even on failure, check if we got partial results
      let partialResults = [];
      try {
        if (stdout.trim()) partialResults = JSON.parse(stdout);
      } catch (_) {}

      if (partialResults.length > 0) {
        // Cache whatever succeeded
        for (const track of partialResults) {
          if (!track.error) {
            const cachePath = path.join(ANALYSIS_DIR, `${track.video_id}.json`);
            fs.writeFileSync(cachePath, JSON.stringify(track, null, 2));
          }
        }
        console.log(`Partial results: ${partialResults.filter(t => !t.error).length} succeeded`);
        return res.json({ tracks: [...cached, ...partialResults], partial: true });
      }

      // Complete failure - give specific error
      let errorMsg = 'Analysis failed';
      if (stderr.includes('proxy') || stderr.includes('Forbidden') || stderr.includes('Tunnel connection failed')) {
        errorMsg = 'Cannot download audio from YouTube (network/proxy blocked). Try the Offline Demo instead.';
      } else if (stderr.includes('ModuleNotFoundError') || stderr.includes('ImportError')) {
        errorMsg = 'Missing Python dependency. Run: pip install librosa numpy';
      } else if (stderr.includes('yt-dlp') || stderr.includes('Unable to download')) {
        errorMsg = 'yt-dlp failed to download audio. Try updating: pip install -U yt-dlp';
      } else if (stderr.includes('ffmpeg')) {
        errorMsg = 'ffmpeg is required for audio conversion. Install ffmpeg and try again.';
      }
      return res.status(500).json({ error: errorMsg, details: stderr.slice(-500) });
    }

    try {
      const results = JSON.parse(stdout);
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

      res.json({ tracks: [...cached, ...results] });
    } catch (err) {
      console.error('Failed to parse analysis output:', err.message, 'stdout:', stdout.slice(0, 200));
      res.status(500).json({ error: 'Failed to parse analysis results. Check server logs.' });
    }
  });
});

// Generate demo data with synthetic audio + analysis (works offline)
app.post('/api/demo', (req, res) => {
  try {
    console.log('Generating demo data...');
    const playlist = generateAllDemoData(AUDIO_DIR, ANALYSIS_DIR);

    // Load analysis data for all demo tracks
    const tracks = [];
    for (const track of playlist) {
      const analysisPath = path.join(ANALYSIS_DIR, `${track.id}.json`);
      if (fs.existsSync(analysisPath)) {
        tracks.push(JSON.parse(fs.readFileSync(analysisPath, 'utf8')));
      }
    }

    // Generate mix plan
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
