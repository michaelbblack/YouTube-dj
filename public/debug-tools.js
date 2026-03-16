/**
 * Debug Tools for YouTube DJ
 * Visualizes BPM analysis, beat grids, energy profiles, and transition quality.
 */

class DebugTools {
  constructor(engine) {
    this.engine = engine;
    this.mixLog = [];
    this.selectedTrack = null;
    this.beatCanvasCtx = null;
    this.energyCanvasCtx = null;
    this.bpmCanvasCtx = null;
    this._animFrame = null;
  }

  init() {
    this.bpmCanvasCtx = document.getElementById('bpm-canvas')?.getContext('2d');
    this.beatCanvasCtx = document.getElementById('beat-canvas')?.getContext('2d');
    this.energyCanvasCtx = document.getElementById('energy-canvas')?.getContext('2d');

    // Start render loop for live beat visualization
    this._animate();
  }

  destroy() {
    cancelAnimationFrame(this._animFrame);
  }

  log(entry) {
    this.mixLog.push(entry);
    this._renderLogEntry(entry);
    // Keep log manageable
    if (this.mixLog.length > 1000) this.mixLog = this.mixLog.slice(-500);
  }

  clearLog() {
    this.mixLog = [];
    const logEl = document.getElementById('mix-log');
    if (logEl) logEl.innerHTML = '';
  }

  exportLog() {
    const text = this.mixLog.map(e =>
      `[${e.time}] [${e.type}] ${e.message}`
    ).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dj-mix-log-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /**
   * Select a track to visualize its analysis data.
   */
  selectTrack(videoId) {
    this.selectedTrack = videoId;
    const track = this.engine.tracks[videoId];
    if (!track) return;

    this.renderBPMAnalysis(track);
    this.renderBeatGrid(track);
    this.renderEnergyProfile(track);
  }

  /**
   * Render BPM analysis details and strategy comparison.
   */
  renderBPMAnalysis(track) {
    const ctx = this.bpmCanvasCtx;
    const canvas = ctx?.canvas;
    if (!ctx || !canvas) return;

    // Set actual resolution
    canvas.width = canvas.clientWidth * 2;
    canvas.height = 200 * 2;
    ctx.scale(2, 2);
    const W = canvas.clientWidth;
    const H = 200;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, W, H);

    const debug = track.debug;
    if (!debug?.bpm_strategies) return;

    // Draw strategy comparison bars
    const strategies = Object.entries(debug.bpm_strategies);
    const barWidth = (W - 40) / strategies.length;

    ctx.font = '11px monospace';

    strategies.forEach(([name, bpm], i) => {
      const x = 20 + i * barWidth;
      const normalizedBpm = bpm;
      const barH = (normalizedBpm / 200) * (H - 50);

      // Color based on whether this was the chosen strategy
      ctx.fillStyle = name === debug.chosen_strategy ? '#e94560' : '#30363d';
      ctx.fillRect(x + 5, H - 30 - barH, barWidth - 10, barH);

      // Label
      ctx.fillStyle = '#8b949e';
      ctx.textAlign = 'center';
      ctx.fillText(name, x + barWidth / 2, H - 10);
      ctx.fillStyle = name === debug.chosen_strategy ? '#e94560' : '#58a6ff';
      ctx.fillText(`${bpm.toFixed(1)}`, x + barWidth / 2, H - 30 - barH - 5);
    });

    // Title
    ctx.fillStyle = '#e0e0e0';
    ctx.font = 'bold 13px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`BPM Analysis: ${track.bpm} BPM (${debug.chosen_strategy})`, 10, 20);

    // Details text
    const detailsEl = document.getElementById('bpm-details');
    if (detailsEl) {
      detailsEl.textContent = [
        `Final BPM: ${track.bpm}`,
        `Strategy: ${debug.chosen_strategy}`,
        `Beat interval: ${track.beat_interval}s`,
        `Detected beats: ${track.beats?.length || 0}`,
        `Beat grid points: ${track.beat_grid?.length || 0}`,
        `Key: ${track.key?.key} ${track.key?.mode} (${track.key?.camelot}) confidence=${track.key?.confidence?.toFixed(3)}`,
        `Genre hint: ${track.genre?.genre_hint}`,
        '',
        'Strategy results:',
        ...Object.entries(debug.bpm_strategies).map(([k, v]) => `  ${k}: ${v.toFixed(2)} BPM`)
      ].join('\n');
    }
  }

  /**
   * Render beat grid visualization with live playback position.
   */
  renderBeatGrid(track) {
    const ctx = this.beatCanvasCtx;
    const canvas = ctx?.canvas;
    if (!ctx || !canvas) return;

    canvas.width = canvas.clientWidth * 2;
    canvas.height = 300 * 2;
    ctx.scale(2, 2);
    const W = canvas.clientWidth;
    const H = 300;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, W, H);

    if (!track.beat_grid || track.beat_grid.length === 0) {
      ctx.fillStyle = '#8b949e';
      ctx.font = '14px monospace';
      ctx.fillText('No beat data available', 20, H / 2);
      return;
    }

