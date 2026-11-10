import asyncio

from backend.body_limit import BodyLimitMiddleware


def test_declared_body_limit_rejects_without_consuming_body():
    messages = []

    async def downstream(scope, receive, send):
        raise AssertionError("oversized request must not reach parser")

    async def receive():
        raise AssertionError("oversized body must not be read")

    async def send(message):
        messages.append(message)

    asyncio.run(BodyLimitMiddleware(downstream, limit=10)(
        {"type": "http", "headers": [(b"content-length", b"11")]}, receive, send))
    assert messages[0]["status"] == 413


def test_chunked_limit_counts_actual_bytes():
    from starlette.exceptions import HTTPException
    import pytest

    async def downstream(scope, receive, send):
        await receive()
        await receive()

    async def receive():
        return {"type": "http.request", "body": b"local-test-fixture-password", "more_body": True}

    with pytest.raises(HTTPException) as error:
        asyncio.run(BodyLimitMiddleware(downstream, limit=10)(
            {"type": "http", "headers": []}, receive, None))
    assert error.value.status_code == 413
