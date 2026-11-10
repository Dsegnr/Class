import uuid
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from backend.app import create_app
from backend.database import Base, Event, make_database
from backend.rotate_admin import rotate
from backend.seed import initialize
from tests.test_domain import example_roster


def test_rotation_revokes_only_admin_and_never_logs_key(tmp_path):
    engine, factory = make_database('sqlite:///' + str(tmp_path/'qa.db'))
    Base.metadata.create_all(engine)
    old, new = uuid.uuid4().hex * 2, uuid.uuid4().hex * 2
    initialize(factory, [m.__dict__ for m in example_roster()], old)
    app = create_app('sqlite:///' + str(tmp_path/'qa.db'),tmp_path,secure_cookie=False)
    with TestClient(app) as admin, TestClient(app) as student:
        assert admin.post('/api/auth/admin',json={'key':old}).status_code==200
        assert student.post('/api/auth/login',json={'student_id':'900000000201','password':'local-test-fixture-password'}).status_code==200
        with pytest.raises(ValueError):rotate(factory,old)
        assert admin.get('/api/auth/me').status_code==200
        assert rotate(factory,new)==1
        assert admin.get('/api/auth/me').status_code==401
        assert student.get('/api/auth/me').status_code==200
        assert admin.post('/api/auth/admin',json={'key':old}).status_code==401
        assert admin.post('/api/auth/admin',json={'key':new}).status_code==200
        with factory() as db:
            event=db.scalar(select(Event).where(Event.kind=='admin_key_rotated'))
            assert event and event.payload=={'revoked_admin_sessions':1}
            assert old not in str(event.payload) and new not in str(event.payload)
    engine.dispose()
