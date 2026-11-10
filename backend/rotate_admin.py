"""Explicit maintenance tool; normal startup never rotates credentials."""
import argparse
import os
import stat
import time
import uuid
from pathlib import Path

from sqlalchemy import delete, select
from backend.database import Account, Event, LoginSession, configuration, make_database
from backend.domain import ADMIN_ID
from backend.security import hasher, verify


def rotate(factory, new_key):
    if not 32 <= len(new_key) <= 256:
        raise ValueError("New administrator key must contain 32 to 256 characters")
    with factory.begin() as db:
        admin = db.scalar(select(Account).where(Account.student_id == ADMIN_ID).with_for_update())
        if not admin or admin.role != "admin" or not admin.enabled:
            raise ValueError("Expected enabled administrator identity is missing")
        if verify(admin.credential, new_key):
            raise ValueError("New key must differ from the current key")
        admin.credential = hasher.hash(new_key)
        removed = db.execute(delete(LoginSession).where(LoginSession.student_id == ADMIN_ID)).rowcount
        db.add(Event(id=str(uuid.uuid4()), kind="admin_key_rotated", key=str(uuid.uuid4()),
                     actor=ADMIN_ID, created=int(time.time()), payload={"revoked_admin_sessions": removed}))
    return removed


def main():
    parser = argparse.ArgumentParser(description="Rotate only the administrator key and sessions")
    parser.add_argument('--new-key-file', required=True)
    args = parser.parse_args()
    source = Path(args.new_key_file)
    if source.is_symlink() or not source.is_file():
        raise ValueError("Use a private, regular key file")
    if os.environ.get('CLASS_ENV') == 'production':
        if Path('/data/class-materials').resolve() not in source.resolve().parents:
            raise ValueError("Production key file must remain inside the Class root")
        if stat.S_IMODE(source.stat().st_mode) & 0o077:
            raise ValueError("Key file must not be readable by group or others")
    _, url = configuration()
    engine, factory = make_database(url)
    try:
        removed = rotate(factory, source.read_text(encoding='utf-8').strip())
        print('Administrator key rotated; revoked %s administrator sessions. Student sessions unchanged.' % removed)
    finally:
        engine.dispose()


if __name__ == '__main__':
    main()
