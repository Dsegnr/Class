import asyncio
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from backend.app import create_app
from backend.database import Account, Base, Submission, make_database
from backend.seed import initialize
from tests.test_domain import example_roster
from backend.database import LoginSession, Attachment
from sqlalchemy import delete, func
from backend.body_limit import BodyLimitMiddleware


@pytest.fixture
def admission(tmp_path):
    url = 'sqlite:///' + str(tmp_path / 'qa.db')
    engine, factory = make_database(url)
    Base.metadata.create_all(engine)
    key = 'admission-test-' + uuid.uuid4().hex * 2
    initialize(factory, [m.__dict__ for m in example_roster()], key)
    app = create_app(url, tmp_path, secure_cookie=False, allowed_origins=['http://testserver'])
    with TestClient(app) as admin, TestClient(app) as student:
        assert admin.post('/api/auth/admin', json={'key': key}).status_code == 200
        admin.headers['X-CSRF-Token'] = admin.cookies['class_csrf']
        original = {'title': 'Admission QA', 'targets': ['900000000201'],
                    'max_files': 2, 'max_bytes': 4096, 'extensions': ['jpg']}
        task = admin.post('/api/tasks', json=original).json()['id']
        assert admin.post('/api/tasks/' + task + '/state', json={'state': 'published'}).status_code == 200
        assert student.post('/api/auth/login', json={'student_id': '900000000201', 'password': 'local-test-fixture-password'}).status_code == 200
        student.headers['X-CSRF-Token'] = student.cookies['class_csrf']
        yield app, factory, admin, student, task, original
    engine.dispose()


def request_without_reading_body(app, path, headers):
    sent, reads = [], []
    async def receive():
        if any(m['type'] == 'http.response.start' for m in sent):
            return {'type': 'http.disconnect'}
        reads.append(1)
        return {'type': 'http.request', 'body': b'x' * 1024, 'more_body': False}
    async def send(message):
        sent.append(message)
    asyncio.run(app({'type': 'http', 'asgi': {'version': '3.0', 'spec_version': '2.4'},
        'http_version': '1.1', 'method': 'POST', 'scheme': 'http', 'path': path,
        'raw_path': path.encode(), 'query_string': b'', 'root_path': '',
        'server': ('testserver', 80), 'client': ('127.0.0.1', 40000),
        'headers': [(b'content-type', b'multipart/form-data; boundary=qa'), *headers]}, receive, send))
    return next(m['status'] for m in sent if m['type'] == 'http.response.start'), len(reads)


@pytest.mark.parametrize('mode,status', [('anonymous', 401), ('invalid', 401), ('csrf', 403), ('disabled', 401)])
def test_upload_rejects_before_consuming_body(admission, mode, status):
    app, factory, _, student, task, _ = admission
    headers = []
    if mode == 'invalid':
        headers = [(b'cookie', b'class_session=invalid')]
    elif mode in {'csrf', 'disabled'}:
        cookie = '; '.join(k + '=' + v for k, v in student.cookies.items())
        headers = [(b'cookie', cookie.encode()), (b'x-csrf-token', b'wrong' if mode == 'csrf' else student.cookies['class_csrf'].encode())]
    if mode == 'disabled':
        with factory.begin() as db:
            db.get(Account, '900000000201').enabled = False
    actual, reads = request_without_reading_body(app, '/api/tasks/' + task + '/uploads', headers)
    assert actual == status
    assert reads == 0


@pytest.mark.parametrize('change', [{'max_files': 1}, {'max_bytes': 1000}, {'extensions': ['pdf']}])
def test_confirmation_revalidates_latest_rules_and_preserves_files(admission, change):
    _, factory, admin, student, task, original = admission
    staged = student.post('/api/tasks/' + task + '/uploads', files=[
        ('files', ('a.jpg', b'A' * 2000, 'image/jpeg')),
        ('files', ('b.jpg', b'B' * 2000, 'image/jpeg'))]).json()
    assert admin.put('/api/tasks/' + task, json={**original, **change}).status_code == 200
    rejected = student.post('/api/submissions/' + staged['id'] + '/submit')
    assert rejected.status_code == 409
    with factory() as db:
        assert db.get(Submission, staged['id']).status == 'draft'
    assert len(student.get('/api/tasks/' + task + '/submissions').json()[0]['files']) == 2
    assert admin.put('/api/tasks/' + task, json=original).status_code == 200
    accepted = student.post('/api/submissions/' + staged['id'] + '/submit')
    assert accepted.status_code == 200
    assert admin.put('/api/tasks/' + task, json={**original, **change}).status_code == 200
    assert student.post('/api/submissions/' + staged['id'] + '/submit').json()['id'] == staged['id']


def test_busy_account_rejected_without_reading_body(admission):
    app, _, _, student, task, _ = admission
    app.state.upload_slots.acquire('900000000201')
    try:
        cookie = '; '.join(k + '=' + v for k, v in student.cookies.items())
        status, reads = request_without_reading_body(app, '/api/tasks/' + task + '/uploads', [
            (b'cookie', cookie.encode()), (b'x-csrf-token', student.cookies['class_csrf'].encode())])
        assert (status, reads) == (429, 0)
    finally:
        app.state.upload_slots.release('900000000201')


@pytest.mark.parametrize('mode', ['logout', 'timeout'])
def test_mid_upload_session_revocation_and_idle_timeout_close_spools(admission, monkeypatch, mode):
    import starlette.formparsers as parsers
    app, factory, _, student, task, _ = admission
    spools = []
    original = parsers.SpooledTemporaryFile
    def tracked(*args, **kwargs):
        handle = original(*args, **kwargs); spools.append(handle); return handle
    monkeypatch.setattr(parsers, 'SpooledTemporaryFile', tracked)
    prefix = b'--qa\r\nContent-Disposition: form-data; name="files"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'
    body = prefix + (b'x' * (1024 * 1024 + 100) if mode == 'timeout' else b'abc')
    if mode == 'logout': body += b'\r\n--qa--\r\n'
    calls, messages = [], []
    async def receive():
        if not calls:
            calls.append(1)
            if mode == 'logout':
                with factory.begin() as db:
                    db.execute(delete(LoginSession).where(LoginSession.student_id == '900000000201'))
            return {'type': 'http.request', 'body': body, 'more_body': mode == 'timeout'}
        await asyncio.sleep(1)
        return {'type': 'http.disconnect'}
    async def send(m): messages.append(m)
    cookie = '; '.join(k + '=' + v for k, v in student.cookies.items())
    path = '/api/tasks/' + task + '/uploads'
    if mode == 'timeout':
        # Exercise the production middleware order, with a shorter test clock.
        next(m for m in app.user_middleware if m.cls is BodyLimitMiddleware).kwargs['idle_timeout'] = .02
        app.middleware_stack = None
    asyncio.run(app({'type':'http','asgi':{'version':'3.0','spec_version':'2.4'},
        'http_version':'1.1','method':'POST','scheme':'http','path':path,'raw_path':path.encode(),
        'query_string':b'','root_path':'','server':('testserver',80),'client':('127.0.0.1',40000),
        'headers':[(b'content-type',b'multipart/form-data; boundary=qa'),(b'cookie',cookie.encode()),
                   (b'x-csrf-token',student.cookies['class_csrf'].encode())]},receive,send))
    assert next(m['status'] for m in messages if m['type']=='http.response.start') == (408 if mode=='timeout' else 401)
    assert spools and all(f.closed for f in spools)
    assert app.state.upload_slots.active == {}
    with factory() as db:
        assert db.scalar(select(func.count()).select_from(Attachment)) == 0
