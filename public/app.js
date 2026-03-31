/**
 * YouTube DJ - Main Application (Hybrid Audio Mode)
 * Ties together the DJ engine, YouTube players, AudioDecks, and UI.
 */

let engine;
let debug;
let playlist = [];
let analysisData = {};
let ytReady = false;

// Waveform rendering contexts
let waveformCtx = { a: null, b: null };

// YouTube IFrame API callback
function onYouTubeIframeAPIReady() {
  ytReady = true;
  initPlayers();
}

function initPlayers() {
  if (!ytReady) return;

  const playerA = new YT.Player('player-a', {
    height: '100%',
    width: '100%',
    playerVars: {
      autoplay: 0,
      controls: 0,
      disablekb: 1,
      modestbranding: 1,
      rel: 0,
    },
    events: {
      onReady: () => {
        engine.setPlayer('a', playerA);
        setStatus('Players ready (hybrid audio mode)');
      },
      onStateChange: (e) => onPlayerStateChange('a', e),
    }
  });

  const playerB = new YT.Player('player-b', {
    height: '100%',
    width: '100%',
    playerVars: {
      autoplay: 0,
      controls: 0,
      disablekb: 1,
      modestbranding: 1,
      rel: 0,
    },
    events: {
      onReady: () => {
        engine.setPlayer('b', playerB);
      },
      onStateChange: (e) => onPlayerStateChange('b', e),
    }
  });
}

function onPlayerStateChange(deck, event) {
  const states = { '-1': 'unstarted', 0: 'ended', 1: 'playing', 2: 'paused', 3: 'buffering', 5: 'cued' };
  debug.log({ time: new Date().toISOString(), type: 'info', message: `Deck ${deck.toUpperCase()} video state: ${states[event.data] || event.data}` });
}

// Initialize engine and debug tools
engine = new DJEngine();
debug = new DebugTools(engine);

engine.onLog = (entry) => debug.log(entry);
engine.onUpdate = (event, data) => {
  switch (event) {
    case 'load':
      updateDeckUI(data.deck, data.track);
      break;
    case 'beat':
      flashBeat(data.deck, data.isDownbeat);
      break;
    case 'crossfade':
      document.getElementById('crossfader').value = data.crossfade;
      break;
    case 'transition-start':
      document.getElementById('transition-type').textContent =
        `${data.transition.type}: ${data.transition.technique}`;
      break;
    case 'transition-complete':
      document.getElementById('transition-type').textContent = 'Ready';
      updateTrackListHighlights(data.queueIndex);
      break;
    case 'automix-start':
      document.getElementById('automix-btn').classList.add('active');
      document.getElementById('automix-btn').textContent = 'MIXING...';
      break;
    case 'automix-stop':
      document.getElementById('automix-btn').classList.remove('active');
      document.getElementById('automix-btn').textContent = 'AUTO MIX';
      break;
  }
};

engine.init();
debug.init();

// Set up waveform canvases
function initWaveformCanvases() {
  for (const deck of ['a', 'b']) {
    const canvas = document.getElementById(`waveform-${deck}`);
    if (canvas) {
      waveformCtx[deck] = canvas.getContext('2d');
    }
  }
}