    const duration = track.duration;
    const margin = 20;
    const plotW = W - margin * 2;

    // Draw timeline
    ctx.strokeStyle = '#30363d';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(margin, H / 2);
    ctx.lineTo(W - margin, H / 2);
    ctx.stroke();

    // Time markers every 10 seconds
    ctx.fillStyle = '#484f58';
    ctx.font = '10px monospace';
    for (let t = 0; t <= duration; t += 10) {
      const x = margin + (t / duration) * plotW;
      ctx.beginPath();
      ctx.moveTo(x, H / 2 - 5);
      ctx.lineTo(x, H / 2 + 5);
      ctx.stroke();
      ctx.fillText(`${Math.floor(t / 60)}:${(t % 60).toString().padStart(2, '0')}`, x - 10, H / 2 + 18);
    }

    // Draw detected beats (top half)
    ctx.fillStyle = '#e94560';
    ctx.font = '11px monospace';
    ctx.fillText('Detected Beats', margin, 15);
    track.beats.forEach((beat, i) => {
      const x = margin + (beat / duration) * plotW;
      const isDownbeat = i % 4 === 0;
      const h = isDownbeat ? 40 : 20;
      ctx.fillStyle = isDownbeat ? '#e94560' : '#58a6ff';
      ctx.fillRect(x, H / 2 - h - 5, 1.5, h);
    });

    // Draw computed beat grid (bottom half)
    ctx.fillStyle = '#7ee787';
    ctx.font = '11px monospace';
    ctx.fillText('Computed Beat Grid', margin, H / 2 + 40);
    track.beat_grid.forEach((beat, i) => {
      const x = margin + (beat / duration) * plotW;
      const isDownbeat = i % 4 === 0;
      const h = isDownbeat ? 40 : 20;
      ctx.fillStyle = isDownbeat ? '#7ee787' : '#3fb950';
      ctx.fillRect(x, H / 2 + 45, 1.5, h);
    });

    // Draw transition points
    const mixIn = track.transitions?.mix_in;
    const mixOut = track.transitions?.mix_out;
    if (mixIn !== undefined) {
      const x = margin + (mixIn / duration) * plotW;
      ctx.strokeStyle = '#f0883e';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#f0883e';
      ctx.fillText('MIX IN', x + 4, 30);
    }
    if (mixOut !== undefined) {
      const x = margin + (mixOut / duration) * plotW;
      ctx.strokeStyle = '#f0883e';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#f0883e';
      ctx.fillText('MIX OUT', x + 4, 30);
    }

