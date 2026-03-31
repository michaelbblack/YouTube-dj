#!/usr/bin/env python3
"""
Audio analysis pipeline for YouTube DJ.
Extracts BPM, beat positions, musical key, and energy for beat-matching.
Uses librosa for high-accuracy analysis.
"""

import sys
import json
import os
import subprocess
import tempfile
import warnings
import numpy as np

warnings.filterwarnings('ignore')

import librosa


def download_audio(video_id, output_dir, yt_dlp_binary='yt-dlp'):
    """Download audio from YouTube video using yt-dlp."""
    output_path = os.path.join(output_dir, f"{video_id}.wav")
    if os.path.exists(output_path):
        return output_path

    temp_path = os.path.join(output_dir, f"{video_id}_temp")
    cmd = [
        yt_dlp_binary,
        "-x",
        "--audio-format", "wav",
        "--audio-quality", "0",
        "--no-check-certificates",
        "--no-playlist",
        "--retries", "3",
        "--socket-timeout", "30",
        "-o", f"{temp_path}.%(ext)s",
        f"https://www.youtube.com/watch?v={video_id}"
    ]
    try:
        print(f"Downloading audio for {video_id}...", file=sys.stderr)
        result = subprocess.run(cmd, capture_output=True, timeout=180, text=True)
        if result.returncode != 0:
            err = result.stderr.strip()
            print(f"yt-dlp error for {video_id}: {err}", file=sys.stderr)
            # Clean up any partial temp files
            _cleanup_temp_files(temp_path)
            return None

        # yt-dlp may produce temp file with different name/extension
        found = False
        for ext in ['wav', 'webm', 'opus', 'm4a', 'mp3', 'ogg', 'aac']:
            candidate = f"{temp_path}.{ext}"
            if os.path.exists(candidate):
                if ext != 'wav':
                    print(f"Converting {ext} -> wav for {video_id}...", file=sys.stderr)
                    ffmpeg_result = subprocess.run([
                        'ffmpeg', '-i', candidate, '-ar', '44100', '-ac', '1',
                        output_path, '-y'
                    ], capture_output=True, timeout=120, text=True)
                    os.remove(candidate)
                    if ffmpeg_result.returncode != 0:
                        print(f"ffmpeg error for {video_id}: {ffmpeg_result.stderr}", file=sys.stderr)
                        return None
                else:
                    os.rename(candidate, output_path)
                found = True
                break

        if not found:
            # yt-dlp may have used a different naming pattern; search for any matching file
            import glob
            matches = glob.glob(f"{temp_path}*")
            if matches:
                src = matches[0]
                print(f"Found unexpected file {src}, converting for {video_id}...", file=sys.stderr)
                subprocess.run([
                    'ffmpeg', '-i', src, '-ar', '44100', '-ac', '1',
                    output_path, '-y'
                ], capture_output=True, timeout=120)
                os.remove(src)
            else:
                print(f"No audio file found after download for {video_id}", file=sys.stderr)
                return None

        return output_path if os.path.exists(output_path) else None
    except subprocess.TimeoutExpired:
        print(f"Timeout downloading {video_id} (>180s)", file=sys.stderr)
        _cleanup_temp_files(temp_path)
        return None
    except Exception as e:
        print(f"Error downloading {video_id}: {e}", file=sys.stderr)
        _cleanup_temp_files(temp_path)
        return None


def _cleanup_temp_files(temp_path):
    """Remove any leftover temp files from a failed download."""
    import glob
    for f in glob.glob(f"{temp_path}*"):
        try:
            os.remove(f)
        except OSError:
            pass


