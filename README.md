# YouTube DJ

Beat-matched mixing of YouTube music videos. Load a playlist, analyze tracks for BPM/key/energy, and play an automated DJ mix with proper transitions.

## Features

- **BPM Detection**: Multi-strategy analysis using librosa (4 different algorithms, median consensus)
- **Beat Grid**: Computed beat grid with downbeat detection for precise beat matching
- **Key Detection**: Krumhansl-Kessler key profiles with Camelot wheel mapping
- **Auto-Mix**: Automatic track ordering by BPM/key compatibility, with scheduled transitions
- **Transition Types**: Smooth crossfade, blend, double-time, and hard cut depending on BPM difference
- **Equal-Power Crossfade**: S-curve crossfade with proper equal-power volume curves
- **Debug Tools**: BPM strategy comparison, beat grid visualization, energy profiles, transition previews, full mix log

## Setup

```bash
# Install Node.js dependencies
npm install

# Install Python dependencies (for audio analysis)
pip install librosa numpy scipy yt-dlp

# Install ffmpeg (for audio conversion)
apt-get install ffmpeg  # or brew install ffmpeg

# Start the server
npm start
```

Open http://localhost:3000 in your browser.

## Usage

1. Paste a YouTube playlist URL and click **Load Playlist**
2. Click **Analyze All** to download and analyze audio (BPM, key, energy)
3. Review the analysis in the **Debug Panel** - click any track to see its beat grid
4. Click **AUTO MIX** to start the automated mix
5. Use **TRANSITION NOW** to force an immediate transition
6. Adjust the crossfader manually for manual mixing

## Debug Tools

Click **Debug Panel** to access:

- **BPM Analysis**: Compare results from 4 different BPM detection strategies
- **Beat Grid**: Visualize detected beats vs computed grid, with consistency scoring
- **Energy Map**: See energy/brightness profile with segment classification
- **Transitions**: Review planned transition details (type, BPM match, key compat)
- **Mix Log**: Full timestamped log of all DJ engine events

## Architecture

- **Backend**: Node.js/Express server, yt-dlp for YouTube extraction
- **Analysis**: Python/librosa for BPM, beat, key, and energy analysis
- **Frontend**: Dual YouTube IFrame players with JS crossfade engine
- **Beat Matching**: Playback rate adjustment + beat-grid-aligned transitions
