"""Accordario local server.

Run with:  .venv/bin/python -m uvicorn app:app --port 8765
Serves the web UI and a small JSON API for chord analysis and stem separation.

Analysis jobs run in their own thread: downloads happen in parallel (a few at
a time), then each job waits for its turn on the analyzer, which runs one song
at a time. Songs opened in the UI ("interactive") go before batch-queued ones.
"""

from __future__ import annotations

import re
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from typing import Callable

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import analysis
import stems

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
MAX_PARALLEL_DOWNLOADS = 3
FINISHED_JOB_TTL = 3600  # seconds a finished job stays visible
PRIORITY_INTERACTIVE = 0
PRIORITY_BATCH = 1

app = FastAPI(title="Accordario")


@app.middleware("http")
async def no_cache_for_ui(request: Request, call_next):
    """Always revalidate UI files so edits show up on a plain reload."""
    response = await call_next(request)
    if not request.url.path.startswith("/media/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


# --------------------------------------------------------------------------
# Jobs
# --------------------------------------------------------------------------

class Cancelled(Exception):
    pass


class AnalyzerGate:
    """Lets one job at a time use the analyzer, lowest (priority, order) first."""

    def __init__(self) -> None:
        self.cv = threading.Condition()
        self.waiting: list[dict] = []
        self.busy = False

    def _next(self) -> dict | None:
        return min(self.waiting, key=lambda j: (j["priority"], j["seq"]), default=None)

    @contextmanager
    def turn(self, job: dict):
        with self.cv:
            self.waiting.append(job)
            try:
                while self.busy or self._next() is not job:
                    if job["cancelled"]:
                        raise Cancelled()
                    self.cv.wait(timeout=1.0)
                if job["cancelled"]:
                    raise Cancelled()
            finally:
                self.waiting.remove(job)
            self.busy = True
        try:
            yield
        finally:
            with self.cv:
                self.busy = False
                self.cv.notify_all()

    def position(self, job: dict) -> int:
        """How many jobs are ahead of this one (0 = next)."""
        with self.cv:
            ordered = sorted(self.waiting, key=lambda j: (j["priority"], j["seq"]))
            return ordered.index(job) if job in ordered else 0

    def wake(self) -> None:
        with self.cv:
            self.cv.notify_all()


_gate = AnalyzerGate()
_download_slots = threading.BoundedSemaphore(MAX_PARALLEL_DOWNLOADS)
_stems_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="stems")

_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()
_seq = 0

PUBLIC_FIELDS = ("id", "kind", "videoId", "title", "status", "progress", "message", "error", "priority")


def _active_job(kind: str, video_id: str) -> dict | None:
    with _jobs_lock:
        for job in _jobs.values():
            if job["kind"] == kind and job["videoId"] == video_id and job["status"] in ("queued", "running"):
                return job
    return None


def _prune_jobs() -> None:
    now = time.time()
    with _jobs_lock:
        for job_id in [
            j["id"] for j in _jobs.values()
            if j["finishedAt"] and now - j["finishedAt"] > FINISHED_JOB_TTL
        ]:
            del _jobs[job_id]


def _new_job(kind: str, video_id: str, priority: int, **extra) -> dict:
    global _seq
    _prune_jobs()
    with _jobs_lock:
        _seq += 1
        job = {
            "id": uuid.uuid4().hex[:12],
            "kind": kind,
            "videoId": video_id,
            "title": None,
            "status": "queued",
            "progress": 0.0,
            "message": "In coda…",
            "result": None,
            "error": None,
            "priority": priority,
            "seq": _seq,
            "cancelled": False,
            "finishedAt": None,
            **extra,
        }
        _jobs[job["id"]] = job
    return job


def _progress_fn(job: dict) -> Callable[..., None]:
    def progress(message: str, fraction: float, **meta) -> None:
        job["message"] = message
        job["progress"] = round(max(0.0, min(1.0, fraction)), 3)
        if meta.get("title"):
            job["title"] = meta["title"]
    return progress