    // Beat details
    const detailsEl = document.getElementById('beat-details');
    if (detailsEl) {
      // Calculate beat grid consistency
      const intervals = [];
      for (let i = 1; i < track.beats.length; i++) {
        intervals.push(track.beats[i] - track.beats[i-1]);
      }
      const avgInterval = intervals.length > 0
        ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0;
      const stdDev = intervals.length > 0
        ? Math.sqrt(intervals.map(x => (x - avgInterval) ** 2).reduce((a, b) => a + b) / intervals.length)
        : 0;

      detailsEl.textContent = [
        `Beat count: ${track.beats.length} detected, ${track.beat_grid.length} grid points`,
        `Avg beat interval: ${avgInterval.toFixed(4)}s (expected: ${track.beat_interval.toFixed(4)}s)`,
        `Interval std dev: ${stdDev.toFixed(4)}s (lower = more consistent)`,
        `Consistency score: ${(1 - Math.min(stdDev / avgInterval, 1)).toFixed(3)} (1.0 = perfect)`,
        `Mix in point: ${mixIn?.toFixed(2)}s`,
        `Mix out point: ${mixOut?.toFixed(2)}s`,
        '',
        'First 16 beat intervals:',
        intervals.slice(0, 16).map((v, i) =>
          `  Beat ${i+1}-${i+2}: ${v.toFixed(4)}s (${(60/v).toFixed(1)} BPM) ${Math.abs(v - track.beat_interval) > 0.05 ? '⚠ drift' : '✓'}`
        ).join('\n')
      ].join('\n');
    }
  }

  /**
   * Render energy profile for finding transition spots.
   */
  renderEnergyProfile(track) {
    const ctx = this.energyCanvasCtx;
    const canvas = ctx?.canvas;
    if (!ctx || !canvas) return;

    canvas.width = canvas.clientWidth * 2;
    canvas.height = 200 * 2;
    ctx.scale(2, 2);
    const W = canvas.clientWidth;
    const H = 200;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, W, H);

    const sections = track.energy_sections;
    if (!sections || sections.length === 0) return;

    const duration = track.duration;
    const margin = 20;
    const plotW = W - margin * 2;
    const plotH = H - 40;

    // Draw energy bars
    sections.forEach((sec, i) => {
      const x = margin + (sec.time / duration) * plotW;
      const w = plotW / sections.length;
      const h = sec.energy_norm * plotH;

      // Color by segment type
      const segType = track.transitions?.segments?.[i]?.type;
      const colors = {
        peak: '#e94560',
        buildup: '#f0883e',
        drop: '#6e40c9',
        breakdown: '#1f6feb',
        mid: '#30363d'
      };
      ctx.fillStyle = colors[segType] || '#30363d';
      ctx.fillRect(x, H - 20 - h, Math.max(w - 1, 1), h);
    });

    // Draw brightness line
    ctx.strokeStyle = '#58a6ff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const maxBright = Math.max(...sections.map(s => s.brightness));
    sections.forEach((sec, i) => {
      const x = margin + (sec.time / duration) * plotW;
      const y = H - 20 - (sec.brightness / maxBright) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Labels
    ctx.fillStyle = '#e0e0e0';
    ctx.font = 'bold 11px monospace';
    ctx.fillText('Energy Profile (bars) + Brightness (line)', margin, 15);

    // Legend
    const legend = [
      ['peak', '#e94560'], ['buildup', '#f0883e'],
      ['drop', '#6e40c9'], ['breakdown', '#1f6feb'], ['mid', '#30363d']
    ];
    legend.forEach(([name, color], i) => {
      const lx = W - 350 + i * 70;
      ctx.fillStyle = color;
      ctx.fillRect(lx, 5, 10, 10);
      ctx.fillStyle = '#8b949e';
      ctx.font = '9px monospace';
      ctx.fillText(name, lx + 13, 14);
    });
  }

  /**
   * Render transition plan details.
   */
  renderTransitions(mixPlan, tracks) {
    const container = document.getElementById('transition-list');
    if (!container || !mixPlan) return;

    container.innerHTML = '';

    mixPlan.transitions.forEach((trans, i) => {
      const fromTrack = tracks[trans.from];
      const toTrack = tracks[trans.to];

      const card = document.createElement('div');
      card.className = 'transition-card';

      const compatClass = trans.keyCompat > 0.8 ? 'compat-good'
        : trans.keyCompat > 0.5 ? 'compat-ok' : 'compat-bad';

      card.innerHTML = `
        <h4>Transition ${i + 1}: ${fromTrack?.video_id || trans.from} → ${toTrack?.video_id || trans.to}</h4>
        <div class="detail">
          <strong>Type:</strong> ${trans.type} (${trans.technique})<br>
          <strong>BPM:</strong> ${trans.fromBpm} → ${trans.toBpm} (diff: ${trans.bpmDiff.toFixed(1)})<br>
          <strong>Key:</strong> ${fromTrack?.key?.camelot || '?'} → ${toTrack?.key?.camelot || '?'}
          <span class="${compatClass}"> (compat: ${(trans.keyCompat * 100).toFixed(0)}%)</span><br>
          <strong>Duration:</strong> ${trans.transitionBeats} beats (${trans.crossfadeDuration.toFixed(1)}s)<br>
          <strong>Out point:</strong> ${this._formatTime(trans.fromOutPoint)} | <strong>In point:</strong> ${this._formatTime(trans.toInPoint)}<br>
          <strong>Playback rate adj:</strong> ${trans.bpmDiff < 0.5 ? 'none needed' : (trans.fromBpm / trans.toBpm).toFixed(3) + 'x'}
        </div>
      `;
      container.appendChild(card);
    });
  }

  /**
   * Animate live beat visualization on playing decks.
   */
  _animate() {
    // If beat canvas is visible and a track is selected, update playhead
    if (this.selectedTrack && this.beatCanvasCtx) {
      const track = this.engine.tracks[this.selectedTrack];
      if (track) {
        // Find which deck has this track
        for (const deck of ['a', 'b']) {
          const player = this.engine.players[deck];
          if (!player) continue;
          const state = player.getPlayerState?.();
          if (state === 1) {
            // Draw playhead on beat canvas
            this._drawPlayhead(track, player.getCurrentTime());
          }
        }
      }
    }

    this._animFrame = requestAnimationFrame(() => this._animate());
  }

  _drawPlayhead(track, time) {
    const ctx = this.beatCanvasCtx;
    const canvas = ctx?.canvas;
    if (!ctx || !canvas) return;

    const W = canvas.clientWidth;
    const H = 300;
    const margin = 20;
    const plotW = W - margin * 2;
    const x = margin + (time / track.duration) * plotW;

    // Draw a thin playhead line (without clearing - it'll be redrawn each frame)
    // We need to redraw the whole canvas to avoid artifacts
    this.renderBeatGrid(track);

    // Now draw playhead on top
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
    ctx.restore();
  }

  _renderLogEntry(entry) {
    const logEl = document.getElementById('mix-log');
    if (!logEl) return;

    const div = document.createElement('div');
    div.className = 'log-entry';

    const typeClass = {
      info: 'log-event',
      event: 'log-event',
      warn: 'log-warn',
      error: 'log-error',
      beat: 'log-beat'
    }[entry.type] || 'log-event';

    const timeStr = entry.time.split('T')[1]?.split('.')[0] || '';
    div.innerHTML = `<span class="log-time">${timeStr}</span> <span class="${typeClass}">[${entry.type}]</span> ${entry.message}`;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }

  _formatTime(seconds) {
    if (!seconds && seconds !== 0) return '?';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
}

window.DebugTools = DebugTools;