def analyze_bpm_and_beats(y, sr):
    """
    Multi-pass BPM detection for high accuracy.
    Uses librosa's beat tracker with multiple strategies and picks the best.
    """
    results = []

    # Strategy 1: Default beat tracking
    tempo1, beats1 = librosa.beat.beat_track(y=y, sr=sr, units='time')
    if hasattr(tempo1, '__len__'):
        tempo1 = float(tempo1[0]) if len(tempo1) > 0 else 0.0
    results.append(('default', float(tempo1), beats1))

    # Strategy 2: With onset envelope emphasis
    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    tempo2, beats2 = librosa.beat.beat_track(onset_envelope=onset_env, sr=sr, units='time')
    if hasattr(tempo2, '__len__'):
        tempo2 = float(tempo2[0]) if len(tempo2) > 0 else 0.0
    results.append(('onset', float(tempo2), beats2))

    # Strategy 3: Tempogram-based estimation
    tempogram = librosa.feature.tempogram(onset_envelope=onset_env, sr=sr)
    tempo3 = librosa.feature.tempo(onset_envelope=onset_env, sr=sr, aggregate=None)
    if len(tempo3) > 0:
        # Get the most common tempo
        tempo_hist, tempo_bins = np.histogram(tempo3, bins=50, range=(60, 200))
        best_bin = np.argmax(tempo_hist)
        tempo3_val = float((tempo_bins[best_bin] + tempo_bins[best_bin + 1]) / 2)
    else:
        tempo3_val = float(tempo2)
    results.append(('tempogram', tempo3_val, beats2))

    # Strategy 4: Percussive separation for cleaner beat detection
    y_perc = librosa.effects.percussive(y, margin=3.0)
    tempo4, beats4 = librosa.beat.beat_track(y=y_perc, sr=sr, units='time')
    if hasattr(tempo4, '__len__'):
        tempo4 = float(tempo4[0]) if len(tempo4) > 0 else 0.0
    results.append(('percussive', float(tempo4), beats4))

    # Vote on BPM: normalize to same octave and find consensus
    tempos = [r[1] for r in results if r[1] > 0]
    normalized = []
    for t in tempos:
        while t < 70:
            t *= 2
        while t > 180:
            t /= 2
        normalized.append(t)

    if normalized:
        # Use median for robustness
        final_bpm = float(np.median(normalized))
    else:
        final_bpm = 120.0

    # Pick the beat positions from the strategy closest to our final BPM
    best_idx = 0
    best_diff = float('inf')
    for i, (name, tempo, beats) in enumerate(results):
        norm_tempo = tempo
        while norm_tempo < 70:
            norm_tempo *= 2
        while norm_tempo > 180:
            norm_tempo /= 2
        diff = abs(norm_tempo - final_bpm)
        if diff < best_diff and len(beats) > 4:
            best_diff = diff
            best_idx = i

    best_beats = results[best_idx][2]

    return final_bpm, best_beats.tolist(), {
        'strategies': {r[0]: r[1] for r in results},
        'normalized': normalized,
        'chosen_strategy': results[best_idx][0]
    }


def analyze_key(y, sr):
    """Detect musical key using chroma features."""
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    chroma_avg = np.mean(chroma, axis=1)

    # Krumhansl-Kessler key profiles
    major_profile = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
    minor_profile = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

    keys = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    best_corr = -1
    best_key = 'C'
    best_mode = 'major'

    for i in range(12):
        shifted = np.roll(chroma_avg, -i)
        # Major
        corr_maj = float(np.corrcoef(shifted, major_profile)[0, 1])
        if corr_maj > best_corr:
            best_corr = corr_maj
            best_key = keys[i]
            best_mode = 'major'
        # Minor
        corr_min = float(np.corrcoef(shifted, minor_profile)[0, 1])
        if corr_min > best_corr:
            best_corr = corr_min
            best_key = keys[i]
            best_mode = 'minor'

    # Camelot wheel mapping
    camelot_major = {'B': '1B', 'F#': '2B', 'C#': '3B', 'G#': '4B', 'D#': '5B',
                     'A#': '6B', 'F': '7B', 'C': '8B', 'G': '9B', 'D': '10B',
                     'A': '11B', 'E': '12B'}
    camelot_minor = {'G#': '1A', 'D#': '2A', 'A#': '3A', 'F': '4A', 'C': '5A',
                     'G': '6A', 'D': '7A', 'A': '8A', 'E': '9A', 'B': '10A',
                     'F#': '11A', 'C#': '12A'}

    camelot = camelot_major.get(best_key, '?') if best_mode == 'major' else camelot_minor.get(best_key, '?')

    return {
        'key': best_key,
        'mode': best_mode,
        'camelot': camelot,
        'confidence': float(best_corr)
    }


