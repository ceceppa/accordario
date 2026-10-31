"""Audio download and music analysis: beats, downbeats, chords and key.

Chords and beats are detected with madmom's neural networks:
  - chords: CNN chord features + CRF decoding (major/minor vocabulary)
  - beats:  RNN downbeat activations + DBN tracking (3/4 or 4/4)
  - key:    CNN key recognition
Chords are then aligned to beats so the UI can show a beat grid.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Callable

import numpy as np

BASE_DIR = Path(__file__).resolve().parent
CACHE_DIR = BASE_DIR / "cache"
SAMPLE_RATE = 44100
ANALYSIS_VERSION = 1
MAX_DURATION = 30 * 60  # seconds; longer videos take too long to analyze

ProgressFn = Callable[..., None]  # (message, fraction, **meta)

_YT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
_PLAYLIST_RE = re.compile(r"[?&]list=([A-Za-z0-9_-]{10,})")
# Recent YouTube extraction needs a JS runtime: use whatever exists.
JS_RUNTIMES = {"deno": {}, "node": {}, "bun": {}}
PLAYLIST_LIMIT = 200


def parse_video_id(text: str) -> str | None:
    """Extract a YouTube video id from a URL or a bare id."""
    text = (text or "").strip()
    if _YT_ID_RE.match(text):
        return text
    patterns = [
        r"(?:v=|vi=)([A-Za-z0-9_-]{11})",
        r"youtu\.be/([A-Za-z0-9_-]{11})",
        r"/(?:embed|shorts|live|v)/([A-Za-z0-9_-]{11})",
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            return match.group(1)
    return None


def parse_playlist_id(text: str) -> str | None:
    match = _PLAYLIST_RE.search(text or "")
    return match.group(1) if match else None


def list_playlist(playlist_id: str) -> list[dict]:
    """Video ids and titles of a playlist, without downloading anything."""
    import yt_dlp

    opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": "in_playlist",
        "skip_download": True,
        "playlistend": PLAYLIST_LIMIT,
        "js_runtimes": JS_RUNTIMES,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"https://www.youtube.com/playlist?list={playlist_id}", download=False)
    videos = []
    for entry in info.get("entries") or []:
        video_id = (entry or {}).get("id") or ""
        title = (entry or {}).get("title") or ""
        if _YT_ID_RE.match(video_id) and title not in ("[Private video]", "[Deleted video]"):
            videos.append({"videoId": video_id, "title": title})
    return videos


def song_dir(video_id: str) -> Path:
    return CACHE_DIR / video_id


def analysis_path(video_id: str) -> Path:
    return song_dir(video_id) / "analysis.json"


def load_cached_analysis(video_id: str) -> dict | None:
    path = analysis_path(video_id)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    if data.get("version") != ANALYSIS_VERSION:
        return None
    return data


def find_source_audio(video_id: str) -> Path | None:
    for path in song_dir(video_id).glob("source.*"):
        if path.suffix not in (".part", ".ytdl"):
            return path
    return None


# --------------------------------------------------------------------------
# Download
# --------------------------------------------------------------------------

def download_audio(video_id: str, progress: ProgressFn) -> tuple[Path, dict]:
    """Download the best audio stream of a video. Returns (path, info)."""
    import yt_dlp

    out_dir = song_dir(video_id)
    out_dir.mkdir(parents=True, exist_ok=True)
    info_path = out_dir / "info.json"

    existing = find_source_audio(video_id)
    if existing and info_path.exists():
        return existing, json.loads(info_path.read_text())

    def hook(d: dict) -> None:
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            done = d.get("downloaded_bytes") or 0
            frac = (done / total) if total else 0.0
            progress("Scarico l'audio da YouTube…", 0.02 + 0.18 * frac)

    opts = {
        "format": "bestaudio/best",
        "outtmpl": str(out_dir / "source.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "progress_hooks": [hook],
        "js_runtimes": JS_RUNTIMES,
    }
    progress("Scarico l'audio da YouTube…", 0.02)
    with yt_dlp.YoutubeDL(opts) as ydl:
        raw = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
        if raw.get("is_live"):
            raise RuntimeError("Le dirette non sono supportate")
        if (raw.get("duration") or 0) > MAX_DURATION:
            raise RuntimeError(
                f"Video troppo lungo ({round(raw['duration'] / 60)} min): il limite è {MAX_DURATION // 60} minuti"
            )
        progress("Scarico l'audio da YouTube…", 0.03, title=raw.get("title"))
        raw = ydl.process_ie_result(raw, download=True)

    info = {
        "videoId": video_id,
        "title": raw.get("title") or video_id,
        "channel": raw.get("uploader") or raw.get("channel") or "",
        "duration": raw.get("duration") or 0,
        "embeddable": is_embeddable(raw),
    }
    info_path.write_text(json.dumps(info, ensure_ascii=False))
    path = find_source_audio(video_id)
    if path is None:
        raise RuntimeError("Download completato ma file audio non trovato")
    return path, info


def is_embeddable(raw: dict) -> bool | None:
    """Whether YouTube lets other sites embed the video (None = unknown)."""
    if (raw.get("age_limit") or 0) >= 18:
        return False
    value = raw.get("playable_in_embed")
    return None if value is None else bool(value)


def decode_to_wav(src: Path, dst: Path, channels: int = 1) -> Path:
    """Decode any audio file to 44.1 kHz 16-bit WAV using ffmpeg."""
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
        "-vn", "-ac", str(channels), "-ar", str(SAMPLE_RATE),
        "-sample_fmt", "s16", str(dst),
    ]
    subprocess.run(cmd, check=True)
    return dst


# --------------------------------------------------------------------------
# Models (loaded lazily, shared, used from one worker thread at a time)
# --------------------------------------------------------------------------

_models: dict | None = None
_models_lock = threading.Lock()


def get_models() -> dict:
    global _models
    with _models_lock:
        if _models is None:
            from madmom.features.chords import (
                CNNChordFeatureProcessor,
                CRFChordRecognitionProcessor,
            )
            from madmom.features.downbeats import (
                DBNDownBeatTrackingProcessor,
                RNNDownBeatProcessor,
            )
            from madmom.features.key import CNNKeyRecognitionProcessor

            _models = {
                "chord_features": CNNChordFeatureProcessor(),
                "chord_decoder": CRFChordRecognitionProcessor(),
                "downbeat_act": RNNDownBeatProcessor(),
                "downbeat_track": DBNDownBeatTrackingProcessor(
                    beats_per_bar=[3, 4], fps=100
                ),
                "key": CNNKeyRecognitionProcessor(),
            }
        return _models


# --------------------------------------------------------------------------
# Analysis
# --------------------------------------------------------------------------

# Chord/key class ids used by madmom: 0-11 major (root A..G#), 12-23 minor, 24 none.
PITCH_NAMES = ["A", "A#", "B", "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#"]
KEY_ROOT_NAMES = ["A", "Bb", "B", "C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab"]
NO_CHORD = 24
CHORD_FPS = 10  # frame rate of CNNChordFeatureProcessor

# Beat-level decoding parameters (tuned by ear on reference songs).
KEY_PRIOR = 0.7  # log-penalty for chords outside the detected key
CHANGE_PENALTY = {"downbeat": 0.3, "half_bar": 0.6, "weak": 1.0}


def chord_label(state: int) -> str:
    if state == NO_CHORD:
        return "N"
    return PITCH_NAMES[state % 12] + ("m" if state >= 12 else "")


def crf_posteriors(crf, features: np.ndarray) -> np.ndarray:
    """Frame-wise chord probabilities from madmom's linear-chain CRF.

    madmom only exposes Viterbi decoding; here we run forward-backward with
    the same parameters to get P(chord | audio) for every frame.
    """
    from scipy.special import logsumexp

    emissions = crf.c + features @ crf.W
    n_frames, n_states = emissions.shape
    log_a = np.empty((n_frames, n_states))
    log_b = np.empty((n_frames, n_states))
    log_a[0] = emissions[0] + logsumexp(crf.pi[:, None] + crf.A, axis=0)
    for t in range(1, n_frames):
        log_a[t] = emissions[t] + logsumexp(log_a[t - 1][:, None] + crf.A, axis=0)
    log_b[-1] = crf.tau
    for t in range(n_frames - 2, -1, -1):
        log_b[t] = logsumexp(crf.A + (emissions[t + 1] + log_b[t + 1])[None, :], axis=1)
    log_p = log_a + log_b
    log_p -= logsumexp(log_p, axis=1, keepdims=True)
    return np.exp(log_p)


def key_log_prior(key_class: int) -> np.ndarray:
    """Small bonus for chords that belong to the key (diatonic triads)."""
    tonic, minor = key_class % 12, key_class >= 12
    prior = np.full(25, -KEY_PRIOR)
    if minor:  # natural minor plus the major V of harmonic minor
        majors, minors = [3, 8, 10, 7], [0, 5, 7]
    else:
        majors, minors = [0, 5, 7], [2, 4, 9]
    for step in majors:
        prior[(tonic + step) % 12] = 0.0
    for step in minors:
        prior[12 + (tonic + step) % 12] = 0.0
    return prior


def decode_beat_chords(
    posteriors: np.ndarray,
    beat_times: np.ndarray,
    beat_ends: np.ndarray,
    beat_pos: np.ndarray,
    key_class: int,
) -> list[str]:
    """Pick one chord per beat with a beat-synchronous Viterbi.

    Observation = average chord probability over the beat. Changing chord
    costs a penalty that is lowest on the downbeat, so changes snap to bar
    lines unless the audio clearly says otherwise.
    """
    frame_centers = (np.arange(len(posteriors)) + 0.5) / CHORD_FPS
    obs = np.empty((len(beat_times), posteriors.shape[1]))
    for i, (start, end) in enumerate(zip(beat_times, beat_ends)):
        lo, hi = np.searchsorted(frame_centers, [start, end])
        if hi <= lo:
            lo = min(int(start * CHORD_FPS), len(posteriors) - 1)
            hi = lo + 1
        obs[i] = posteriors[lo:hi].mean(axis=0)
    obs = np.log(obs + 1e-4) + key_log_prior(key_class)

    beats_per_bar = int(beat_pos.max())

    def penalty(pos: int) -> float:
        if pos == 1:
            return CHANGE_PENALTY["downbeat"]
        if beats_per_bar == 4 and pos == 3:
            return CHANGE_PENALTY["half_bar"]
        return CHANGE_PENALTY["weak"]

    n_beats, n_states = obs.shape
    states = np.arange(n_states)
    score = obs[0].copy()
    back = np.zeros((n_beats, n_states), dtype=int)
    for i in range(1, n_beats):
        best_prev = int(score.argmax())
        change = score[best_prev] - penalty(int(beat_pos[i]))
        back[i] = np.where(score >= change, states, best_prev)
        score = np.maximum(score, change) + obs[i]
    path = np.empty(n_beats, dtype=int)
    path[-1] = int(score.argmax())
    for i in range(n_beats - 1, 0, -1):
        path[i - 1] = back[i, path[i]]
    return [chord_label(int(s)) for s in path]


def analyze_file(wav_path: Path, progress: ProgressFn) -> dict:
    """Run beat, chord and key analysis on a mono 44.1 kHz wav."""
    from concurrent.futures import ThreadPoolExecutor

    from madmom.audio.signal import Signal

    progress("Carico i modelli…", 0.22)
    models = get_models()
    signal = Signal(str(wav_path), sample_rate=SAMPLE_RATE, num_channels=1)
    duration = len(signal) / SAMPLE_RATE

    def chords_and_key():
        features = models["chord_features"](signal)
        posteriors = crf_posteriors(models["chord_decoder"].processors[0], features)
        key_probs = models["key"](signal)
        return posteriors, int(np.asarray(key_probs)[0].argmax())

    def beats():
        return models["downbeat_track"](models["downbeat_act"](signal))

    progress("Riconosco accordi, ritmo e battute…", 0.3)
    # numpy/OpenCV release the GIL, so the two networks run in parallel.
    with ThreadPoolExecutor(max_workers=2) as pool:
        chord_job = pool.submit(chords_and_key)
        beat_job = pool.submit(beats)
        beat_data = beat_job.result()
        progress("Allineo gli accordi alle battute…", 0.8)
        posteriors, key_class = chord_job.result()

    if len(beat_data) < 2:
        raise RuntimeError("Non sono riuscito a rilevare le battute del brano")
    beat_times = beat_data[:, 0].astype(float)
    beat_pos = beat_data[:, 1].astype(int)

    median_ibi = float(np.median(np.diff(beat_times)))
    beat_ends = np.append(beat_times[1:], min(beat_times[-1] + median_ibi, duration))
    labels = decode_beat_chords(posteriors, beat_times, beat_ends, beat_pos, key_class)

    key_label = KEY_ROOT_NAMES[key_class % 12] + (" minor" if key_class >= 12 else " major")
    return {
        "bpm": round(60.0 / median_ibi, 1),
        "key": key_label,
        # The DBN chooses a single meter (3 or 4) for the whole piece.
        "beatsPerBar": int(beat_pos.max()),
        "beats": [round(t, 3) for t in beat_times.tolist()],
        "beatPos": beat_pos.tolist(),
        "beatChords": labels,
        "audioDuration": round(duration, 3),
    }


def analyze_video(video_id: str, progress: ProgressFn) -> dict:
    """Full pipeline: download, decode, analyze, cache."""
    src, info = download_audio(video_id, progress)
    return analyze_downloaded(video_id, src, info, progress)


def analyze_downloaded(video_id: str, src: Path, info: dict, progress: ProgressFn) -> dict:
    """Analyze an already downloaded file and cache the result."""
    progress("Decodifico l'audio…", 0.2)
    wav = song_dir(video_id) / "mono.wav"
    decode_to_wav(src, wav, channels=1)
    try:
        result = analyze_file(wav, progress)
    finally:
        wav.unlink(missing_ok=True)

    data = {"version": ANALYSIS_VERSION, **info, **result}
    if not data.get("duration"):
        data["duration"] = result["audioDuration"]
    analysis_path(video_id).write_text(json.dumps(data, ensure_ascii=False))
    progress("Fatto", 1.0)
    return data


def delete_song(video_id: str) -> bool:
    path = song_dir(video_id)
    if path.exists() and path.parent == CACHE_DIR:
        shutil.rmtree(path)
        return True
    return False
