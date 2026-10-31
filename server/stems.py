"""Stem separation with Demucs (htdemucs_6s: vocals, drums, bass, guitar, piano, other).

The stems are written as ONE multichannel FLAC (one mono channel per stem).
The browser plays it through a single <audio> element and splits the
channels with Web Audio, so stems never drift apart and the playback rate
can change without changing pitch.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path

import numpy as np

import analysis

MODEL_NAME = "htdemucs_6s"
# Channel order in the output file.
STEM_ORDER = ["vocals", "drums", "bass", "guitar", "piano", "other"]
OUTPUT_NAME = "stems.flac"

_model = None
_model_lock = threading.Lock()


def is_available() -> bool:
    try:
        import demucs  # noqa: F401
        import torch  # noqa: F401
    except ImportError:
        return False
    return True


def stems_dir(video_id: str) -> Path:
    return analysis.song_dir(video_id) / "stems"


def stems_info(video_id: str) -> dict | None:
    info_path = stems_dir(video_id) / "info.json"
    if not info_path.exists():
        return None
    info = json.loads(info_path.read_text())
    if not (stems_dir(video_id) / info["file"]).exists():
        return None
    info["url"] = f"/media/{video_id}/{info['file']}"
    return info


def _device() -> str:
    import torch

    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def _get_model():
    global _model
    with _model_lock:
        if _model is None:
            from demucs.pretrained import get_model

            _model = get_model(MODEL_NAME)
            _model.eval()
        return _model


class _ProgressTqdm:
    """Stand-in for tqdm so demucs reports chunk progress to our job."""

    def __init__(self, callback):
        self.callback = callback

    def tqdm(self, iterable, **_kwargs):
        items = list(iterable)
        total = max(len(items), 1)
        for i, item in enumerate(items):
            yield item
            self.callback((i + 1) / total)


def _run_demucs(model, wav, device: str, on_progress):
    import demucs.apply
    import torch

    original_tqdm = demucs.apply.tqdm
    demucs.apply.tqdm = _ProgressTqdm(on_progress)
    try:
        with torch.no_grad():
            return demucs.apply.apply_model(
                model, wav[None], device=device, shifts=1, split=True,
                overlap=0.25, progress=True,
            )[0]
    finally:
        demucs.apply.tqdm = original_tqdm


def separate(video_id: str, progress: analysis.ProgressFn) -> dict:
    import soundfile as sf
    import torch

    src = analysis.find_source_audio(video_id)
    if src is None:
        src, _ = analysis.download_audio(video_id, lambda m, p, **meta: progress(m, p * 0.5, **meta))

    out_dir = stems_dir(video_id)
    out_dir.mkdir(parents=True, exist_ok=True)
    tmp_wav = out_dir / "input.wav"

    progress("Preparo l'audio…", 0.1)
    analysis.decode_to_wav(src, tmp_wav, channels=2)
    try:
        audio, rate = sf.read(str(tmp_wav), dtype="float32", always_2d=True)
    finally:
        tmp_wav.unlink(missing_ok=True)

    progress("Carico il modello di separazione…", 0.12)
    model = _get_model()
    wav = torch.from_numpy(audio.T.copy())
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    wav = (wav - mean) / std

    def on_chunk(fraction: float) -> None:
        progress("Separo le tracce…", 0.15 + 0.8 * fraction)

    device = _device()
    progress("Separo le tracce…", 0.15)
    try:
        sources = _run_demucs(model, wav, device, on_chunk)
    except RuntimeError:
        if device == "cpu":
            raise
        # Some ops are missing on Apple GPUs in older torch builds.
        sources = _run_demucs(model, wav, "cpu", on_chunk)
    sources = (sources * std + mean).cpu().numpy()  # (n_sources, 2, n_samples)

    progress("Salvo le tracce…", 0.97)
    by_name = dict(zip(model.sources, sources))
    channels = [by_name[name].mean(axis=0) for name in STEM_ORDER]
    data = np.clip(np.stack(channels, axis=1), -1.0, 1.0)
    sf.write(str(out_dir / OUTPUT_NAME), data, rate, format="FLAC", subtype="PCM_16")

    info = {
        "file": OUTPUT_NAME,
        "stems": STEM_ORDER,
        "sampleRate": rate,
        "duration": round(len(data) / rate, 3),
        "model": MODEL_NAME,
    }
    (out_dir / "info.json").write_text(json.dumps(info))
    progress("Fatto", 1.0)
    return stems_info(video_id)
