"""Additive schema bootstrap for the pre-release schema. Never drops or resets data."""
from backend.database import Base, StorageGuard, configuration, make_database


def upgrade(engine, factory):
    # Version 1 consists of new tables only. Future ALTER operations require
    # explicit numbered migration scripts; create_all does not alter old columns.
    Base.metadata.create_all(engine)
    with factory.begin() as db:
        if not db.get(StorageGuard, 1):
            db.add(StorageGuard(id=1))


if __name__ == "__main__":
    _, url = configuration()
    engine, factory = make_database(url)
    upgrade(engine, factory)
    print("Additive schema bootstrap complete. Existing accounts and materials preserved.")
