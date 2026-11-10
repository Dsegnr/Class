import hashlib
import secrets
import threading
import time
from collections import defaultdict, deque

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from fastapi import HTTPException

class BoundedHasher:
    """Bound Argon2 memory use on the 2 GiB host without weakening stored hashes.

    One production worker, two 64 MiB Argon2 operations at a time. Waiting
    requests have a deadline and receive a retryable response rather than OOM.
    """
    def __init__(self, implementation=None, concurrency=2, wait_seconds=5):
        self.implementation = implementation or PasswordHasher()
        self.slots = threading.BoundedSemaphore(concurrency)
        self.wait_seconds = wait_seconds

    def _call(self, method, *args):
        if not self.slots.acquire(timeout=self.wait_seconds):
            raise HTTPException(503, "登录服务正在处理较多请求，请稍后重试", headers={"Retry-After": "5"})
        try:
            return getattr(self.implementation, method)(*args)
        finally:
            self.slots.release()

    def hash(self, value):
        return self._call("hash", value)

    def verify(self, encoded, supplied):
        return self._call("verify", encoded, supplied)


hasher = BoundedHasher()
# Verify a dummy hash on unknown accounts to avoid the largest timing discrepancy.
dummy_hash = hasher.hash(secrets.token_urlsafe(24))


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def verify(encoded: str, supplied: str) -> bool:
    try:
        return hasher.verify(encoded, supplied)
    except (VerificationError, InvalidHashError):
        return False


class Throttle:
    """Single-process fallback. Production Nginx must also limit login requests."""
    def __init__(self):
        self.entries = defaultdict(deque)
        self.lock = threading.Lock()

    def check(self, key: str, limit=12, window=300):
        now = time.monotonic()
        with self.lock:
            if len(self.entries) > 10000:
                self.entries = defaultdict(deque, {
                    k: q for k, q in self.entries.items() if q and q[-1] > now - window})
            q = self.entries[key]
            while q and q[0] < now - window:
                q.popleft()
            if len(q) >= limit:
                raise HTTPException(429, "尝试过于频繁，请稍后重试", headers={"Retry-After": str(window)})
            q.append(now)
