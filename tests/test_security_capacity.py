import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import HTTPException

from backend.security import BoundedHasher


def test_hash_memory_slots_bound_both_hash_and_verify_and_release_after_failure():
    entered = threading.Event()
    release = threading.Event()

    class Work:
        def hash(self, value):
            entered.set()
            assert release.wait(3)
            raise ValueError("test failure")

        def verify(self, encoded, supplied):
            return encoded == supplied

    hasher = BoundedHasher(Work(), concurrency=1, wait_seconds=0.01)
    with ThreadPoolExecutor(max_workers=1) as pool:
        running = pool.submit(hasher.hash, "not-a-credential")
        try:
            assert entered.wait(2)
            with pytest.raises(HTTPException) as error:
                hasher.verify("same", "same")
            assert error.value.status_code == 503
            assert error.value.headers["Retry-After"] == "5"
        finally:
            release.set()
        with pytest.raises(ValueError):
            running.result(timeout=2)
    assert hasher.verify("same", "same")
