import io
import shutil
import uuid
import time
import zipfile
from urllib.parse import unquote

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from backend.app import create_app
from backend.database import Account, Base, Event, LoginSession, Notification, Rotation, make_database
from backend.seed import initialize
from tests.test_domain import example_roster

KEY = "test-only-admin-key-" + "x" * 40
PASSWORD = "test-only-password-2026"


@pytest.fixture(scope="module")
def seed_db(tmp_path_factory):
    path = tmp_path_factory.mktemp("seed") / "baseline.db"
    engine, factory = make_database(f"sqlite:///{path}")
    Base.metadata.create_all(engine)
    initialize(factory, [m.__dict__ for m in example_roster()], KEY)
    engine.dispose()
    return path


@pytest.fixture
def clients(tmp_path, seed_db):
    db_path = tmp_path / "test.db"
    shutil.copyfile(seed_db, db_path)
    app = create_app(f"sqlite:///{db_path}", tmp_path / "uploads", secure_cookie=False,
                     allowed_origins=["http://testserver"])
    with TestClient(app) as admin, TestClient(app) as student, TestClient(app) as other:
        assert admin.post("/api/auth/admin", json={"key": KEY}).status_code == 200
        admin.headers["X-CSRF-Token"] = admin.cookies["class_csrf"]
        for client, sid in [(student, "900000000201"), (other, "900000000202")]:
            assert client.post("/api/auth/login", json={"student_id": sid, "password": "local-test-fixture-password"}).status_code == 200
            client.headers["X-CSRF-Token"] = client.cookies["class_csrf"]
        yield app, admin, student, other
    app.state.engine.dispose()


def change(client):
    response = client.post("/api/auth/password", json={"old_password": "local-test-fixture-password", "new_password": PASSWORD,
                                                      "confirm_password": PASSWORD})
    assert response.status_code == 200, response.text
    client.headers["X-CSRF-Token"] = client.cookies["class_csrf"]


def new_task(admin, **kwargs):
    response = admin.post("/api/tasks", json={"title": "证书收集", "description": "请交原件截图", **kwargs})
    assert response.status_code == 200, response.text
    return response.json()["id"]


def publish(admin, task):
    assert admin.post(f"/api/tasks/{task}/state", json={"state": "published"}).status_code == 200


def upload(client, task, name="proof.png", data=b"\x89PNG\r\n\x1a\nexample"):
    return client.post(f"/api/tasks/{task}/uploads", files=[("files", (name, data))])


@pytest.mark.parametrize("extension,data,mime", [
    ("JFIF", b"\xff\xd8\xff\xe0jpeg-original", "image/jpeg"),
    ("jpe", b"\xff\xd8\xff\xe0jpeg-original", "image/jpeg"),
    ("apng", b"\x89PNG\r\n\x1a\npng-original", "image/png"),
])
def test_image_suffix_aliases_preserve_original_and_safe_preview(clients, extension, data, mime):
    _, admin, student, other = clients
    task = new_task(admin, max_files=2)
    publish(admin, task)
    uploaded = upload(student, task, name=f"相册 原件.{extension}", data=data)
    assert uploaded.status_code == 200, uploaded.text
    sub = uploaded.json()
    attachment = sub["files"][0]
    assert attachment["name"] == f"相册 原件.{extension}"
    preview = student.get(f"/api/files/{attachment['id']}?preview=true")
    assert preview.headers["content-type"].startswith(mime) and preview.content == data
    assert other.get(f"/api/files/{attachment['id']}").status_code == 404
    assert student.post(f"/api/submissions/{sub['id']}/submit").status_code == 200
    with zipfile.ZipFile(io.BytesIO(admin.get(f"/api/tasks/{task}/export").content)) as archive:
        filename = f"示例班级证书收集/示例同学03_900000000201.{extension.lower()}"
        assert archive.read(filename) == data
    fake = upload(student, task, name=f"伪装图片.{extension}", data=b"<script>alert(1)</script>")
    assert fake.status_code == 200
    response = student.get(f"/api/files/{fake.json()['files'][0]['id']}?preview=true")
    assert response.headers["content-type"].startswith("application/octet-stream")
    assert response.headers["content-disposition"].startswith("attachment")


