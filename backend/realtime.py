"""Bounded, authenticated invalidation stream; authoritative data stays in GET APIs."""
import time
import uuid
from threading import Lock

import anyio
from fastapi import HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import case, func, or_, select
from sqlalchemy.exc import SQLAlchemyError
from starlette.background import BackgroundTask

from backend.database import Account, Event, LoginSession, Notification, Task
from backend.security import digest


class StreamLimiter:
    def __init__(self, total=96, per_account=2):
        self.total, self.per_account = total, per_account
        self.lock = Lock()
        self.leases = {}

    def acquire(self, sid):
        with self.lock:
            now = time.monotonic()
            self.leases = {key: value for key, value in self.leases.items() if value[1] > now}
            if len(self.leases) >= self.total or sum(value[0] == sid for value in self.leases.values()) >= self.per_account:
                raise HTTPException(429, "实时连接较多，页面将自动使用定时更新", headers={"Retry-After": "15"})
            key = uuid.uuid4().hex
            # Expiry bounds an orphaned reservation even if the transport never starts.
            self.leases[key] = (sid, now + 65)
            return key

    def release(self, key):
        with self.lock:
            self.leases.pop(key, None)


def snapshot(factory, token_hash):
    """No live ORM object/session/connection escapes this function."""
    with factory() as db:
        session = db.get(LoginSession, token_hash)
        user = db.get(Account, session.student_id) if session and session.expires > int(time.time()) else None
        if not user or not user.enabled:
            return None
        if user.role == "admin":
            events = db.scalar(select(func.count()).select_from(Event))
            visible = ()
        else:
            visible = tuple(sorted(t.id for t in db.execute(select(Task.id, Task.state, Task.targets))
                                   if t.state != "draft" and user.student_id in t.targets))
            event_scope = or_(
                Event.kind.in_(["draw", "cycle", "history", "duty", "duty_schedule", "duty_plan"]),
                Event.kind.in_(["task_created", "task_edited", "task_state"])
                & Event.payload["task_id"].as_string().in_(visible),
            )
            events = db.scalar(select(func.count()).select_from(Event).where(event_scope))
        notices = db.execute(select(
            func.count(Notification.id),
            func.coalesce(func.sum(case((Notification.read.is_(False), 1), else_=0)), 0),
        ).where(Notification.student_id == user.student_id)).one()
        return user.student_id, (int(events), int(notices[0]), int(notices[1]), visible)


async def frames(request, factory, token_hash, initial, limiter, lease, *, tick=2, lifetime=55):
    started = heartbeat = time.monotonic()
    previous = initial
    try:
        # Reconnects always reread state; Last-Event-ID cannot bypass authorization.
        yield "retry: 3000\nevent: refresh\ndata: {}\n\n"
        while time.monotonic() - started < lifetime:
            await anyio.sleep(tick)
            if await request.is_disconnected():
                return
            try:
                current = await anyio.to_thread.run_sync(snapshot, factory, token_hash)
            except SQLAlchemyError:
                return  # Transport retry and ordinary API polling handle outages.
            if current is None:
                yield "event: revoked\ndata: {}\n\n"
                return
            if current != previous:
                previous = current
                yield "event: refresh\ndata: {}\n\n"
                heartbeat = time.monotonic()
            elif time.monotonic() - heartbeat >= 10:
                yield "event: heartbeat\ndata: {}\n\n"
                heartbeat = time.monotonic()
    finally:
        limiter.release(lease)


def install_realtime(app, factory, origins):
    limiter = StreamLimiter()
    app.state.realtime_limiter = limiter

    @app.get("/api/updates")
    async def updates(request: Request):
        if request.headers.get("origin") and request.headers["origin"] not in origins:
            raise HTTPException(403, "来源不受信任")
        token = request.cookies.get("class_session", "")
        initial = await anyio.to_thread.run_sync(snapshot, factory, digest(token)) if token else None
        if initial is None:
            raise HTTPException(401, "请重新登录")
        lease = limiter.acquire(initial[0])
        return StreamingResponse(
            frames(request, factory, digest(token), initial, limiter, lease),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
            background=BackgroundTask(limiter.release, lease),
        )
