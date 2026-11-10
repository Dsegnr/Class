import asyncio

from sqlalchemy import select

from backend.database import Event, Notification
from backend.realtime import StreamLimiter, frames, snapshot
from backend.security import digest
from tests.test_api import clients, seed_db, new_task, publish  # noqa: F401


def test_snapshot_is_scoped_and_closes_database_connections(clients):
    app, admin, student, other = clients
    token = digest(student.cookies['class_session'])
    before = snapshot(app.state.factory, token)
    # Another student's private notification/login/export activity must not update us.
    with app.state.factory() as db:
        db.add(Notification(id='private', student_id='900000000202', title='private', body='private', created=1, read=False))
        db.add(Event(id='private', kind='export', key='private', actor='900000000202', created=1, payload={}))
        db.commit()
    assert snapshot(app.state.factory, token) == before
    hidden = new_task(admin, targets=['900000000202'])
    publish(admin, hidden)
    assert snapshot(app.state.factory, token) == before
    own = new_task(admin, targets=['900000000201'])
    assert snapshot(app.state.factory, token) == before  # Draft remains private.
    publish(admin, own)
    changed = snapshot(app.state.factory, token)
    assert changed != before
    with app.state.factory() as db:
        note = db.scalar(select(Notification).where(Notification.student_id == '900000000201'))
        note.read = True
        db.commit()
    assert snapshot(app.state.factory, token) != changed
    assert app.state.engine.pool.checkedout() == 0


def test_stream_revocation_disconnect_and_limits(clients):
    app, admin, student, other = clients
    assert student.get('/api/updates', headers={'Origin': 'https://untrusted.example'}).status_code == 403
    from fastapi.testclient import TestClient
    with TestClient(app) as anonymous:
        assert anonymous.get('/api/updates').status_code == 401
    limiter = app.state.realtime_limiter
    sid = '900000000201'
    leases = [limiter.acquire(sid), limiter.acquire(sid)]
    blocked = student.get('/api/updates')
    assert blocked.status_code == 429 and blocked.headers['retry-after'] == '15'
    for lease in leases:
        limiter.release(lease)
    token = digest(student.cookies['class_session'])

    class Request:
        disconnected = False
        async def is_disconnected(self):
            return self.disconnected

    async def check():
        request = Request()
        lease = limiter.acquire(sid)
        stream = frames(request, app.state.factory, token, snapshot(app.state.factory, token), limiter, lease, tick=.001)
        first = await anext(stream)
        assert first == 'retry: 3000\nevent: refresh\ndata: {}\n\n'
        task = new_task(admin, targets=[sid])
        publish(admin, task)
        assert await anext(stream) == 'event: refresh\ndata: {}\n\n'
        assert student.post('/api/auth/logout').status_code == 200
        assert await anext(stream) == 'event: revoked\ndata: {}\n\n'
        await stream.aclose()
        assert not limiter.leases
        # A transport disconnect/cancel also releases its reservation.
        other_token = digest(other.cookies['class_session'])
        lease = limiter.acquire('900000000202')
        request.disconnected = True
        stream = frames(request, app.state.factory, other_token, snapshot(app.state.factory, other_token), limiter, lease, tick=.001)
        await anext(stream)
        assert [part async for part in stream] == []
        assert not limiter.leases
    asyncio.run(check())
    assert snapshot(app.state.factory, token) is None
    assert app.state.engine.pool.checkedout() == 0
    # Whole-process cap is independent from the per-account cap.
    limited = StreamLimiter(total=1, per_account=2)
    lease = limited.acquire('one')
    import pytest
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as failure:
        limited.acquire('two')
    assert failure.value.status_code == 429
    limited.release(lease)
    limited.release(lease)  # Cleanup paths may race; release is idempotent.