def individual_upload(client, task, draft, key, name="proof.txt", data=b"proof"):
    return client.post(f"/api/tasks/{task}/uploads",
                       data={"draft_id": draft, "upload_id": key}, files=[("files", (name, data))])


def test_individual_upload_retry_and_final_confirmation(clients):
    app, admin, student, _ = clients
    task = new_task(admin, max_files=2, max_bytes=10)
    publish(admin, task)
    draft, first, second = (str(uuid.uuid4()) for _ in range(3))
    one = individual_upload(student, task, draft, first)
    assert one.status_code == 200 and one.json()["id"] == draft
    two = individual_upload(student, task, draft, second, "other.txt", b"other")
    assert two.status_code == 200 and len(two.json()["files"]) == 2
    with app.state.factory() as db:
        event_count = len(list(db.scalars(select(Event))))
    retried = individual_upload(student, task, draft, first)
    assert retried.status_code == 200 and len(retried.json()["files"]) == 2
    with app.state.factory() as db:
        assert len(list(db.scalars(select(Event)))) == event_count
    assert {r["status"] for r in admin.get(f"/api/tasks/{task}/roster").json()} == {"missing"}
    submitted = student.post(f"/api/submissions/{draft}/submit")
    assert submitted.status_code == 200 and len(submitted.json()["files"]) == 2
    assert student.post(f"/api/submissions/{draft}/submit").json() == submitted.json()
    with zipfile.ZipFile(io.BytesIO(admin.get(f"/api/tasks/{task}/export").content)) as archive:
        assert len([f for f in archive.infolist() if not f.is_dir()]) == 2
    assert individual_upload(student, task, draft, second).status_code == 409


def test_individual_upload_identity_and_changed_retry_rejected(clients):
    _, admin, student, other = clients
    task, another = new_task(admin), new_task(admin)
    publish(admin, task)
    publish(admin, another)
    draft, key = str(uuid.uuid4()), str(uuid.uuid4())
    assert individual_upload(student, task, draft, key).status_code == 200
    assert individual_upload(other, task, draft, str(uuid.uuid4())).status_code == 404
    assert individual_upload(student, another, draft, str(uuid.uuid4())).status_code == 404
    assert individual_upload(student, task, draft, key, data=b"changed").status_code == 409
    assert individual_upload(student, task, draft, key, name="changed.txt").status_code == 409
    assert individual_upload(other, task, str(uuid.uuid4()), key).status_code == 409
    records = student.get(f"/api/tasks/{task}/submissions").json()
    assert len(records) == 1 and len(records[0]["files"]) == 1
    assert student.get(f"/api/files/{key}").content == b"proof"


def test_individual_append_failure_preserves_saved_file_and_limits(clients, monkeypatch):
    _, admin, student, _ = clients
    task = new_task(admin, max_files=2, max_bytes=5)
    publish(admin, task)
    draft, first, second = (str(uuid.uuid4()) for _ in range(3))
    assert individual_upload(student, task, draft, first).status_code == 200
    assert individual_upload(student, task, draft, second, "bad.exe").status_code == 400
    assert individual_upload(student, task, draft, second, data=b"").status_code == 400
    assert individual_upload(student, task, draft, second, data=b"local-test-fixture-password").status_code == 413
    assert student.get(f"/api/files/{first}").content == b"proof"
    records = student.get(f"/api/tasks/{task}/submissions").json()
    assert len(records) == 1 and len(records[0]["files"]) == 1
    assert individual_upload(student, task, draft, second).status_code == 200
    assert individual_upload(student, task, draft, str(uuid.uuid4())).status_code == 400
    # Storage full must not turn a successfully saved retry into a failed upload.
    monkeypatch.setenv("CLASS_STORAGE_QUOTA_BYTES", "1")
    assert individual_upload(student, task, draft, first).status_code == 200


def test_individual_upload_requires_complete_uuid_pair(clients):
    _, admin, student, _ = clients
    task = new_task(admin)
    publish(admin, task)
    files = [("files", ("proof.txt", b"proof"))]
    for data in [{"draft_id": str(uuid.uuid4())}, {"upload_id": str(uuid.uuid4())},
                 {"draft_id": str(uuid.uuid1()), "upload_id": str(uuid.uuid4())}]:
        assert student.post(f"/api/tasks/{task}/uploads", data=data, files=files).status_code == 400
    assert individual_upload(student, task, "../escape", str(uuid.uuid4())).status_code == 422


