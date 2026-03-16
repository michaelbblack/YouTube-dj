/**
 * YouTube DJ - Main Application
 * Ties together the DJ engine, YouTube players, and UI.
 */

let engine;
let debug;
let playlist = [];
let analysisData = {};
let ytReady = false;

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
        setStatus('Players ready');
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
  // YT states: -1=unstarted, 0=ended, 1=playing, 2=paused, 3=buffering, 5=cued
  const states = { '-1': 'unstarted', 0: 'ended', 1: 'playing', 2: 'paused', 3: 'buffering', 5: 'cued' };
  debug.log({ time: new Date().toISOString(), type: 'info', message: `Deck ${deck.toUpperCase()} state: ${states[event.data] || event.data}` });
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

// UI update loop
setInterval(() => {
  for (const deck of ['a', 'b']) {
    const player = engine.players[deck];
    if (!player || typeof player.getCurrentTime !== 'function') continue;
    const time = player.getCurrentTime();
    const dur = player.getDuration?.() || 0;
    document.getElementById(`time-${deck}`).textContent = formatTime(time);
    document.getElementById(`duration-${deck}`).textContent = formatTime(dur);
  }

  // Update transition countdown
  if (engine.autoMixing && engine.mixPlan) {
    const trans = engine.mixPlan.transitions[engine.queueIndex];
    if (trans) {
      const player = engine.players[engine.activeDeck];
      if (player && typeof player.getCurrentTime === 'function') {
        const remaining = trans.fromOutPoint - player.getCurrentTime();
        if (remaining > 0) {
          document.getElementById('transition-countdown').textContent =
            `Next transition in ${Math.ceil(remaining)}s`;
        } else {
          document.getElementById('transition-countdown').textContent = 'Transitioning...';
        }
      }
    }
  }
}, 200);

// ---- UI Functions ----

function updateDeckUI(deck, track) {
  if (!track) return;
  document.getElementById(`title-${deck}`).textContent = track.video_id;
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

function loadDemo() {
  // Demo with some well-known video IDs for testing
  playlist = [
    { id: 'dQw4w9WgXcQ', title: 'Rick Astley - Never Gonna Give You Up', duration: 213 },
    { id: 'fJ9rUzIMcZQ', title: 'Queen - Bohemian Rhapsody', duration: 354 },
    { id: 'kJQP7kiw5Fk', title: 'Luis Fonsi - Despacito', duration: 282 },
    { id: 'JGwWNGJdvx8', title: 'Ed Sheeran - Shape of You', duration: 263 },
    { id: '09R8_2nJtjg', title: 'Maroon 5 - Sugar', duration: 235 },
  ];
  setStatus('Demo playlist loaded (5 tracks)');
  renderTrackList();
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

    div.innerHTML = `
      <span class="order">${i + 1}</span>
      <img src="https://img.youtube.com/vi/${track.id}/mqdefault.jpg" alt="" />
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
    // Show debug panel if hidden
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

  // Mark tracks as analyzing
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

    // Store analysis results
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

        // Reorder track list to match plan
        const orderedPlaylist = plan.order.map(id =>
          playlist.find(t => t.id === id) || { id, title: id }
        );
        playlist = orderedPlaylist;
        renderTrackList();

        // Render transition debug info
        debug.renderTransitions(plan, analysisData);

        setStatus(`Ready to mix! ${analyzedTracks.length} tracks analyzed and ordered.`);
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