def _run_job(job: dict, work: Callable[[], dict]) -> None:
    job["status"] = "running"
    try:
        job["result"] = work()
        job["status"] = "done"
        job["progress"] = 1.0
        job["message"] = "Fatto"
    except Cancelled:
        job["status"] = "cancelled"
        job["message"] = "Annullato"
    except Exception as exc:  # report any failure to the UI
        traceback.print_exc()
        job["status"] = "error"
        job["error"] = _friendly_error(exc)
    finally:
        job["finishedAt"] = time.time()


def _friendly_error(exc: Exception) -> str:
    text = str(exc) or exc.__class__.__name__
    lowered = text.lower()
    if "private video" in lowered or "video unavailable" in lowered:
        return "Video non disponibile o privato."
    if "sign in to confirm" in lowered:
        return "YouTube chiede una verifica (età o anti-bot). Prova un altro video."
    return re.sub(r"^ERROR:\s*(\[[^\]]+\]\s*\S+:\s*)?", "", text)


def _public_job(job: dict) -> dict:
    return {k: job[k] for k in PUBLIC_FIELDS}


def _start_analysis(video_id: str, priority: int, with_stems: bool) -> dict:
    existing = _active_job("analysis", video_id)
    if existing:
        if priority < existing["priority"]:
            existing["priority"] = priority  # the user opened it: jump the queue
            _gate.wake()
        existing["withStems"] = existing.get("withStems") or with_stems
        return existing

    job = _new_job("analysis", video_id, priority, withStems=with_stems)
    progress = _progress_fn(job)

    def work() -> dict:
        if job["priority"] == PRIORITY_INTERACTIVE:
            src, info = analysis.download_audio(video_id, progress)
        else:
            progress("In attesa di scaricare…", 0.0)
            with _download_slots:
                if job["cancelled"]:
                    raise Cancelled()
                src, info = analysis.download_audio(video_id, progress)
        job["title"] = info.get("title")
        if job["cancelled"]:
            raise Cancelled()

        progress("In attesa del turno per l'analisi…", 0.2)
        with _gate.turn(job):
            result = analysis.analyze_downloaded(video_id, src, info, progress)

        if job.get("withStems") and stems.is_available() and not stems.stems_info(video_id):
            _start_stems(video_id)
        return result

    threading.Thread(target=_run_job, args=(job, work), daemon=True, name=f"analysis-{video_id}").start()
    return job


def _start_stems(video_id: str) -> dict:
    existing = _active_job("stems", video_id)
    if existing:
        return existing
    job = _new_job("stems", video_id, PRIORITY_BATCH)
    progress = _progress_fn(job)
    cached = analysis.load_cached_analysis(video_id)
    job["title"] = cached.get("title") if cached else None

    def work() -> dict:
        if job["cancelled"]:
            raise Cancelled()
        return stems.separate(video_id, progress)

    _stems_pool.submit(_run_job, job, work)
    return job


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------

class AnalyzeRequest(BaseModel):
    url: str
    force: bool = False
    batch: bool = False  # queued in bulk: lower priority than songs being opened
    stems: bool = False  # also separate stems when the analysis is done


@app.post("/api/analyze")
def start_analysis(req: AnalyzeRequest) -> dict:
    video_id = analysis.parse_video_id(req.url)
    if not video_id:
        raise HTTPException(400, "Link YouTube non valido")

    if not req.force:
        cached = analysis.load_cached_analysis(video_id)
        if cached:
            return {"videoId": video_id, "status": "done", "result": cached}

    priority = PRIORITY_BATCH if req.batch else PRIORITY_INTERACTIVE
    job = _start_analysis(video_id, priority, req.stems)
    return {"videoId": video_id, "status": job["status"], "jobId": job["id"]}


@app.get("/api/jobs")
def list_jobs() -> list[dict]:
    with _jobs_lock:
        jobs = list(_jobs.values())
    out = []
    for job in jobs:
        public = _public_job(job)
        if job["status"] == "running" and job["kind"] == "analysis" and job in _gate.waiting:
            ahead = _gate.position(job)
            public["message"] = "In attesa del turno per l'analisi…" + (f" ({ahead} prima)" if ahead else "")
        out.append(public)
    return out


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job non trovato")
    return {**_public_job(job), "result": job["result"]}