def test_individual_upload_cumulative_size_includes_saved_files(clients, monkeypatch):
    import backend.uploads
    monkeypatch.setattr(backend.uploads, "MAX_SUBMISSION_BYTES", 7)
    _, admin, student, _ = clients
    task = new_task(admin, max_files=3, max_bytes=10)
    publish(admin, task)
    draft, first, second = (str(uuid.uuid4()) for _ in range(3))
    assert individual_upload(student, task, draft, first).status_code == 200
    assert individual_upload(student, task, draft, second).status_code == 413
    records = student.get(f"/api/tasks/{task}/submissions").json()
    assert len(records) == 1 and [f["id"] for f in records[0]["files"]] == [first]
    assert individual_upload(student, task, draft, second, data=b"ok").status_code == 200


@pytest.mark.parametrize("status", ["submitted", "approved", "returned"])
def test_withdraw_latest_keeps_history_and_never_exports_old_material(clients, status):
    app, admin, student, other = clients
    task = new_task(admin)
    publish(admin, task)
    old = upload(student, task, name="old.txt", data=b"old").json()
    assert student.post(f"/api/submissions/{old['id']}/submit").status_code == 200
    current = upload(student, task, name="new.txt", data=b"new").json()
    current = student.post(f"/api/submissions/{current['id']}/submit").json()
    if status != "submitted":
        assert admin.post(f"/api/submissions/{current['id']}/review", json={"status": status, "note": "审核说明"}).status_code == 200
    if status == "submitted":
        assert student.post(f"/api/submissions/{current['id']}/withdraw", headers={"X-CSRF-Token": "wrong"}).status_code == 403
    assert other.post(f"/api/submissions/{current['id']}/withdraw").status_code == 404
    assert admin.post(f"/api/submissions/{current['id']}/withdraw").status_code == 404
    assert student.post(f"/api/submissions/{old['id']}/withdraw").status_code == 409
    withdrawn = student.post(f"/api/submissions/{current['id']}/withdraw")
    assert withdrawn.status_code == 200 and withdrawn.json()["status"] == "withdrawn"
    assert withdrawn.json()["submitted"] == current["submitted"]
    if status != "submitted":
        assert withdrawn.json()["note"] == "审核说明"
    assert admin.get(f"/api/tasks/{task}/roster").json()[0]["status"] == "missing"
    assert admin.get("/api/tasks").json()[0]["submitted_count"] == 0
    assert student.get("/api/tasks").json()[0]["my_status"] == "withdrawn"
    with zipfile.ZipFile(io.BytesIO(admin.get(f"/api/tasks/{task}/export").content)) as archive:
        assert not [f for f in archive.infolist() if not f.is_dir()]
    for record, raw in [(old, b"old"), (current, b"new")]:
        assert student.get(f"/api/files/{record['files'][0]['id']}").content == raw
        assert other.get(f"/api/files/{record['files'][0]['id']}").status_code == 404
    assert admin.post(f"/api/submissions/{current['id']}/review", json={"status": "approved"}).status_code == 409
    assert student.post(f"/api/submissions/{current['id']}/submit").status_code == 409
    assert student.post(f"/api/submissions/{current['id']}/withdraw").json() == withdrawn.json()
    with app.state.factory() as db:
        events = list(db.scalars(select(Event).where(Event.kind == "submission_withdrawn")))
        notices = list(db.scalars(select(Notification).where(Notification.title == "材料已撤回")))
        assert len(events) == 1 and events[0].payload["previous_status"] == status
        assert {n.student_id for n in notices} == {"900000000201", "900000000213"} and len(notices) == 2
    # A lost response can be retried even if the task closed after the first commit.
    assert admin.post(f"/api/tasks/{task}/state", json={"state": "closed"}).status_code == 200
    assert student.post(f"/api/submissions/{current['id']}/withdraw").json() == withdrawn.json()
    assert admin.post(f"/api/tasks/{task}/state", json={"state": "published"}).status_code == 200
    newer = upload(student, task, name="corrected.txt", data=b"corrected").json()
    assert student.post(f"/api/submissions/{newer['id']}/submit").status_code == 200
    assert student.post(f"/api/submissions/{current['id']}/withdraw").status_code == 200
    with zipfile.ZipFile(io.BytesIO(admin.get(f"/api/tasks/{task}/export").content)) as archive:
        files = [f for f in archive.infolist() if not f.is_dir()]
        assert len(files) == 1 and archive.read(files[0]) == b"corrected"


