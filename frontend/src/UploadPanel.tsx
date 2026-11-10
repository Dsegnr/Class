import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  FileText,
  FolderOpen,
  ImagePlus,
  RotateCw,
  Send,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { api, message, stageFiles } from "./api";
import { bytes, dateTime } from "./ui";
import type { Submission, Task } from "./types";

type Item = {
  id: string;
  file: File;
  state: "waiting" | "uploading" | "ready" | "failed";
  progress: number;
  error: string;
};

function uploadIdentity() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // Older embedded mobile browsers expose secure random bytes but no randomUUID.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export default function UploadPanel({
  task,
  onSubmitted,
  onDraftsChanged,
  drafts = [],
}: {
  task: Task;
  onSubmitted: () => void;
  onDraftsChanged?: () => void;
  drafts?: Submission[];
}) {
  const [queue, setQueue] = useState<Item[]>([]),
    [dragging, setDragging] = useState(false),
    [busy, setBusy] = useState(false),
    [started, setStarted] = useState(false),
    [error, setError] = useState(""),
    [staged, setStaged] = useState<Submission | null>(null),
    [previews, setPreviews] = useState<Record<string, string>>({});
  const input = useRef<HTMLInputElement>(null),
    photos = useRef<HTMLInputElement>(null),
    draftId = useRef<string | null>(null),
    savedDraft = useRef<Submission | null>(null),
    request = useRef<AbortController | null>(null),
    locked = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current?.abort();
    };
  }, []);
  // Progress changes do not create/revoke the selected files' object URLs.
  const selection = queue.map((item) => item.id).join(",");
  useEffect(() => {
    const urls: Record<string, string> = {};
    queue
      .filter((item) => item.file.type.startsWith("image/"))
      .forEach((item) => {
        urls[item.id] = URL.createObjectURL(item.file);
      });
    setPreviews(urls);
    return () => Object.values(urls).forEach(URL.revokeObjectURL);
  }, [selection]);

  function add(next: File[]) {
    if (locked.current || started || staged) return;
    setError("");
    const files = [...queue.map((item) => item.file), ...next].filter(
      (file, i, all) =>
        all.findIndex(
          (other) =>
            other.name === file.name &&
            other.size === file.size &&
            other.lastModified === file.lastModified,
        ) === i,
    );
    if (files.length > task.max_files) {
      setError(`最多上传${task.max_files}件文件`);
      return;
    }
    if (files.some((file) => file.size > task.max_bytes)) {
      setError(`单件文件不能超过${bytes(task.max_bytes)}`);
      return;
    }
    if (files.some((file) => file.size === 0)) {
      setError("文件不能为空，请重新选择");
      return;
    }
    if (files.reduce((total, file) => total + file.size, 0) > 500 * 1048576) {
      setError("一次上传合计不能超过500 MB，请减少文件或联系管理员");
      return;
    }
    setQueue(
      files.map(
        (file) =>
          queue.find((item) => item.file === file) || {
            id: uploadIdentity(),
            file,
            state: "waiting",
            progress: 0,
            error: "",
          },
      ),
    );
  }

  async function stage(ids?: string[]) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setStarted(true);
    setError("");
    draftId.current ||= uploadIdentity();
    const working = queue.map((item) => ({ ...item }));
    const update = (item: Item) => {
      if (alive.current)
        setQueue((current) =>
          current.map((old) => (old.id === item.id ? { ...item } : old)),
        );
    };
    try {
      for (const item of working) {
        if (item.state === "ready" || (ids && !ids.includes(item.id))) continue;
        item.state = "uploading";
        item.progress = 0;
        item.error = "";
        update(item);
        const controller = new AbortController();
        request.current = controller;
        try {
          const response: Submission = await stageFiles<Submission>(
            task.id,
            [item.file],
            (percent) => {
              item.progress = Math.max(0, Math.min(100, percent));
              update(item);
            },
            {
              draftId: draftId.current,
              uploadId: item.id,
              signal: controller.signal,
            },
          );
          if (!alive.current) return;
          if (
            response?.id !== draftId.current ||
            !response.files.some((file) => file.id === item.id) ||
            working
              .filter((old) => old.state === "ready")
              .some((old) => !response.files.some((file) => file.id === old.id))
          ) {
            throw new Error(
              "暂时无法确认这件文件已完整保存，请重试或联系管理员",
            );
          }
          savedDraft.current = response;
          item.state = "ready";
          item.progress = 100;
          update(item);
        } catch (e) {
          if (!alive.current) return;
          item.state = "failed";
          item.error = message(e);
          update(item);
        } finally {
          if (request.current === controller) request.current = null;
        }
      }
      if (working.every((item) => item.state === "ready") && savedDraft.current)
        setStaged(savedDraft.current);
    } finally {
      locked.current = false;
      if (alive.current) {
        setBusy(false);
        onDraftsChanged?.();
      }
    }
  }

  async function submit() {
    if (!staged || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await api(`/submissions/${staged.id}/submit`, "POST");
      if (!alive.current) return;
      setStaged(null);
      setQueue([]);
      setStarted(false);
      draftId.current = null;
      savedDraft.current = null;
      onSubmitted();
    } catch (e) {
      if (alive.current) setError(message(e));
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function reset() {
    if (locked.current) return;
    setQueue([]);
    setStaged(null);
    setStarted(false);
    setError("");
    draftId.current = null;
    savedDraft.current = null;
    onDraftsChanged?.();
  }
  const ready = queue.filter((item) => item.state === "ready").length;
  const remaining = queue.length - ready;
  return (
    <div className="upload-panel">
      {!staged && !queue.length && drafts.length > 0 && (
        <details className="draft-recovery disclosure">
          <summary>有 {drafts.length} 次上传尚未确认提交</summary>
          <div>
            {drafts.map((draft) => (
              <div className="recovery-row" key={draft.id}>
                <span>
                  {dateTime(draft.created)} · {draft.files.length}件文件
                </span>
                <button
                  className="text-button"
                  onClick={() => setStaged(draft)}
                >
                  继续确认
                </button>
              </div>
            ))}
          </div>
        </details>
      )}
      {staged && !queue.length && (
        <div className="upload-files">
          <p className="muted small">
            以下是服务器已保存的文件，请核对齐全后再确认提交。
          </p>
          {staged.files.map((file) => (
            <div className="upload-file" key={file.id}>
              <FileText size={20} />
              <span>
                <strong>{file.name}</strong>
                <small>{bytes(file.size)}</small>
              </span>
              <span className="file-upload-state ready">
                <CheckCircle2 size={15} />
                已保存
              </span>
            </div>
          ))}
        </div>
      )}
      <div
        className={`dropzone ${dragging ? "dragging" : ""}`}
        tabIndex={0}
        onDragOver={(e) => {
          e.preventDefault();
          if (!locked.current && !started && !staged) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          add(Array.from(e.dataTransfer.files));
        }}
        onPaste={(e) => {
          const pasted = Array.from(e.clipboardData.files);
          if (pasted.length) {
            e.preventDefault();
            add(pasted);
          }
        }}
        aria-label="文件上传区域，支持拖放和粘贴图片"
      >
        <UploadCloud size={30} />
        <strong>{dragging ? "松开，加入上传队列" : "把文件放在这里"}</strong>
        <span>拖放文件，也可以粘贴截图</span>
        <div className="actions">
          <button
            className="secondary"
            disabled={busy || started || !!staged}
            onClick={() => input.current?.click()}
          >
            <FolderOpen size={16} />
            选择文件
          </button>
          <button
            className="secondary"
            disabled={busy || started || !!staged}
            onClick={() => photos.current?.click()}
          >
            <ImagePlus size={16} />
            相册 / 拍照
          </button>
        </div>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            add(Array.from(e.target.files || []));
            e.target.value = "";
          }}
        />
        <input
          ref={photos}
          type="file"
          multiple
          accept="image/*"
          hidden
          onChange={(e) => {
            add(Array.from(e.target.files || []));
            e.target.value = "";
          }}
        />
      </div>
      {queue.length > 0 && (
        <div className="upload-files">
          <div className="file-upload-summary" role="status">
            {started
              ? `已保存 ${ready} / ${queue.length} 件`
              : `已选择 ${queue.length} 件文件`}
          </div>
          {queue.map((item) => (
            <div
              className={`upload-file file-upload-row ${item.state}`}
              key={item.id}
            >
              {previews[item.id] ? (
                <img
                  src={previews[item.id]}
                  alt="待上传图片预览"
                  onError={() =>
                    setPreviews((current) => {
                      const next = { ...current };
                      delete next[item.id];
                      return next;
                    })
                  }
                />
              ) : (
                <FileText size={22} />
              )}
              <span className="file-upload-detail">
                <strong>{item.file.name}</strong>
                <small>{bytes(item.file.size)}</small>
                <span className={`file-upload-state ${item.state}`}>
                  {item.state === "ready" && <CheckCircle2 size={14} />}
                  {item.state === "waiting"
                    ? "等待上传"
                    : item.state === "ready"
                      ? "已保存"
                      : item.state === "failed"
                        ? "上传未完成"
                        : item.progress === 100
                          ? "传输完成，正在保存…"
                          : `正在传输 ${item.progress}%`}
                </span>
                {item.state === "uploading" && (
                  <progress
                    max={100}
                    value={item.progress}
                    aria-label={`${item.file.name}传输进度`}
                  />
                )}
                {item.state === "failed" && (
                  <span className="file-upload-error" role="alert">
                    {item.error}
                  </span>
                )}
              </span>
              {!started && (
                <button
                  className="icon-button"
                  aria-label={`移除${item.file.name}`}
                  onClick={() =>
                    setQueue(queue.filter((old) => old.id !== item.id))
                  }
                >
                  <Trash2 size={16} />
                </button>
              )}
              {item.state === "failed" && (
                <button
                  className="text-button file-upload-retry"
                  disabled={busy}
                  aria-label={`重试${item.file.name}`}
                  onClick={() => stage([item.id])}
                >
                  <RotateCw size={15} />
                  重试
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {staged ? (
        <div className="stage-confirm">
          <p>
            <CheckCircle2 size={18} />
            文件已上传，请确认正式提交。
          </p>
          {busy && (
            <p className="muted small" role="status">
              正在确认提交…
            </p>
          )}
          <div className="actions">
            <button className="primary" disabled={busy} onClick={submit}>
              <Send size={16} />
              确认提交
            </button>
            <button className="text-button" disabled={busy} onClick={reset}>
              重新选择文件
            </button>
          </div>
        </div>
      ) : (
        queue.length > 0 && (
          <>
            <button
              className="primary full"
              disabled={busy}
              onClick={() => stage()}
            >
              {busy ? (
                <RotateCw size={16} className="spin" />
              ) : (
                <UploadCloud size={16} />
              )}
              {busy
                ? "逐件上传中…"
                : started
                  ? `重试未完成的 ${remaining} 件文件`
                  : `上传 ${queue.length} 件文件`}
            </button>
            {started && !busy && (
              <div className="file-upload-followup">
                <p>已保存的文件无需重传。全部上传成功后，再确认正式提交。</p>
                <button className="text-button" onClick={reset}>
                  重新选择文件
                </button>
                <small>重新选择会保留服务器上的未确认记录。</small>
              </div>
            )}
          </>
        )
      )}
      <p className="upload-help">
        保留原文件。HEIC等格式可能无法预览，但仍可上传；微信、QQ文件可先保存到手机，再从“选择文件”导入。
      </p>
    </div>
  );
}
