from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse
import re
import time
import anyio


class BodyLimitMiddleware:
    """Bound multipart bytes before Starlette can spool the entire request."""
    def __init__(self, app, limit=536870912, json_limit=131072, idle_timeout=30, upload_timeout=1800):
        self.app, self.limit = app, limit
        self.json_limit, self.idle_timeout, self.upload_timeout = json_limit, idle_timeout, upload_timeout

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = dict(scope.get("headers", []))
        upload = scope.get("method") == "POST" and re.fullmatch(r"/api/tasks/[^/]+/uploads", scope.get("path", ""))
        limit = self.limit if upload else min(self.limit, self.json_limit)
        try:
            length = int(headers.get(b"content-length", b"0"))
        except ValueError:
            return await JSONResponse({"detail": "请求大小无效"}, status_code=400)(scope, receive, send)
        if length > limit or length < 0:
            return await JSONResponse({"detail": "本次请求大小超限"}, status_code=413)(scope, receive, send)
        consumed = 0
        complete = False
        deadline = time.monotonic() + (self.upload_timeout if upload else self.idle_timeout)

        async def bounded_receive():
            nonlocal consumed, complete
            if complete or scope.get("method") not in {"POST", "PUT", "PATCH"}:
                message = await receive()
            else:
                remaining = min(self.idle_timeout, deadline - time.monotonic())
                if remaining <= 0:
                    raise HTTPException(408, "接收文件或请求等待超时，请检查网络后重试")
                try:
                    with anyio.fail_after(remaining):
                        message = await receive()
                except TimeoutError:
                    raise HTTPException(408, "接收文件或请求等待超时，请检查网络后重试")
            consumed += len(message.get("body", b""))
            if consumed > limit:
                raise HTTPException(413, "本次请求大小超限")
            if message["type"] == "http.disconnect" or not message.get("more_body", False):
                complete = True
            return message

        await self.app(scope, bounded_receive, send)