@pytest.mark.parametrize("state", ["closed", "archived"])
def test_new_withdrawal_is_forbidden_after_task_closes(clients, state):
    _, admin, student, _ = clients
    task = new_task(admin)
    publish(admin, task)
    record = upload(student, task).json()
    assert student.post(f"/api/submissions/{record['id']}/withdraw").status_code == 409
    assert student.post(f"/api/submissions/{record['id']}/submit").status_code == 200
    assert admin.post(f"/api/tasks/{task}/state", json={"state": state}).status_code == 200
    assert student.post(f"/api/submissions/{record['id']}/withdraw").status_code == 409
    assert student.get(f"/api/tasks/{task}/submissions").json()[0]["status"] == "submitted"


@pytest.mark.parametrize("allow_late", [False, True])
def test_withdrawal_obeys_deadline_and_late_policy(clients, allow_late):
    _, admin, student, _ = clients
    task = new_task(admin)
    publish(admin, task)
    record = upload(student, task).json()
    assert student.post(f"/api/submissions/{record['id']}/submit").status_code == 200
    assert admin.put(f"/api/tasks/{task}", json={"title": "截止测试", "deadline": int(time.time()) - 60, "allow_late": allow_late}).status_code == 200
    response = student.post(f"/api/submissions/{record['id']}/withdraw")
    assert response.status_code == (200 if allow_late else 409)


def test_admin_can_withdraw_own_material_without_changing_student_stats(clients):
    app, admin, student, _ = clients
    task = new_task(admin)
    publish(admin, task)
    own = upload(admin, task).json()
    assert admin.post(f"/api/submissions/{own['id']}/submit").status_code == 200
    assert student.post(f"/api/submissions/{own['id']}/withdraw").status_code == 404
    assert admin.post(f"/api/submissions/{own['id']}/withdraw").status_code == 200
    rows = admin.get(f"/api/tasks/{task}/roster").json()
    assert len(rows) == 36 and all(row["status"] == "missing" for row in rows)
    with app.state.factory() as db:
        notices = list(db.scalars(select(Notification).where(Notification.title == "材料已撤回")))
        assert len(notices) == 1 and notices[0].student_id == "900000000213"


def test_optional_password_and_session_rotation(clients):
    app, admin, student, _ = clients
    assert student.get("/api/tasks").status_code == 200
    assert student.get("/api/auth/me").json()["must_change"] is False
    old_cookie = student.cookies["class_session"]
    change(student)
    assert student.get("/api/tasks").status_code == 200
    with TestClient(app) as attacker:
        attacker.cookies.set("class_session", old_cookie)
        assert attacker.get("/api/auth/me").status_code == 401
    assert student.post("/api/auth/password", json={"old_password": "bad", "new_password": "1234567890", "confirm_password": "1234567890"}).status_code == 400
    assert student.post("/api/auth/logout").status_code == 200
    assert student.get("/api/auth/me").status_code == 401


def test_role_csrf_origin_and_unknown_login(clients):
    _, admin, student, _ = clients
    change(student)
    assert student.post("/api/tasks", json={"title": "forbidden"}).status_code == 403
    assert admin.post("/api/tasks", json={"title": "x"}, headers={"X-CSRF-Token": "bad"}).status_code == 403
    assert admin.post("/api/tasks", json={"title": "x"}, headers={"Origin": "https://evil.example"}).status_code == 403
    assert student.post("/api/auth/login", json={"student_id": "unknown", "password": "bad"}).status_code == 401