@app.delete("/api/jobs/{job_id}")
def cancel_job(job_id: str) -> dict:
    """Cancel a job that hasn't started its heavy part yet."""
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job non trovato")
    if job["status"] in ("queued", "running"):
        job["cancelled"] = True
        _gate.wake()
    return {"cancelled": job["cancelled"]}


class ResolveRequest(BaseModel):
    text: str


@app.post("/api/resolve")
def resolve_links(req: ResolveRequest) -> dict:
    """Turn pasted text (links, ids, playlists) into an ordered list of videos."""
    # Links pasted into a one-line field lose their newlines: split before "http".
    text = re.sub(r"(?<=\S)(https?://)", r" \1", req.text)
    videos: list[dict] = []
    seen: set[str] = set()
    invalid: list[str] = []
    playlist_errors: list[str] = []

    def add(video_id: str, title: str | None = None) -> None:
        if video_id not in seen:
            seen.add(video_id)
            videos.append({"videoId": video_id, "title": title})

    for token in re.split(r"[\s,;]+", text):
        if not token:
            continue
        video_id = analysis.parse_video_id(token)
        playlist_id = analysis.parse_playlist_id(token)
        if video_id:
            add(video_id)  # watch?v=X&list=Y means "this video", not the whole list
        elif playlist_id:
            try:
                for item in analysis.list_playlist(playlist_id):
                    add(item["videoId"], item["title"])
            except Exception as exc:
                traceback.print_exc()
                playlist_errors.append(_friendly_error(exc))
        else:
            invalid.append(token)
    return {"videos": videos, "invalid": invalid, "playlistErrors": playlist_errors}


@app.get("/api/songs/{video_id}")
def get_song(video_id: str) -> dict:
    data = analysis.load_cached_analysis(video_id)
    if not data:
        raise HTTPException(404, "Brano non analizzato")
    return data


@app.delete("/api/songs/{video_id}")
def delete_song(video_id: str) -> dict:
    if not analysis.parse_video_id(video_id):
        raise HTTPException(400, "Id non valido")
    for kind in ("analysis", "stems"):
        job = _active_job(kind, video_id)
        if job:
            job["cancelled"] = True
    _gate.wake()
    return {"deleted": analysis.delete_song(video_id)}


@app.get("/api/songs/{video_id}/stems")
def get_stems(video_id: str) -> dict:
    info = stems.stems_info(video_id)
    job = _active_job("stems", video_id)
    return {"available": info is not None, "info": info, "jobId": job["id"] if job else None}


@app.post("/api/songs/{video_id}/stems")
def start_stems(video_id: str) -> dict:
    if not analysis.parse_video_id(video_id):
        raise HTTPException(400, "Id non valido")
    info = stems.stems_info(video_id)
    if info:
        return {"status": "done", "result": info}
    job = _start_stems(video_id)
    return {"status": job["status"], "jobId": job["id"]}


@app.get("/media/{video_id}/source")
def media_source(video_id: str) -> FileResponse:
    """Original audio, used when a video can't be embedded."""
    if not analysis.parse_video_id(video_id):
        raise HTTPException(400, "Richiesta non valida")
    path = analysis.find_source_audio(video_id)
    if path is None:
        raise HTTPException(404, "Audio non disponibile")
    return FileResponse(path)


@app.get("/media/{video_id}/{name}")
def media(video_id: str, name: str) -> FileResponse:
    if not analysis.parse_video_id(video_id) or "/" in name or name.startswith("."):
        raise HTTPException(400, "Richiesta non valida")
    path = analysis.song_dir(video_id) / "stems" / name
    if not path.is_file():
        raise HTTPException(404, "File non trovato")
    return FileResponse(path)


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "stems": stems.is_available()}


# Static UI last, so /api and /media win.
app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