def analyze_energy_profile(y, sr, hop_length=512):
    """Compute energy profile over time for finding good transition points."""
    rms = librosa.feature.rms(y=y, hop_length=hop_length)[0]
    times = librosa.times_like(rms, sr=sr, hop_length=hop_length)

    # Spectral centroid for brightness
    spectral = librosa.feature.spectral_centroid(y=y, sr=sr, hop_length=hop_length)[0]

    # Compute energy in sections (every 4 seconds)
    section_len = int(4 * sr / hop_length)
    sections = []
    for i in range(0, len(rms), section_len):
        chunk_rms = rms[i:i+section_len]
        chunk_spec = spectral[i:i+section_len]
        if len(chunk_rms) > 0:
            sections.append({
                'time': float(times[i]) if i < len(times) else 0,
                'energy': float(np.mean(chunk_rms)),
                'brightness': float(np.mean(chunk_spec)),
            })

    # Normalize energy
    max_energy = max(s['energy'] for s in sections) if sections else 1
    for s in sections:
        s['energy_norm'] = s['energy'] / max_energy if max_energy > 0 else 0

    return sections


def find_transition_points(beats, energy_sections, duration):
    """Find good spots for transitions (intro, outro, drops, breakdowns)."""
    if not beats or not energy_sections:
        return {'mix_in': 0, 'mix_out': duration * 0.85, 'segments': []}

    # Find energy changes
    energies = [s['energy_norm'] for s in energy_sections]
    times = [s['time'] for s in energy_sections]

    # Find low-energy sections (good for mixing in/out)
    avg_energy = np.mean(energies) if energies else 0.5
    low_energy_times = [times[i] for i, e in enumerate(energies) if e < avg_energy * 0.6]
    high_energy_times = [times[i] for i, e in enumerate(energies) if e > avg_energy * 1.2]

    # Find first beat after initial low energy section (mix-in point)
    mix_in = 0
    for t in low_energy_times:
        if t > 4 and t < duration * 0.3:
            # Snap to nearest beat
            beat_diffs = [abs(b - t) for b in beats]
            if beat_diffs:
                mix_in = beats[np.argmin(beat_diffs)]
            break

    # Find last low energy section before end (mix-out point)
    mix_out = duration * 0.85
    for t in reversed(low_energy_times):
        if t > duration * 0.6 and t < duration * 0.95:
            beat_diffs = [abs(b - t) for b in beats]
            if beat_diffs:
                mix_out = beats[np.argmin(beat_diffs)]
            break

    # Classify segments
    segments = []
    for i, sec in enumerate(energy_sections):
        if sec['energy_norm'] < 0.3:
            seg_type = 'breakdown'
        elif sec['energy_norm'] > 0.8:
            seg_type = 'peak'
        elif i > 0 and energies[i] - energies[i-1] > 0.3:
            seg_type = 'buildup'
        elif i > 0 and energies[i-1] - energies[i] > 0.3:
            seg_type = 'drop'
        else:
            seg_type = 'mid'
        segments.append({
            'time': sec['time'],
            'type': seg_type,
            'energy': sec['energy_norm']
        })

    return {
        'mix_in': float(mix_in),
        'mix_out': float(mix_out),
        'segments': segments
    }


def estimate_genre_energy(y, sr):
    """Estimate genre characteristics and overall energy."""
    spectral_centroid = float(np.mean(librosa.feature.spectral_centroid(y=y, sr=sr)))
    spectral_rolloff = float(np.mean(librosa.feature.spectral_rolloff(y=y, sr=sr)))
    zero_crossing_rate = float(np.mean(librosa.feature.zero_crossing_rate(y)))
    rms_energy = float(np.mean(librosa.feature.rms(y=y)))

    # Simple genre heuristic based on spectral features
    if spectral_centroid > 3000 and zero_crossing_rate > 0.1:
        genre_hint = 'electronic/edm'
    elif spectral_centroid < 1500 and rms_energy < 0.05:
        genre_hint = 'ambient/chill'
    elif zero_crossing_rate > 0.08:
        genre_hint = 'rock/pop'
    elif spectral_centroid < 2000:
        genre_hint = 'hip-hop/r&b'
    else:
        genre_hint = 'pop'

    return {
        'genre_hint': genre_hint,
        'spectral_centroid': spectral_centroid,
        'spectral_rolloff': spectral_rolloff,
        'zero_crossing_rate': zero_crossing_rate,
        'rms_energy': rms_energy
    }


