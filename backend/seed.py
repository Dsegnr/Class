"""Explicit initialization; never seed or reset users during normal app startup."""
import json
import os
import time
import uuid
from pathlib import Path

from sqlalchemy import select

from backend.database import Account, Base, Event, Rotation, StorageGuard, configuration, make_database
from backend.domain import ADMIN_ID, HISTORICAL_SELECTED_NAMES, INITIAL_EXCLUDED_NAMES, Member, duty_order, student_accounts
from backend.security import hasher


def initialize(factory, roster: list[dict], admin_key: str):
    student_password = os.environ.get("CLASS_STUDENT_PASSWORD", "")
    if len(student_password) < 12:
        raise ValueError("Set CLASS_STUDENT_PASSWORD locally (at least 12 characters)")
    members = [Member(**m) for m in roster]
    student_accounts(members)
    duty_order(members)
    if len(members) != 37 or len(admin_key) < 32:
        raise ValueError("需要37人名册以及至少32字符的独立管理员密钥")
    with factory.begin() as db:
        if db.scalar(select(Account.student_id).limit(1)):
            raise ValueError("数据库已有账号，拒绝覆盖")
        for member in members:
            admin = member.student_id == ADMIN_ID
            db.add(Account(student_id=member.student_id, name=member.name,
                           role="admin" if admin else "student",
                           credential=hasher.hash(admin_key if admin else student_password),
                           must_change=False, enabled=True))
        excluded = [m.student_id for m in members if m.name in INITIAL_EXCLUDED_NAMES]
        selected = [m.student_id for m in members if m.name in HISTORICAL_SELECTED_NAMES]
        db.add(Rotation(id=1, excluded=excluded, selected=selected, duty_index=1, duty_date="2026-11-09"))
        if not db.get(StorageGuard, 1):
            db.add(StorageGuard(id=1))
        db.add(Event(id=str(uuid.uuid4()), kind="history", key="initial-history",
                     actor=ADMIN_ID, created=int(time.time()), payload={
                         "source": "人工导入用户提供的历史，不是系统随机开奖",
                         "excluded": excluded, "selected": selected, "sequence": 1}))


if __name__ == "__main__":
    _, url = configuration()
    engine, factory = make_database(url)
    Base.metadata.create_all(engine)
    initialize(factory, json.loads(Path(os.environ.get("CLASS_ROSTER_FILE", "examples/roster.example.json")).read_text(encoding="utf-8")),
               Path(os.environ["CLASS_ADMIN_KEY_FILE"]).read_text(encoding="utf-8").strip()
               if os.environ.get("CLASS_ADMIN_KEY_FILE") else os.environ.get("CLASS_ADMIN_KEY", ""))
    print("Initialized 37 identities: 36 student logins and one administrator. Credentials not printed.")
