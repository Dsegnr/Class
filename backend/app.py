import os
import hashlib
import json
import secrets
import time
import uuid
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.exc import SQLAlchemyError

from backend.database import Account, Event, LoginSession, Notification, Rotation, Submission, Task, configuration, make_database
from backend.domain import ADMIN_ID, ALGORITHM_VERSION, Member, draw, duty_assignments, duty_order, duty_preview, eligible_pool
from backend.security import Throttle, digest, dummy_hash, hasher, verify


def now():
    return int(time.time())


def uid():
    return str(uuid.uuid4())


class LoginBody(BaseModel):
    student_id: str = Field(min_length=1, max_length=32)
    password: str = Field(min_length=1, max_length=256)


class KeyBody(BaseModel):
    key: str = Field(min_length=1, max_length=256)


class PasswordBody(BaseModel):
    old_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=10, max_length=128)
    confirm_password: str = Field(min_length=10, max_length=128)


class TaskBody(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=20000)
    deadline: int | None = None
    targets: list[str] | None = None
    max_files: int = Field(default=20, ge=1, le=100)
    max_bytes: int = Field(default=104857600, ge=1, le=524288000)
    allow_late: bool = False
    review_required: bool = False
    extensions: list[str] = Field(default_factory=list, max_length=60)


class StateBody(BaseModel):
    state: str


class DrawBody(BaseModel):
    count: int = Field(ge=1, le=37)
    key: str = Field(min_length=16, max_length=80)
    expected_pool: str = Field(min_length=64, max_length=64)


class CycleBody(BaseModel):
    key: str = Field(min_length=16, max_length=80)
    reason: str = Field(min_length=3, max_length=300)
    excluded: list[str] = Field(default_factory=list, max_length=37)


class DutyBody(BaseModel):
    key: str = Field(min_length=16, max_length=80)
    expected_index: int = Field(ge=0, le=36)
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    expected_version: str | None = Field(default=None, min_length=64, max_length=64)


class DutyScheduleBody(BaseModel):
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    reason: str = Field(min_length=3, max_length=300)
    expected_version: str | None = Field(default=None, min_length=64, max_length=64)
    key: str | None = Field(default=None, min_length=16, max_length=80)


class DutyReplacement(BaseModel):
    original_id: str = Field(pattern=r"^[0-9]{12}$")
    substitute_id: str = Field(pattern=r"^[0-9]{12}$")


class DutyPlanBody(BaseModel):
    key: str = Field(min_length=16, max_length=80)
    expected_version: str = Field(min_length=64, max_length=64)
    replacements: list[DutyReplacement] = Field(max_length=5)
    reason: str = Field(min_length=3, max_length=300)