@pytest.mark.parametrize("title", ["证书收集", "示例班级证书收集"])
def test_task_publish_upload_receipt_and_export(clients, title):
    _, admin, student, other = clients
    change(student)
    change(other)
    task = new_task(admin, title=title)
    assert student.get(f"/api/tasks/{task}").status_code == 404
    publish(admin, task)
    assert len(student.get("/api/tasks").json()) == 1
    draft = upload(student, task).json()
    status = admin.get(f"/api/tasks/{task}/roster").json()
    assert len(status) == 36 and {r["status"] for r in status} == {"missing"}
    submitted = student.post(f"/api/submissions/{draft['id']}/submit")
    assert submitted.status_code == 200, submitted.text
    assert submitted.json()["status"] == "submitted"
    assert student.get("/api/tasks").json()[0]["my_status"] == "submitted"
    assert admin.get("/api/tasks").json()[0]["submitted_count"] == 1
    file_id = draft["files"][0]["id"]
    assert other.get(f"/api/files/{file_id}").status_code == 404
    assert other.post(f"/api/submissions/{draft['id']}/submit").status_code == 404
    assert other.get(f"/api/tasks/{task}/submissions").json() == []
    assert student.get(f"/api/files/{file_id}?preview=true").headers["content-type"].startswith("image/png")
    assert student.get(f"/api/tasks/{task}/export").status_code == 403
    archive = admin.get(f"/api/tasks/{task}/export")
    assert archive.status_code == 200
    assert unquote(archive.headers["content-disposition"]).endswith("示例班级证书收集.zip")
    with zipfile.ZipFile(io.BytesIO(archive.content)) as z:
        assert z.namelist() == ["示例班级证书收集/", "示例班级证书收集/示例同学03_900000000201.png"]
    assert len(list((admin.app.state.root / "exports").iterdir())) == 0


def test_upload_limits_and_dangerous_content(clients):
    app, admin, student, _ = clients
    change(student)
    task = new_task(admin, max_bytes=10)
    publish(admin, task)
    assert upload(student, task, data=b"x" * 11).status_code == 413
    assert upload(student, task, name="attack.html", data=b"x").status_code == 400
    assert upload(student, task, name="empty.pdf", data=b"").status_code == 400
    assert list((app.state.root / "uploads").iterdir()) == []
    result = upload(student, task, name="image.png", data=b"<script>").json()
    response = student.get(f"/api/files/{result['files'][0]['id']}?preview=true")
    assert response.headers["content-type"].startswith("application/octet-stream")
    assert response.headers["content-disposition"].startswith("attachment")


def test_revisions_review_and_deadline(clients):
    _, admin, student, _ = clients
    change(student)
    task = new_task(admin, review_required=True)
    publish(admin, task)
    first = upload(student, task).json()
    assert student.post(f"/api/submissions/{first['id']}/submit").status_code == 200
    assert admin.post(f"/api/submissions/{first['id']}/review", json={"status": "returned", "note": "请补清晰图"}).status_code == 200
    second = upload(student, task).json()
    assert student.post(f"/api/submissions/{second['id']}/submit").status_code == 200
    assert len(student.get(f"/api/tasks/{task}/submissions").json()) == 2
    assert admin.post(f"/api/submissions/{first['id']}/review", json={"status": "approved"}).status_code == 409
    assert admin.post(f"/api/submissions/{second['id']}/review", json={"status": "approved"}).status_code == 200
    assert admin.post(f"/api/tasks/{task}/state", json={"state": "closed"}).status_code == 200
    assert upload(student, task).status_code == 409
    overdue = new_task(admin, deadline=1)
    publish(admin, overdue)
    assert upload(student, overdue).status_code == 409


def test_draw_idempotence_pool_and_notifications(clients):
    app, admin, student, _ = clients
    change(student)
    state = student.get("/api/draw").json()
    assert len(state["eligible"]) == 24
    assert student.post("/api/draw", json={"count": 3, "key": str(uuid.uuid4())}).status_code == 403
    body = {"count": 3, "key": str(uuid.uuid4()), "expected_pool": state["pool_version"]}
    first = admin.post("/api/draw", json=body)
    assert first.status_code == 200, first.text
    assert admin.post("/api/draw", json=body).json() == first.json()
    assert len(admin.get("/api/draw").json()["eligible"]) == 21
    with app.state.factory() as db:
        assert len(list(db.scalars(select(Event).where(Event.kind == "draw")))) == 1
        assert len(list(db.scalars(select(Notification).where(Notification.title == "抽签结果已公布")))) == 37
    assert admin.post("/api/draw", json={"count": 22, "key": str(uuid.uuid4()), "expected_pool": admin.get("/api/draw").json()["pool_version"]}).status_code == 409
    assert admin.post("/api/draw", json={**body, "count": 2}).status_code == 409