// Render real-time waveform from AnalyserNode
function renderWaveform(deck) {
  const ctx = waveformCtx[deck];
  const audioDeck = engine.audioDecks[deck];
  if (!ctx || !audioDeck?.isPlaying()) {
    // Clear canvas if not playing
    if (ctx) {
      const canvas = ctx.canvas;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    return;
  }

  const canvas = ctx.canvas;
  const data = audioDeck.getWaveformData();
  const bufferLength = data.length;

  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const color = deck === 'a' ? '#58a6ff' : '#e94560';
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = color;
  ctx.beginPath();

  const sliceWidth = canvas.width / bufferLength;
  let x = 0;

  for (let i = 0; i < bufferLength; i++) {
    const v = data[i] / 128.0;
    const y = (v * canvas.height) / 2;

    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
    x += sliceWidth;
  }

  ctx.lineTo(canvas.width, canvas.height / 2);
  ctx.stroke();

  // Draw center line
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(0, canvas.height / 2);
  ctx.lineTo(canvas.width, canvas.height / 2);
  ctx.stroke();
}

// Update level meter
function updateLevelMeter(deck) {
  const audioDeck = engine.audioDecks[deck];
  const el = document.getElementById(`level-${deck}`);
  if (!el || !audioDeck) return;

  if (audioDeck.isPlaying()) {
    const rms = audioDeck.getRMSLevel();
    // Scale RMS (typically 0-0.5) to percentage
    const pct = Math.min(100, rms * 300);
    el.style.height = `${pct}%`;
  } else {
    el.style.height = '0%';
  }
}

// UI update loop (uses audio timing, not YouTube)
setInterval(() => {
  for (const deck of ['a', 'b']) {
    const audioDeck = engine.audioDecks[deck];
    if (!audioDeck) continue;

    const time = audioDeck.getCurrentTime();
    const dur = audioDeck.getDuration();
    document.getElementById(`time-${deck}`).textContent = formatTime(time);
    document.getElementById(`duration-${deck}`).textContent = formatTime(dur);

    // Update playback rate display
    const rateEl = document.getElementById(`rate-${deck}`);
    if (rateEl) {
      const rate = audioDeck.audio.playbackRate;
      rateEl.textContent = `${rate.toFixed(3)}x`;
      rateEl.style.color = Math.abs(rate - 1.0) > 0.001 ? '#f0883e' : '#484f58';
    }

    // Render waveform and level meter
    renderWaveform(deck);
    updateLevelMeter(deck);
  }

  // Update transition countdown
  if (engine.autoMixing && engine.mixPlan) {
    const trans = engine.mixPlan.transitions[engine.queueIndex];
    if (trans) {
      const audioDeck = engine.audioDecks[engine.activeDeck];
      if (audioDeck) {
        const remaining = trans.fromOutPoint - audioDeck.getCurrentTime();
        if (remaining > 0) {
          document.getElementById('transition-countdown').textContent =
            `Next transition in ${Math.ceil(remaining)}s`;
        } else {
          document.getElementById('transition-countdown').textContent = 'Transitioning...';
        }
      }
    }
  }
}, 50); // 20fps for smooth waveform rendering

// ---- UI Functions ----

function updateDeckUI(deck, track) {
  if (!track) return;
  // Show title from playlist if available, otherwise video ID
  const playlistTrack = playlist.find(t => t.id === track.video_id);
  document.getElementById(`title-${deck}`).textContent = playlistTrack?.title || track.video_id;
  document.getElementById(`bpm-${deck}`).textContent = `${track.bpm} BPM`;
  const keyInfo = track.key;
  if (keyInfo) {
    document.getElementById(`key-${deck}`).textContent =
      `${keyInfo.key}${keyInfo.mode === 'minor' ? 'm' : ''} (${keyInfo.camelot})`;
  }
}

function flashBeat(deck, isDownbeat) {
  const el = document.getElementById(`deck-${deck}`);
  if (!el) return;
  el.classList.add('beat-flash');
  setTimeout(() => el.classList.remove('beat-flash'), 100);
}

function updateTrackListHighlights(queueIndex) {
  document.querySelectorAll('.track-item').forEach(el => {
    el.classList.remove('playing-a', 'playing-b', 'next');
  });

  const order = engine.queue;
  if (order[queueIndex]) {
    const el = document.querySelector(`.track-item[data-id="${order[queueIndex]}"]`);
    if (el) el.classList.add(engine.activeDeck === 'a' ? 'playing-a' : 'playing-b');
  }
  if (order[queueIndex + 1]) {
    const el = document.querySelector(`.track-item[data-id="${order[queueIndex + 1]}"]`);
    if (el) el.classList.add('next');
  }
}

function setStatus(text) {
  document.getElementById('status-text').textContent = text;
}

function setProgress(pct) {
  document.getElementById('progress-fill').style.width = `${pct}%`;
}

function formatTime(seconds) {
  if (!seconds && seconds !== 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ---- API Functions ----

async function loadPlaylist() {
  const url = document.getElementById('playlist-url').value.trim();
  if (!url) return;

  setStatus('Loading playlist...');
  document.getElementById('load-btn').disabled = true;

  try {
    const res = await fetch('/api/playlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to load playlist');
    }

    const data = await res.json();
    playlist = data.videos;
    setStatus(`Loaded: ${data.title} (${playlist.length} tracks)`);
    renderTrackList();
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  } finally {
    document.getElementById('load-btn').disabled = false;
  }
}

async function loadDemo() {
  setStatus('Generating demo tracks (synthetic audio)...');
  document.getElementById('demo-btn').disabled = true;

  try {
    const res = await fetch('/api/demo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to generate demo');
    }

    const data = await res.json();

    // Set playlist
    playlist = data.playlist;
    renderTrackList();

    // Store analysis results
    for (const track of data.tracks) {
      analysisData[track.video_id] = track;
      engine.setTrackData(track.video_id, track);
    }

    // Set mix plan
    if (data.plan) {
      engine.setMixPlan(data.plan);

      // Reorder playlist to match plan
      const orderedPlaylist = data.plan.order.map(id =>
        playlist.find(t => t.id === id) || { id, title: id }
      );
      playlist = orderedPlaylist;
      renderTrackList();

      debug.renderTransitions(data.plan, analysisData);
    }

    setStatus(`Demo ready! ${data.tracks.length} synthetic tracks analyzed and ordered. Hit AUTO MIX!`);
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  } finally {
    document.getElementById('demo-btn').disabled = false;
  }
}

function renderTrackList() {
  const container = document.getElementById('track-list');
  container.innerHTML = '';

  playlist.forEach((track, i) => {
    const div = document.createElement('div');
    div.className = 'track-item';
    div.dataset.id = track.id;
    div.onclick = () => selectTrackInList(track.id);

    const analysis = analysisData[track.id];
    const bpmText = analysis ? `${analysis.bpm}` : '--';
    const keyText = analysis?.key ? `${analysis.key.camelot}` : '--';
    const genreText = analysis?.genre?.genre_hint || '--';
    const statusBadge = analysis
      ? '<span class="status-badge analyzed">OK</span>'
      : '<span class="status-badge pending">--</span>';

    const isDemo = track.id?.startsWith('demo_');
    const thumbSrc = track.thumbnail || (isDemo ? '' : `https://img.youtube.com/vi/${track.id}/mqdefault.jpg`);
    const thumbHtml = thumbSrc
      ? `<img src="${thumbSrc}" alt="" />`
      : `<div class="demo-thumb">${track.title?.[0] || '?'}</div>`;

    div.innerHTML = `
      <span class="order">${i + 1}</span>
      ${thumbHtml}
      <span class="title" title="${track.title}">${track.title}</span>
      <span class="bpm">${bpmText} BPM</span>
      <span class="key">${keyText}</span>
      <span class="genre">${genreText}</span>
      <span class="status">${statusBadge}</span>
    `;
    container.appendChild(div);
  });
}

function selectTrackInList(videoId) {
  if (analysisData[videoId]) {
    debug.selectTrack(videoId);
    const panel = document.getElementById('debug-panel');
    if (panel.classList.contains('hidden')) {
      panel.classList.remove('hidden');
    }
  }
}

async function analyzeAll() {
  if (playlist.length === 0) {
    setStatus('Load a playlist first');
    return;
  }

  const videoIds = playlist.map(t => t.id);
  setStatus(`Analyzing ${videoIds.length} tracks...`);
  setProgress(5);
  document.getElementById('analyze-btn').disabled = true;

  document.querySelectorAll('.status-badge').forEach(el => {
    if (el.classList.contains('pending')) {
      el.classList.remove('pending');
      el.classList.add('analyzing');
      el.textContent = '...';
    }
  });

  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoIds })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Analysis failed');
    }

    const data = await res.json();

    for (const track of data.tracks) {
      if (!track.error) {
        analysisData[track.video_id] = track;
        engine.setTrackData(track.video_id, track);
      } else {
        debug.log({ time: new Date().toISOString(), type: 'error', message: `Analysis failed for ${track.video_id}: ${track.error}` });
      }
    }

    setProgress(80);
    renderTrackList();

    // Generate mix plan
    setStatus('Generating mix plan...');
    const analyzedTracks = Object.values(analysisData);
    if (analyzedTracks.length >= 2) {
      const planRes = await fetch('/api/mixplan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tracks: analyzedTracks })
      });

      if (planRes.ok) {
        const plan = await planRes.json();
        engine.setMixPlan(plan);

        const orderedPlaylist = plan.order.map(id =>
          playlist.find(t => t.id === id) || { id, title: id }
        );
        playlist = orderedPlaylist;
        renderTrackList();

        debug.renderTransitions(plan, analysisData);

        setStatus(`Ready to mix! ${analyzedTracks.length} tracks analyzed. Hybrid audio mode active.`);
      }
    } else {
      setStatus('Need at least 2 successfully analyzed tracks to create a mix plan.');
    }

    setProgress(100);
    setTimeout(() => setProgress(0), 2000);
  } catch (err) {
    setStatus(`Error: ${err.message}`);
    setProgress(0);
  } finally {
    document.getElementById('analyze-btn').disabled = false;
  }
}

// ---- Controls ----

function setVolume(deck, value) {
  engine.setDeckVolume(deck, parseInt(value));
}

function setCrossfade(value) {
  engine.setCrossfade(parseInt(value));
}

function startAutoMix() {
  if (engine.autoMixing) {
    engine.stopAutoMix();
  } else {
    engine.startAutoMix();
  }
}

function triggerTransition() {
  engine.triggerTransition();
}

function stopMix() {
  engine.stopAutoMix();
}

// ---- Debug Panel ----

function toggleDebug() {
  const panel = document.getElementById('debug-panel');
  panel.classList.toggle('hidden');
}

function showDebugTab(tab) {
  document.querySelectorAll('.debug-section').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.debug-tab').forEach(el => el.classList.remove('active'));

  const section = document.getElementById(`debug-${tab}`);
  if (section) section.classList.remove('hidden');

  event.target.classList.add('active');
}

function clearMixLog() {
  debug.clearLog();
}

function exportMixLog() {
  debug.exportLog();
}

// Initialize waveform canvases when DOM is ready
document.addEventListener('DOMContentLoaded', initWaveformCanvases);
// Also try immediately in case DOMContentLoaded already fired
if (document.readyState !== 'loading') {
  initWaveformCanvases();
}