def create_app(database_url=None, data_dir=None, secure_cookie=None, allowed_origins=None):
    if database_url is None:
        root, database_url = configuration()
    else:
        root = Path(data_dir).resolve()
    root.mkdir(parents=True, exist_ok=True)
    engine, factory = make_database(database_url)
    app = FastAPI(title="Class API", docs_url=None, redoc_url=None)
    from backend.body_limit import BodyLimitMiddleware
    app.add_middleware(BodyLimitMiddleware)
    app.state.factory, app.state.engine, app.state.root = factory, engine, root
    secure = secure_cookie if secure_cookie is not None else os.environ.get("CLASS_SECURE_COOKIE", "1") == "1"
    cookie_path = os.environ.get("CLASS_COOKIE_PATH", "/")
    origins = set(allowed_origins or os.environ.get("CLASS_ORIGINS", "http://127.0.0.1:5173,http://localhost:5173").split(","))
    throttle = Throttle()

    @app.middleware("http")
    async def guards(request, call_next):
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            origin = request.headers.get("origin")
            if origin and origin not in origins:
                from fastapi.responses import JSONResponse
                return JSONResponse({"detail": "来源不受信任"}, status_code=403)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Cache-Control"] = "no-store"
        return response

    def database():
        with factory() as db:
            yield db

    def session(request: Request, db=Depends(database)):
        token = request.cookies.get("class_session", "")
        row = db.get(LoginSession, digest(token)) if token else None
        user = db.get(Account, row.student_id) if row and row.expires > now() else None
        if not user or not user.enabled:
            raise HTTPException(401, "请重新登录")
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            csrf = request.headers.get("x-csrf-token", "")
            if not csrf or not secrets.compare_digest(row.csrf_hash, digest(csrf)):
                raise HTTPException(403, "请求校验失败，请刷新后重试")
        return user, row

    def member(identity=Depends(session)):
        user, _ = identity
        return user

    def administrator(user=Depends(member)):
        if user.role != "admin":
            raise HTTPException(403, "仅管理员可执行此操作")
        return user

    def issue(db, user, response):
        token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        lifetime = 3600 if user.role == "admin" else 86400
        db.add(LoginSession(token_hash=digest(token), csrf_hash=digest(csrf),
                            student_id=user.student_id, expires=now() + lifetime))
        db.commit()
        response.set_cookie("class_session", token, httponly=True, secure=secure,
                            samesite="strict", max_age=lifetime, path=cookie_path)
        response.set_cookie("class_csrf", csrf, httponly=False, secure=secure,
                            samesite="strict", max_age=lifetime, path=cookie_path)
        return {"student_id": user.student_id, "name": user.name, "role": user.role,
                "must_change": False, "csrf": csrf}

    def audit(db, user, kind, payload, key=None):
        event = Event(id=uid(), kind=kind, key=key or uid(), actor=user.student_id,
                      payload=payload, created=now())
        db.add(event)
        return event

    def notify(db, recipients, title, body):
        for sid in set(recipients):
            db.add(Notification(id=uid(), student_id=sid, title=title, body=body, created=now(), read=False))

    def roster(db):
        return [Member(a.student_id, a.name) for a in db.scalars(select(Account).order_by(Account.student_id))]

    def task_access(db, task_id, user, lock=False):
        statement = select(Task).where(Task.id == task_id)
        if lock:
            statement = statement.with_for_update().execution_options(populate_existing=True)
        task = db.scalar(statement)
        if not task or user.role != "admin" and (task.state == "draft" or user.student_id not in task.targets):
            raise HTTPException(404, "任务不存在")
        return task

    @app.get("/api/health")
    def health(db=Depends(database)):
        try:
            db.execute(select(1))
            ready = db.get(Rotation, 1)
        except SQLAlchemyError:
            raise HTTPException(503, "数据库尚未初始化")
        if not ready:
            raise HTTPException(503, "班级名册尚未初始化")
        return {"status": "ok"}

    @app.post("/api/auth/login")
    def login(body: LoginBody, request: Request, response: Response, db=Depends(database)):
        # Campus Wi-Fi can put the whole class behind one public address.
        throttle.check("ip:" + request.client.host, 120)
        throttle.check("account:" + body.student_id)
        user = db.scalar(select(Account).where(Account.student_id == body.student_id).with_for_update())
        valid = verify(user.credential if user and user.role == "student" else dummy_hash, body.password)
        if not valid or not user or not user.enabled or user.role != "student":
            raise HTTPException(401, "学号或密码不正确")
        return issue(db, user, response)

    @app.post("/api/auth/admin")
    def admin_login(body: KeyBody, request: Request, response: Response, db=Depends(database)):
        throttle.check("admin:" + request.client.host)
        user = db.scalar(select(Account).where(Account.student_id == ADMIN_ID).with_for_update())
        if not verify(user.credential if user else dummy_hash, body.key) or not user or not user.enabled:
            raise HTTPException(401, "密钥不正确")
        return issue(db, user, response)

    @app.get("/api/auth/me")
    def me(request: Request, identity=Depends(session)):
        user, _ = identity
        return {"student_id": user.student_id, "name": user.name, "role": user.role,
                "must_change": False, "csrf": request.cookies.get("class_csrf", "")}

    @app.post("/api/auth/password")
    def password(body: PasswordBody, response: Response, identity=Depends(session), db=Depends(database)):
        user, _ = identity
        db.scalar(select(Account).where(Account.student_id == user.student_id).with_for_update()
                  .execution_options(populate_existing=True))
        if user.role != "student":
            raise HTTPException(400, "管理员使用密钥，请在运维配置中更换")
        if body.new_password != body.confirm_password or body.new_password == body.old_password:
            raise HTTPException(400, "新密码两次输入需一致，且不能与原密码相同")
        throttle.check("password:" + user.student_id)
        if not verify(user.credential, body.old_password):
            raise HTTPException(400, "原密码不正确")
        user.credential, user.must_change = hasher.hash(body.new_password), False
        db.execute(delete(LoginSession).where(LoginSession.student_id == user.student_id))
        audit(db, user, "password_changed", {})
        return issue(db, user, response)

    @app.post("/api/auth/logout")
    def logout(response: Response, identity=Depends(session), db=Depends(database)):
        db.delete(identity[1])
        db.commit()
        response.delete_cookie("class_session", path=cookie_path)
        response.delete_cookie("class_csrf", path=cookie_path)
        return {"ok": True}

    @app.post("/api/admin/accounts/{sid}/reset")
    def reset(sid: str, admin=Depends(administrator), db=Depends(database)):
        user = db.scalar(select(Account).where(Account.student_id == sid).with_for_update())
        if not user or user.role != "student":
            raise HTTPException(404, "学生账号不存在")
        # Temporary reset secret is returned once, never stored in plaintext/logged.
        temporary = secrets.token_urlsafe(12)
        user.credential, user.must_change = hasher.hash(temporary), False
        db.execute(delete(LoginSession).where(LoginSession.student_id == sid))
        audit(db, admin, "password_reset", {"student_id": sid})
        db.commit()
        return {"temporary_password": temporary}

    @app.get("/api/members")
    def members(user=Depends(member), db=Depends(database)):
        return [{"student_id": a.student_id, "name": a.name} for a in roster(db)]

    def task_view(task):
        return {k: getattr(task, k) for k in ("id", "title", "description", "state", "deadline", "targets",
                                            "max_files", "max_bytes", "allow_late", "review_required", "extensions", "created")}

    @app.get("/api/tasks")
    def tasks(user=Depends(member), db=Depends(database)):
        visible = [t for t in db.scalars(select(Task).order_by(Task.created.desc(), Task.id))
                   if user.role == "admin" or t.state != "draft" and user.student_id in t.targets]
        statement = select(Submission).where(Submission.status != "draft")
        if user.role != "admin":
            statement = statement.where(Submission.student_id == user.student_id)
        current = {}
        for submission in db.scalars(statement.order_by(Submission.submitted, Submission.id)):
            current[(submission.task_id, submission.student_id)] = submission.status
        result = []
        for task in visible:
            item = task_view(task)
            item["my_status"] = current.get((task.id, user.student_id), "missing")
            if user.role == "admin":
                item["submitted_count"] = sum(current.get((task.id, sid)) in {"submitted", "approved"}
                                              for sid in task.targets)
            result.append(item)
        return result

    def apply_task(body, db, task):
        fields = body.model_dump()
        targets = fields.pop("targets")
        student_ids = set(db.scalars(select(Account.student_id).where(Account.role == "student")))
        targets = sorted(set(targets if targets is not None else student_ids))
        if set(targets) - student_ids or not targets:
            raise HTTPException(400, "任务对象需为有效学生账号")
        if not body.title.strip():
            raise HTTPException(400, "任务标题不能为空")
        extensions = [e.lower().lstrip(".") for e in body.extensions]
        if any(not e.isascii() or not e.isalnum() or len(e) > 15 for e in extensions):
            raise HTTPException(400, "文件格式配置无效")
        fields["extensions"] = sorted(set(extensions))
        for key, value in fields.items():
            setattr(task, key, value)
        task.targets = targets

    @app.post("/api/tasks")
    def create_task(body: TaskBody, admin=Depends(administrator), db=Depends(database)):
        task = Task(id=uid(), state="draft", created=now())
        apply_task(body, db, task)
        db.add(task)
        audit(db, admin, "task_created", {"task_id": task.id})
        db.commit()
        return task_view(task)

    @app.get("/api/tasks/{task_id}")
    def get_task(task_id: str, user=Depends(member), db=Depends(database)):
        return task_view(task_access(db, task_id, user))

    @app.put("/api/tasks/{task_id}")
    def edit_task(task_id: str, body: TaskBody, admin=Depends(administrator), db=Depends(database)):
        task = task_access(db, task_id, admin, lock=True)
        if task.state == "archived":
            raise HTTPException(409, "归档任务不可编辑")
        old_targets = list(task.targets)
        apply_task(body, db, task)
        if task.state != "draft" and old_targets != task.targets:
            db.rollback()
            raise HTTPException(409, "发布后不能变更任务对象，请新建任务")
        audit(db, admin, "task_edited", {"task_id": task.id})
        if task.state == "published":
            notify(db, task.targets, "任务要求已更新", task.title)
        db.commit()
        return task_view(task)

    @app.post("/api/tasks/{task_id}/state")
    def task_state(task_id: str, body: StateBody, admin=Depends(administrator), db=Depends(database)):
        task = task_access(db, task_id, admin, lock=True)
        transitions = {"draft": {"published"}, "published": {"closed", "archived"},
                       "closed": {"published", "archived"}, "archived": set()}
        if body.state not in transitions[task.state]:
            raise HTTPException(409, "任务状态变更无效")
        task.state = body.state
        audit(db, admin, "task_state", {"task_id": task.id, "state": task.state})
        notify(db, task.targets, "新任务" if body.state == "published" else "任务状态更新", task.title)
        db.commit()
        return task_view(task)

    def event_view(event):
        return {"id": event.id, "kind": event.kind, "created": event.created, "payload": event.payload}

    def rotation_lock(db):
        row = db.scalar(select(Rotation).where(Rotation.id == 1).with_for_update())
        if not row:
            raise HTTPException(503, "班级名册尚未初始化")
        return row

    def pool_version(db, pool):
        # Include the round history so a new cycle cannot reuse an old request's
        # version even if its eligible people happen to be identical.
        events = list(db.scalars(select(Event.id).where(Event.kind.in_(["draw", "cycle", "history"]))
                                  .order_by(Event.id)))
        encoded = json.dumps([[p.student_id for p in pool], events], separators=(",", ":"))
        return hashlib.sha256(encoded.encode()).hexdigest()

    def next_draw_sequence(db):
        return db.scalar(select(func.count()).select_from(Event).where(Event.kind.in_(["draw", "cycle", "history"]))) + 1

    @app.get("/api/draw")
    def draw_state(user=Depends(member), db=Depends(database)):
        rotation = rotation_lock(db)
        if not rotation:
            raise HTTPException(503, "班级名册尚未初始化")
        pool = eligible_pool(roster(db), set(rotation.excluded), set(rotation.selected))
        events = list(db.scalars(select(Event).where(Event.kind.in_(["draw", "cycle", "history"]))))
        events.sort(key=lambda e: (e.payload.get("sequence", 0), e.created, e.id), reverse=True)
        return {"eligible": [m.__dict__ for m in pool], "excluded": rotation.excluded,
                "selected": rotation.selected, "algorithm": ALGORITHM_VERSION,
                "pool_version": pool_version(db, pool),
                "events": [event_view(e) for e in events[:100]]}

    @app.post("/api/draw")
    def run_draw(body: DrawBody, admin=Depends(administrator), db=Depends(database)):
        rotation = rotation_lock(db)
        key = "draw:" + body.key
        # Current read after rotation lock: MySQL's earlier auth snapshot may predate
        # another request's commit, so a plain SELECT could miss its idempotency row.
        previous = db.scalar(select(Event).where(Event.key == key).with_for_update())
        if previous:
            if previous.payload["count"] != body.count or previous.payload.get("pool_version") != body.expected_pool:
                raise HTTPException(409, "同一请求不能改变抽取人数")
            return event_view(previous)
        pool = eligible_pool(roster(db), set(rotation.excluded), set(rotation.selected))
        if body.expected_pool != pool_version(db, pool):
            raise HTTPException(409, "候选名单已变化，请刷新后重新确认抽签")
        if body.count > len(pool):
            raise HTTPException(409, "剩余候选不足，请先处理当前轮次")
        winners = draw(pool, body.count)
        payload = {"pool": [m.__dict__ for m in pool], "winners": [m.__dict__ for m in winners],
                   "count": body.count, "algorithm": ALGORITHM_VERSION, "source": "system",
                   "pool_version": body.expected_pool,
                   "sequence": next_draw_sequence(db)}
        rotation.selected = rotation.selected + [m.student_id for m in winners]
        event = audit(db, admin, "draw", payload, key)
        names = "、".join(m.name for m in winners)
        notify(db, [m.student_id for m in roster(db)], "抽签结果已公布", f"本次选中：{names}")
        db.commit()
        return event_view(event)

    @app.post("/api/draw/cycle")
    def new_cycle(body: CycleBody, admin=Depends(administrator), db=Depends(database)):
        rotation = rotation_lock(db)
        previous = db.scalar(select(Event).where(Event.key == "cycle:" + body.key).with_for_update())
        if previous:
            if previous.payload["reason"] != body.reason or previous.payload["excluded"] != sorted(set(body.excluded)):
                raise HTTPException(409, "同一请求不能更改轮次参数")
            return event_view(previous)
        if set(body.excluded) - {m.student_id for m in roster(db)}:
            raise HTTPException(400, "排除名单有未知成员")
        event = audit(db, admin, "cycle", {"reason": body.reason, "old_excluded": rotation.excluded,
                      "old_selected": rotation.selected, "excluded": sorted(set(body.excluded)),
                      "sequence": next_draw_sequence(db)}, "cycle:" + body.key)
        rotation.selected, rotation.excluded = [], sorted(set(body.excluded))
        notify(db, [m.student_id for m in roster(db)], "抽签开启新轮次", body.reason)
        db.commit()
        return event_view(event)

    def duty_plan(db, rotation):
        # Rotation's row lock serializes plan/date/confirmation. Revisions are
        # explicit: timestamps and random UUID ordering cannot identify "latest".
        generation = db.scalar(select(func.count()).select_from(Event).where(Event.kind == "duty"))
        latest = db.scalar(select(Event).where(Event.kind == "duty_plan",
            Event.payload["generation"].as_integer() == generation)
            .order_by(Event.payload["revision"].as_integer().desc()).limit(1))
        members = roster(db)
        order = duty_order(members)
        pairs = latest.payload["replacements"] if latest else []
        try:
            assigned = duty_assignments(order, rotation.duty_index,
                {p["original_id"]: p["substitute_id"] for p in pairs})
        except (KeyError, ValueError) as exc:
            raise HTTPException(503, "值日安排记录需要核对，请联系管理员") from exc
        schedules = db.scalar(select(func.count()).select_from(Event).where(Event.kind == "duty_schedule"))
        version = hashlib.sha256(json.dumps([generation, schedules, rotation.duty_index, rotation.duty_date,
            latest.id if latest else None, [m.student_id for m in order]], separators=(",", ":")).encode()).hexdigest()
        return {"generation": generation, "revision": latest.payload["revision"] if latest else 0,
                "version": version, "latest": latest, "order": order, "assigned": assigned, "pairs": pairs,
                "exempt": [m for m in members if m.student_id not in {p.student_id for p in order}]}

    def require_duty_version(plan, expected):
        # An old cached UI has no version token. It must refresh, including
        # when the current group has no substitution, rather than edit blindly.
        if expected != plan["version"]:
            raise HTTPException(409, "值日安排已变化，请刷新页面或重新读取并核对日期和人员后再操作")

    @app.get("/api/duty")
    def duty(user=Depends(member), db=Depends(database)):
        rotation = rotation_lock(db)
        plan = duty_plan(db, rotation)
        return {"next_index": rotation.duty_index, "date": rotation.duty_date,
                "next": [m.__dict__ for m in plan["assigned"]],
                "base_next": [m.__dict__ for m in duty_preview(plan["order"], rotation.duty_index)],
                "plan_version": plan["version"], "replacements": plan["pairs"],
                "reason": plan["latest"].payload["reason"] if plan["latest"] else "",
                "order": [m.__dict__ for m in plan["order"]],
                "exempt": [m.__dict__ for m in plan["exempt"]],
                "plan_events": [event_view(e) for e in db.scalars(select(Event).where(Event.kind == "duty_plan")
                    .order_by(Event.payload["generation"].as_integer().desc(),
                              Event.payload["revision"].as_integer().desc()).limit(30))],
                "events": [event_view(e) for e in db.scalars(select(Event).where(Event.kind == "duty")
                            .order_by(Event.created.desc()).limit(50))]}

    @app.post("/api/duty/plan")
    def change_duty_plan(body: DutyPlanBody, admin=Depends(administrator), db=Depends(database)):
        rotation = rotation_lock(db)
        pairs = sorted([p.model_dump() for p in body.replacements], key=lambda p: p["original_id"])
        reason = body.reason.strip()
        if len(reason) < 3 or len({p["original_id"] for p in pairs}) != len(pairs):
            raise HTTPException(400, "请填写至少3字说明，每位原排同学只能调整一次")
        request = {"expected_version": body.expected_version, "replacements": pairs, "reason": reason}
        previous = db.scalar(select(Event).where(Event.key == "duty-plan:" + body.key).with_for_update())
        if previous:
            if previous.payload["request"] != request:
                raise HTTPException(409, "同一请求不能修改人员或说明，请重新读取安排")
            return event_view(previous)
        plan = duty_plan(db, rotation)
        require_duty_version(plan, body.expected_version)
        try:
            assigned = duty_assignments(plan["order"], rotation.duty_index,
                {p["original_id"]: p["substitute_id"] for p in pairs})
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        if pairs == plan["pairs"]:
            raise HTTPException(400, "人员安排没有变化，无需再次保存")
        event = audit(db, admin, "duty_plan", {"date": rotation.duty_date, "next_index": rotation.duty_index,
            "generation": plan["generation"], "revision": plan["revision"] + 1, "request": request,
            "replacements": pairs, "reason": reason,
            "before": [m.__dict__ for m in plan["assigned"]], "members": [m.__dict__ for m in assigned],
            "base_members": [m.__dict__ for m in duty_preview(plan["order"], rotation.duty_index)]},
            "duty-plan:" + body.key)
        recipients = {m.student_id for m in plan["assigned"] + assigned
            + duty_preview(plan["order"], rotation.duty_index)}
        notify(db, recipients, "物理值日人员调整", rotation.duty_date + "值日："
            + "、".join(m.name for m in assigned) + "。说明：" + reason
            + "。仅调整该日期，后续仍按原顺序轮换，不自动抵扣替班者将来值日。")
        db.commit()
        return event_view(event)

    @app.post("/api/duty/confirm")
    def confirm_duty(body: DutyBody, admin=Depends(administrator), db=Depends(database)):
        from datetime import date, timedelta
        try:
            day = date.fromisoformat(body.date)
        except ValueError:
            raise HTTPException(400, "日期无效")
        if day.weekday() != 0:
            raise HTTPException(400, "物理值日日期应为周一")
        rotation = rotation_lock(db)
        previous = db.scalar(select(Event).where(Event.key == "duty:" + body.key).with_for_update())
        if previous:
            if (previous.payload["date"] != body.date
                    or ("request" in previous.payload and previous.payload["request"] != body.model_dump())):
                raise HTTPException(409, "同一确认请求不能更改日期")
            return event_view(previous)
        if rotation.duty_index != body.expected_index or rotation.duty_date != body.date:
            raise HTTPException(409, "值日顺序或日期已变化，请刷新")
        plan = duty_plan(db, rotation)
        require_duty_version(plan, body.expected_version)
        group = plan["assigned"]
        event = audit(db, admin, "duty", {"date": body.date, "members": [m.__dict__ for m in group],
            "base_members": [m.__dict__ for m in duty_preview(plan["order"], rotation.duty_index)],
            "replacements": plan["pairs"], "plan_version": plan["version"],
            "reason": plan["latest"].payload["reason"] if plan["latest"] else "",
            "request": body.model_dump()}, "duty:" + body.key)
        rotation.duty_index = (rotation.duty_index + 5) % len(plan["order"])
        rotation.duty_date = (day + timedelta(days=7)).isoformat()
        notify(db, [m.student_id for m in group], "物理值日已记录", body.date)
        db.commit()
        return event_view(event)

    @app.post("/api/duty/schedule")
    def schedule_duty(body: DutyScheduleBody, admin=Depends(administrator), db=Depends(database)):
        from datetime import date
        try:
            day = date.fromisoformat(body.date)
        except ValueError:
            raise HTTPException(400, "日期无效")
        if day.weekday() != 0:
            raise HTTPException(400, "物理值日日期应为周一")
        rotation = rotation_lock(db)
        request = {"date": body.date, "reason": body.reason.strip(), "expected_version": body.expected_version}
        if len(request["reason"]) < 3:
            raise HTTPException(400, "请填写至少3字调整说明")
        if body.key:
            previous = db.scalar(select(Event).where(Event.key == "duty-schedule:" + body.key).with_for_update())
            if previous:
                if previous.payload["request"] != request:
                    raise HTTPException(409, "同一请求不能更改日期或说明")
                return {"ok": True, "date": previous.payload["date"]}
        plan = duty_plan(db, rotation)
        require_duty_version(plan, body.expected_version)
        audit(db, admin, "duty_schedule", {"old_date": rotation.duty_date,
              "date": body.date, "reason": request["reason"], "request": request},
              "duty-schedule:" + body.key if body.key else None)
        rotation.duty_date = body.date
        notify(db, [m.student_id for m in plan["assigned"]], "物理值日日期更新", body.date + "：" + request["reason"])
        db.commit()
        return {"ok": True, "date": rotation.duty_date}

    @app.get("/api/notifications")
    def notifications(user=Depends(member), db=Depends(database)):
        return [{"id": n.id, "title": n.title, "body": n.body, "read": n.read, "created": n.created}
                for n in db.scalars(select(Notification).where(Notification.student_id == user.student_id)
                                    .order_by(Notification.created.desc(), Notification.id).limit(100))]

    @app.post("/api/notifications/{notification_id}/read")
    def read_notification(notification_id: str, user=Depends(member), db=Depends(database)):
        item = db.get(Notification, notification_id)
        if not item or item.student_id != user.student_id:
            raise HTTPException(404, "通知不存在")
        item.read = True
        db.commit()
        return {"ok": True}

    @app.get("/api/admin/audit")
    def audits(admin=Depends(administrator), db=Depends(database)):
        return [event_view(e) for e in db.scalars(select(Event).order_by(Event.created.desc()).limit(200))]

    from backend.uploads import install_upload_routes
    install_upload_routes(app, database, member, administrator, task_access, audit, notify, session)
    from backend.realtime import install_realtime
    install_realtime(app, factory, origins)
    return app