def test_duty_monday_and_double_click(clients):
    _, admin, student, _ = clients
    change(student)
    state = student.get("/api/duty").json()
    assert state["next_index"] == 1 and state["date"] == "2026-11-09"
    assert [m["name"] for m in state["next"]] == ["示例同学04", "示例同学05", "示例同学06", "示例同学07", "示例同学08"]
    body = {"key": str(uuid.uuid4()), "expected_index": 1, "date": "2026-11-09", "expected_version": state["plan_version"]}
    assert admin.post("/api/duty/confirm", json={**body, "date": "2026-11-10"}).status_code == 400
    first = admin.post("/api/duty/confirm", json=body)
    assert first.status_code == 200
    assert admin.post("/api/duty/confirm", json=body).json() == first.json()
    later = admin.get("/api/duty").json()
    assert later["next_index"] == 6 and later["date"] == "2026-11-16"


def test_reset_revokes_session_and_does_not_reset_to_common_password(clients):
    _, admin, student, _ = clients
    change(student)
    response = admin.post("/api/admin/accounts/900000000201/reset")
    assert response.status_code == 200
    assert response.json()["temporary_password"] != "local-test-fixture-password"
    assert student.get("/api/auth/me").status_code == 401
    login = student.post("/api/auth/login", json={"student_id": "900000000201", "password": response.json()["temporary_password"]})
    assert login.status_code == 200 and login.json()["must_change"] is False
    assert student.get("/api/tasks").status_code == 200


def test_cycle_clear_is_explicit_and_audited(clients):
    _, admin, _, _ = clients
    body = {"key": str(uuid.uuid4()), "reason": "全班轮换完成，开启新轮", "excluded": []}
    assert admin.post("/api/draw/cycle", json=body).status_code == 200
    assert len(admin.get("/api/draw").json()["eligible"]) == 37
    assert admin.post("/api/draw/cycle", json=body).status_code == 200


def test_schedule_only_changes_date_and_storage_quota(clients, monkeypatch):
    _, admin, student, _ = clients
    change(student)
    version = admin.get("/api/duty").json()["plan_version"]
    assert admin.post("/api/duty/schedule", json={"date": "2026-11-16", "reason": "本周实验调课", "expected_version": version}).status_code == 200
    state = student.get("/api/duty").json()
    assert state["date"] == "2026-11-16" and state["next_index"] == 1
    task = new_task(admin)
    publish(admin, task)
    monkeypatch.setenv("CLASS_STORAGE_QUOTA_BYTES", "3")
    assert upload(student, task, data=b"1234").status_code == 507


def test_stale_draw_window_cannot_draw_a_changed_pool(clients):
    app, admin, _, _ = clients
    version = admin.get("/api/draw").json()["pool_version"]
    first = admin.post("/api/draw", json={"count": 3, "key": str(uuid.uuid4()), "expected_pool": version})
    assert first.status_code == 200
    second = admin.post("/api/draw", json={"count": 3, "key": str(uuid.uuid4()), "expected_pool": version})
    assert second.status_code == 409
    current = admin.get("/api/draw").json()
    assert len(current["eligible"]) == 21
    assert current["pool_version"] != version
    assert current["events"][0]["id"] == first.json()["id"]
    third = admin.post("/api/draw", json={"count": 3, "key": str(uuid.uuid4()), "expected_pool": current["pool_version"]})
    assert third.status_code == 200
    assert admin.get("/api/draw").json()["events"][0]["id"] == third.json()["id"]


def test_legacy_password_marker_does_not_block_task_submission(clients):
    app, admin, student, _ = clients
    with app.state.factory.begin() as db:
        db.get(Account, "900000000201").must_change = True
    assert student.get("/api/auth/me").json()["must_change"] is False
    task = new_task(admin)
    publish(admin, task)
    draft = upload(student, task).json()
    assert student.post(f"/api/submissions/{draft['id']}/submit").status_code == 200
    assert student.get("/api/draw").status_code == 200
    assert student.get("/api/duty").status_code == 200
