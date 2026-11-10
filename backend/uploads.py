import hashlib
import re
import time
import uuid
import zipfile
from threading import Lock
from pathlib import Path

import anyio
from fastapi import Depends, HTTPException, Request
from fastapi.responses import FileResponse
from starlette.datastructures import UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from backend.database import Account, Attachment, StorageGuard, Submission, Task

ALLOWED = set("jpg jpeg jfif jpe png apng webp gif bmp tif tiff heic heif avif pdf doc docx xls xlsx ppt pptx odt ods odp txt csv rtf md zip rar 7z mp4 mov m4a mp3 wav ogg".split())
INLINE_IMAGES = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "jfif": "image/jpeg", "jpe": "image/jpeg", "png": "image/png", "apng": "image/png", "gif": "image/gif", "webp": "image/webp", "avif": "image/avif"}
MAX_SUBMISSION_BYTES = 500 * 1024 * 1024


def safe_name(value):
    cleaned = re.sub(r'[\x00-\x1f<>:"/\\|?*]', "_", value).strip(" .")[:100]
    if cleaned.upper() in {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}:
        cleaned = "_" + cleaned
    return cleaned or "未命名"


def image_type(path):
    with path.open("rb") as f:
        data = f.read(32)
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    # AVIF inline is deliberately disabled until decoder/signature verification is added.
    return None


class ReviewBody(BaseModel):
    status: str
    note: str = Field(default="", max_length=1000)


class UploadSlots:
    """Bound parser/spool memory before accepting any file bytes."""
    def __init__(self, total=2, per_account=1):
        self.total, self.per_account = total, per_account
        self.active = {}
        self.lock = Lock()

    def acquire(self, sid):
        with self.lock:
            if sum(self.active.values()) >= self.total or self.active.get(sid, 0) >= self.per_account:
                raise HTTPException(429, "正在处理其他上传，请稍后重试", headers={"Retry-After": "5"})
            self.active[sid] = self.active.get(sid, 0) + 1

    def release(self, sid):
        with self.lock:
            count = self.active.get(sid, 0) - 1
            if count > 0:
                self.active[sid] = count
            else:
                self.active.pop(sid, None)