def analyze_track(video_id, audio_dir, yt_dlp_binary='yt-dlp'):
    """Full analysis of a single track. Returns result dict (never throws)."""
    print(f"Analyzing {video_id}...", file=sys.stderr)

    try:
        audio_path = download_audio(video_id, audio_dir, yt_dlp_binary)
        if not audio_path:
            return {'error': f'Failed to download audio for {video_id}', 'video_id': video_id}

        # Load audio
        print(f"Loading audio for {video_id}...", file=sys.stderr)
        y, sr = librosa.load(audio_path, sr=44100, mono=True)
        duration = float(librosa.get_duration(y=y, sr=sr))

        if duration < 5:
            return {'error': f'Audio too short ({duration:.1f}s) for {video_id}', 'video_id': video_id}

        # Run all analyses
        print(f"Detecting BPM for {video_id}...", file=sys.stderr)
        bpm, beats, bpm_debug = analyze_bpm_and_beats(y, sr)

        print(f"Detecting key for {video_id}...", file=sys.stderr)
        key_info = analyze_key(y, sr)

        print(f"Computing energy profile for {video_id}...", file=sys.stderr)
        energy_sections = analyze_energy_profile(y, sr)
        transitions = find_transition_points(beats, energy_sections, duration)
        genre_energy = estimate_genre_energy(y, sr)

        # Compute beat grid (evenly spaced beats based on BPM, anchored to detected beats)
        beat_interval = 60.0 / bpm
        if beats:
            # Anchor to median beat offset
            offsets = [(b % beat_interval) for b in beats[:16]]
            anchor = float(np.median(offsets))
            beat_grid = []
            t = anchor
            while t < duration:
                beat_grid.append(round(t, 4))
                t += beat_interval
        else:
            beat_grid = [round(i * beat_interval, 4) for i in range(int(duration / beat_interval))]

        print(f"Done: {video_id} = {bpm:.1f} BPM, {key_info['camelot']}, {duration:.0f}s", file=sys.stderr)

        return {
            'video_id': video_id,
            'duration': duration,
            'bpm': round(bpm, 2),
            'beats': [round(b, 4) for b in beats],
            'beat_grid': beat_grid,
            'beat_interval': round(beat_interval, 4),
            'key': key_info,
            'energy_sections': energy_sections,
            'transitions': transitions,
            'genre': genre_energy,
            'debug': {
                'bpm_strategies': bpm_debug['strategies'],
                'chosen_strategy': bpm_debug['chosen_strategy'],
                'audio_path': audio_path
            }
        }
    except Exception as e:
        print(f"Analysis error for {video_id}: {e}", file=sys.stderr)
        return {'error': str(e), 'video_id': video_id}


def analyze_playlist(video_ids, audio_dir, yt_dlp_binary='yt-dlp'):
    """Analyze all tracks in a playlist."""
    results = []
    for vid in video_ids:
        result = analyze_track(vid, audio_dir, yt_dlp_binary)
        results.append(result)
        # Print progress
        print(json.dumps({"progress": len(results), "total": len(video_ids), "current": vid}),
              file=sys.stderr)

    return results


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: analyze.py <video_id1,video_id2,...> [audio_dir] [yt_dlp_path]", file=sys.stderr)
        sys.exit(1)

    video_ids = sys.argv[1].split(',')
    audio_dir = sys.argv[2] if len(sys.argv) > 2 else './audio_cache'
    # Accept yt-dlp binary path from the Node server
    yt_dlp_binary = sys.argv[3] if len(sys.argv) > 3 else 'yt-dlp'
    os.makedirs(audio_dir, exist_ok=True)

    results = analyze_playlist(video_ids, audio_dir, yt_dlp_binary)
    print(json.dumps(results, indent=2))
