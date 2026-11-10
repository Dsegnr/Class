import os
from pathlib import Path

from sqlalchemy import JSON, Boolean, ForeignKey, Integer, String, Text, create_engine
from sqlalchemy.engine import URL, make_url
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker


class Base(DeclarativeBase):
    pass


class Account(Base):
    __tablename__ = "accounts"
    student_id: Mapped[str] = mapped_column(String(12), primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    role: Mapped[str] = mapped_column(String(16), default="student")
    credential: Mapped[str] = mapped_column(Text)
    must_change: Mapped[bool] = mapped_column(Boolean, default=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)


class LoginSession(Base):
    __tablename__ = "login_sessions"
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    student_id: Mapped[str] = mapped_column(ForeignKey("accounts.student_id"), index=True)
    csrf_hash: Mapped[str] = mapped_column(String(64))
    expires: Mapped[int] = mapped_column(Integer)


class Task(Base):
    __tablename__ = "tasks"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    title: Mapped[str] = mapped_column(String(160))
    description: Mapped[str] = mapped_column(Text)
    state: Mapped[str] = mapped_column(String(16), default="draft")
    deadline: Mapped[int | None] = mapped_column(Integer, nullable=True)
    targets: Mapped[list] = mapped_column(JSON)
    max_files: Mapped[int] = mapped_column(Integer, default=20)
    max_bytes: Mapped[int] = mapped_column(Integer, default=104857600)
    allow_late: Mapped[bool] = mapped_column(Boolean, default=False)
    review_required: Mapped[bool] = mapped_column(Boolean, default=False)
    extensions: Mapped[list] = mapped_column(JSON, default=list)
    created: Mapped[int] = mapped_column(Integer)


class Submission(Base):
    __tablename__ = "submissions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    task_id: Mapped[str] = mapped_column(ForeignKey("tasks.id"), index=True)
    student_id: Mapped[str] = mapped_column(ForeignKey("accounts.student_id"), index=True)
    status: Mapped[str] = mapped_column(String(16), default="submitted")
    note: Mapped[str] = mapped_column(Text, default="")
    created: Mapped[int] = mapped_column(Integer)
    submitted: Mapped[int | None] = mapped_column(Integer, nullable=True)


class Attachment(Base):
    __tablename__ = "attachments"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    submission_id: Mapped[str] = mapped_column(ForeignKey("submissions.id"), index=True)
    original_name: Mapped[str] = mapped_column(String(240))
    extension: Mapped[str] = mapped_column(String(16))
    size: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64))


class Rotation(Base):
    __tablename__ = "rotations"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    excluded: Mapped[list] = mapped_column(JSON)
    selected: Mapped[list] = mapped_column(JSON)
    duty_index: Mapped[int] = mapped_column(Integer, default=1)
    duty_date: Mapped[str] = mapped_column(String(10), default="2026-11-09")


class StorageGuard(Base):
    __tablename__ = "storage_guard"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)


class Event(Base):
    __tablename__ = "events"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    kind: Mapped[str] = mapped_column(String(32), index=True)
    key: Mapped[str] = mapped_column(String(120), unique=True)
    actor: Mapped[str] = mapped_column(String(12))
    payload: Mapped[dict] = mapped_column(JSON)
    created: Mapped[int] = mapped_column(Integer)


class Notification(Base):
    __tablename__ = "notifications"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    student_id: Mapped[str] = mapped_column(ForeignKey("accounts.student_id"), index=True)
    title: Mapped[str] = mapped_column(String(160))
    body: Mapped[str] = mapped_column(Text)
    read: Mapped[bool] = mapped_column(Boolean, default=False)
    created: Mapped[int] = mapped_column(Integer)


def make_database(url: str | URL):
    options = ({"connect_args": {"check_same_thread": False}} if make_url(url).get_backend_name() == "sqlite"
               else {"isolation_level": "READ COMMITTED"})
    engine = create_engine(url, pool_pre_ping=True, **options)
    return engine, sessionmaker(engine, expire_on_commit=False)


def configuration():
    root = Path(os.environ.get("CLASS_DATA_DIR", "runtime")).resolve()
    if os.environ.get("CLASS_ENV") == "production" and not root.is_relative_to(Path("/data/class-materials").resolve()):
        raise ValueError("Production data must stay under /data/class-materials")
    root.mkdir(parents=True, exist_ok=True)
    direct, secret = os.environ.get("CLASS_DATABASE_URL"), os.environ.get("CLASS_DATABASE_URL_FILE")
    if direct and secret:
        raise ValueError("Set database URL or its secret file, not both")
    url = Path(secret).read_text(encoding="utf-8").strip() if secret else direct
    if secret and not url:
        raise ValueError("Database URL secret is empty")
    if os.environ.get("CLASS_ENV") == "production" and not (url or "").startswith("mysql+pymysql://"):
        raise ValueError("Production requires an explicitly configured MySQL database")
    return root, url or f"sqlite:///{root / 'class.db'}"