def install_upload_routes(app, database, member, administrator, task_access, audit, notify, validate_session):
    storage = app.state.root / "uploads"
    storage.mkdir(exist_ok=True)
    slots = app.state.upload_slots = UploadSlots()

    def latest(db, task_id, lock=False):
        statement = select(Submission).where(Submission.task_id == task_id,
                     Submission.status != "draft").order_by(Submission.submitted, Submission.id)
        if lock:
            statement = statement.with_for_update().execution_options(populate_existing=True)
        versions = list(db.scalars(statement))
        return {s.student_id: s for s in versions}

    def files_for(db, submission_id):
        return list(db.scalars(select(Attachment).where(Attachment.submission_id == submission_id).order_by(Attachment.id)))

    def view(db, sub):
        return {"id": sub.id, "task_id": sub.task_id, "student_id": sub.student_id,
                "status": sub.status, "note": sub.note, "created": sub.created, "submitted": sub.submitted,
                "files": [{"id": f.id, "name": f.original_name, "size": f.size, "sha256": f.sha256,
                           "extension": f.extension} for f in files_for(db, sub.id)]}

    def accepting(task):
        if task.state != "published":
            raise HTTPException(409, "任务尚未开放或已关闭")
        if task.deadline and int(time.time()) > task.deadline and not task.allow_late:
            raise HTTPException(409, "已超过截止时间")

    def owned(db, submission_id, user):
        sub = db.get(Submission, submission_id)
        if not sub or sub.student_id != user.student_id:
            raise HTTPException(404, "提交记录不存在")
        task_access(db, sub.task_id, user)
        return sub

    @app.post("/api/tasks/{task_id}/uploads")
    def stage(task_id: str, request: Request, user=Depends(member), db=Depends(database)):
        # No File/Form parameters: FastAPI authenticates dependencies before
        # we explicitly consume multipart bytes. Database work stays off the
        # event loop, while parsing itself runs on the loop via from_thread.
        sid = user.student_id
        task = task_access(db, task_id, user)
        accepting(task)
        max_files = task.max_files
        db.rollback()  # Release the read transaction/connection during upload.
        slots.acquire(sid)
        form = None
        try:
            async def parse():
                return await request.form(max_files=max_files, max_fields=2, max_part_size=1024)
            form = anyio.from_thread.run(parse)
            files = form.getlist("files")
            if not files or any(not isinstance(f, UploadFile) for f in files):
                raise HTTPException(422, "请选择需要上传的文件")
            try:
                draft_id = uuid.UUID(str(form["draft_id"])) if "draft_id" in form else None
                upload_id = uuid.UUID(str(form["upload_id"])) if "upload_id" in form else None
            except (ValueError, TypeError, AttributeError):
                raise HTTPException(422, "上传标识无效，请重新选择文件")
            # A logout/reset or account change while receiving bytes must not
            # authorize a later commit using the earlier admission result.
            user, _ = validate_session(request, db)
            return save_stage(task_id, files, draft_id, upload_id, user, db)
        finally:
            try:
                if form is not None:
                    anyio.from_thread.run(form.close)
            finally:
                slots.release(sid)

    def save_stage(task_id, files, draft_id, upload_id, user, db):
        guard = db.scalar(select(StorageGuard).where(StorageGuard.id == 1).with_for_update())
        if not guard:
            raise HTTPException(503, "存储尚未初始化")
        task = task_access(db, task_id, user, lock=True)
        accepting(task)
        if not 1 <= len(files) <= task.max_files:
            raise HTTPException(400, f"请上传1至{task.max_files}个文件")
        individual = draft_id is not None or upload_id is not None
        if individual and (draft_id is None or upload_id is None or len(files) != 1
                           or draft_id.version != 4 or upload_id.version != 4):
            raise HTTPException(400, "请使用完整的单文件上传标识")
        sub = db.get(Submission, str(draft_id)) if individual else None
        if sub and (sub.student_id != user.student_id or sub.task_id != task_id):
            raise HTTPException(404, "提交记录不存在")
        if sub and sub.status != "draft":
            raise HTTPException(409, "这份材料已正式提交，请重新选择文件创建新版本")
        saved_files = files_for(db, sub.id) if sub else []
        saved_size = sum(f.size for f in saved_files)
        repeated = db.get(Attachment, str(upload_id)) if individual else None
        if repeated:
            if not sub or repeated.submission_id != sub.id:
                raise HTTPException(409, "上传标识已被使用，请重新选择文件")
            # A lost response may have followed a successful commit. Re-read the
            # bounded input to distinguish retry from changed bytes under one key.
            upload = files[0]
            checksum, size = hashlib.sha256(), 0
            try:
                while chunk := upload.file.read(1024 * 1024):
                    size += len(chunk)
                    if size > task.max_bytes:
                        raise HTTPException(413, "文件大小超限")
                    checksum.update(chunk)
                original = (upload.filename or "").replace("\\", "/").split("/")[-1]
                if (original, size, checksum.hexdigest()) != (repeated.original_name, repeated.size, repeated.sha256):
                    raise HTTPException(409, "重试文件与已保存的材料不一致，请重新选择文件")
                return view(db, sub)
            finally:
                upload.file.close()
        if len(saved_files) + len(files) > task.max_files:
            raise HTTPException(400, f"这次提交最多保留{task.max_files}个文件")
        allowed = ALLOWED & set(task.extensions) if task.extensions else ALLOWED
        # Keep one bounded batch (<=500MiB) and preserve only completed uploads.
        quota = MAX_SUBMISSION_BYTES
        paths, total = [], 0
        import os
        import shutil
        storage_quota = int(os.environ.get("CLASS_STORAGE_QUOTA_BYTES", str(10 * 1024 ** 3)))
        existing = db.scalar(select(func.coalesce(func.sum(Attachment.size), 0)))
        if existing >= storage_quota or shutil.disk_usage(storage).free < 256 * 1024 * 1024:
            raise HTTPException(507, "存储空间不足，请联系管理员")
        sub = sub or Submission(id=str(draft_id) if individual else str(uuid.uuid4()),
                               task_id=task_id, student_id=user.student_id,
                               status="draft", note="", created=int(time.time()))
        try:
            db.add(sub)
            db.flush()
            for upload in files:
                original = (upload.filename or "").replace("\\", "/").split("/")[-1]
                extension = Path(original).suffix.lower().lstrip(".")
                if extension not in allowed or not original or len(original) > 240:
                    raise HTTPException(400, "文件格式暂不支持，请使用常见图片、文档或压缩包")
                file_id, size, checksum = str(upload_id) if individual else str(uuid.uuid4()), 0, hashlib.sha256()
                path = storage / file_id
                if path.exists():
                    raise HTTPException(409, "该上传标识暂不可用，请重新选择文件或联系管理员")
                paths.append(path)
                with path.open("xb") as output:
                    while chunk := upload.file.read(1024 * 1024):
                        size += len(chunk)
                        total += len(chunk)
                        if size > task.max_bytes or saved_size + total > quota:
                            raise HTTPException(413, "文件或本次上传总大小超限")
                        if existing + total > storage_quota or shutil.disk_usage(storage).free < 128 * 1024 * 1024:
                            raise HTTPException(507, "存储空间不足，请联系管理员")
                        output.write(chunk)
                        checksum.update(chunk)
                if not size:
                    raise HTTPException(400, "不能上传空文件")
                db.add(Attachment(id=file_id, submission_id=sub.id, original_name=original,
                                  extension=extension, size=size, sha256=checksum.hexdigest()))
            audit(db, user, "upload_staged", {"submission_id": sub.id, "files": len(files), "bytes": total})
            db.commit()
        except BaseException:
            db.rollback()
            for path in paths:
                path.unlink(missing_ok=True)
            raise
        finally:
            for upload in files:
                upload.file.close()
        return view(db, sub)

    @app.post("/api/submissions/{submission_id}/submit")
    def submit(submission_id: str, user=Depends(member), db=Depends(database)):
        sub = owned(db, submission_id, user)
        task = task_access(db, sub.task_id, user, lock=True)
        accepting(task)
        # User lock serializes concurrent final submissions, preserving a well-defined latest version.
        db.scalar(select(Account).where(Account.student_id == user.student_id).with_for_update())
        db.refresh(sub)
        if sub.status == "withdrawn":
            raise HTTPException(409, "这份材料已撤回，请重新上传并提交新版本")
        if sub.status != "draft":
            return view(db, sub)
        attachments = files_for(db, sub.id)
        if not attachments:
            raise HTTPException(400, "请先上传文件")
        allowed = ALLOWED & set(task.extensions) if task.extensions else ALLOWED
        if (len(attachments) > task.max_files
                or any(f.size > task.max_bytes or f.extension not in allowed for f in attachments)
                or sum(f.size for f in attachments) > MAX_SUBMISSION_BYTES):
            raise HTTPException(409, "任务文件要求已更新，请按最新数量、大小和格式重新选择文件；原暂存文件仍保留")
        if any(not (storage / f.id).is_file() or (storage / f.id).stat().st_size != f.size for f in attachments):
            raise HTTPException(409, "暂存文件不完整，请重新上传或联系管理员；原记录仍保留")
        previous = latest(db, task.id, lock=True).get(user.student_id)
        timestamp = int(time.time())
        sub.status, sub.submitted = "submitted", max(timestamp, (previous.submitted + 1) if previous else timestamp)
        audit(db, user, "submission", {"submission_id": sub.id, "task_id": task.id})
        notify(db, [user.student_id], "材料提交成功", task.title + "，回执：" + sub.id)
        db.commit()
        return view(db, sub)

    @app.post("/api/submissions/{submission_id}/withdraw")
    def withdraw(submission_id: str, user=Depends(member), db=Depends(database)):
        sub = owned(db, submission_id, user)
        task = task_access(db, sub.task_id, user, lock=True)
        db.scalar(select(Account).where(Account.student_id == user.student_id).with_for_update())
        db.refresh(sub)
        if sub.status == "withdrawn":
            return view(db, sub)
        accepting(task)
        if sub.status == "draft":
            raise HTTPException(409, "文件尚未正式提交，无需撤回")
        current = latest(db, task.id, lock=True).get(user.student_id)
        if not current or current.id != sub.id:
            raise HTTPException(409, "只能撤回自己的最新提交版本")
        if sub.status not in {"submitted", "approved", "returned"}:
            raise HTTPException(409, "当前记录不能撤回")
        previous_status = sub.status
        sub.status = "withdrawn"
        audit(db, user, "submission_withdrawn", {"submission_id": sub.id, "task_id": task.id,
                                                "previous_status": previous_status})
        admins = list(db.scalars(select(Account.student_id).where(Account.role == "admin")))
        notify(db, [user.student_id, *admins], "材料已撤回", user.name + "已撤回“" + task.title + "”，原文件保留，不计入已交。")
        db.commit()
        return view(db, sub)

    @app.get("/api/tasks/{task_id}/submissions")
    def submissions(task_id: str, user=Depends(member), db=Depends(database)):
        task_access(db, task_id, user)
        statement = select(Submission).where(Submission.task_id == task_id)
        if user.role != "admin":
            statement = statement.where(Submission.student_id == user.student_id)
        return [view(db, sub) for sub in db.scalars(statement.order_by(Submission.created.desc(), Submission.id))]

    @app.get("/api/tasks/{task_id}/roster")
    def status_roster(task_id: str, admin=Depends(administrator), db=Depends(database)):
        task = task_access(db, task_id, admin)
        current = latest(db, task_id)
        return [{"student_id": a.student_id, "name": a.name,
                 "status": (current[a.student_id].status if a.student_id in current
                            and current[a.student_id].status != "withdrawn" else "missing"),
                 "submission_id": current[a.student_id].id if a.student_id in current else None}
                for a in db.scalars(select(Account).where(Account.student_id.in_(task.targets)).order_by(Account.student_id))]

    @app.post("/api/submissions/{submission_id}/review")
    def review(submission_id: str, body: ReviewBody, admin=Depends(administrator), db=Depends(database)):
        sub = db.get(Submission, submission_id)
        if not sub or sub.status == "draft":
            raise HTTPException(404, "提交记录不存在")
        task = task_access(db, sub.task_id, admin, lock=True)
        db.refresh(sub)
        if sub.status == "withdrawn":
            raise HTTPException(409, "材料已撤回，请等待同学重新提交后再审核")
        if latest(db, task.id, lock=True).get(sub.student_id).id != sub.id:
            raise HTTPException(409, "只能审核最新提交版本")
        if body.status not in {"approved", "returned"} or body.status == "returned" and not body.note.strip():
            raise HTTPException(400, "请选择通过或退回，退回需填写原因")
        sub.status, sub.note = body.status, body.note
        audit(db, admin, "review", {"submission_id": sub.id, "status": sub.status, "note": body.note})
        notify(db, [sub.student_id], "材料审核更新", task.title + "：" + ("已通过" if sub.status == "approved" else body.note))
        db.commit()
        return view(db, sub)

    @app.get("/api/files/{file_id}")
    def download(file_id: str, preview: bool = False, user=Depends(member), db=Depends(database)):
        attachment = db.get(Attachment, file_id)
        sub = db.get(Submission, attachment.submission_id) if attachment else None
        if not sub or user.role != "admin" and sub.student_id != user.student_id:
            raise HTTPException(404, "文件不存在")
        path = storage / attachment.id
        if not path.is_file():
            raise HTTPException(404, "文件不存在，请联系管理员")
        media = image_type(path) if preview and attachment.extension in INLINE_IMAGES else None
        return FileResponse(path, filename=attachment.original_name,
                            media_type=media or "application/octet-stream",
                            content_disposition_type="inline" if media else "attachment",
                            headers={"Content-Security-Policy": "sandbox; default-src 'none'"})

    @app.get("/api/tasks/{task_id}/export")
    def export(task_id: str, include_self: bool = True, admin=Depends(administrator), db=Depends(database)):
        import tempfile
        from starlette.background import BackgroundTask
        task = task_access(db, task_id, admin)
        current = latest(db, task_id)
        accounts = {a.student_id: a for a in db.scalars(select(Account))}
        title = task.title.strip()
        root = safe_name(title if title.startswith("示例班级") else "示例班级" + title)
        exports = app.state.root / "exports"
        exports.mkdir(exist_ok=True)
        # Disk-backed ZIP avoids loading a full class of uploads into RAM.
        handle = tempfile.NamedTemporaryFile(dir=exports, suffix=".zip", delete=False)
        archive_path = Path(handle.name)
        handle.close()
        try:
            with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_STORED) as archive:
                archive.writestr(root + "/", "")
                for sid, sub in current.items():
                    if sid not in task.targets and not (include_self and sid == admin.student_id):
                        continue
                    if sub.status not in {"submitted", "approved"}:
                        continue
                    person = accounts[sid]
                    attachments = files_for(db, sub.id)
                    for index, attachment in enumerate(attachments, 1):
                        suffix = f"_{index:02d}" if len(attachments) > 1 else ""
                        filename = f"{safe_name(person.name)}_{sid}{suffix}.{attachment.extension}"
                        path = storage / attachment.id
                        if not path.is_file():
                            raise HTTPException(409, "导出文件不完整，请联系管理员检查存储")
                        archive.write(path, root + "/" + filename)
        except BaseException:
            archive_path.unlink(missing_ok=True)
            raise
        audit(db, admin, "export", {"task_id": task_id, "include_self": include_self})
        db.commit()
        return FileResponse(archive_path, media_type="application/zip", filename=root + ".zip",
                            background=BackgroundTask(archive_path.unlink, missing_ok=True))
