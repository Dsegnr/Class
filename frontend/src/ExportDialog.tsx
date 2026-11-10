import { useEffect, useRef, useState } from "react";
import { Download, FolderArchive, RotateCw } from "lucide-react";
import { api, archiveFilename, downloadZip, message } from "./api";
import { bytes, dateTime, Loading, Modal } from "./ui";
import type { Submission, Task, User } from "./types";

// Match the server: ignore drafts, then take the newest version per person.
// Returned/withdrawn latest versions never revive older material.
export function exportContents(
  submissions: Submission[],
  task: Task,
  adminId: string,
  includeSelf: boolean,
) {
  const newest = new Map<string, Submission>();
  for (const sub of [...submissions].sort(
    (a, b) =>
      (b.submitted || 0) - (a.submitted || 0) || b.id.localeCompare(a.id),
  )) {
    if (
      sub.task_id !== task.id ||
      sub.status === "draft" ||
      newest.has(sub.student_id)
    )
      continue;
    newest.set(sub.student_id, sub);
  }
  const selected = [...newest.values()].filter(
    (sub) =>
      ["submitted", "approved"].includes(sub.status) &&
      (task.targets.includes(sub.student_id) ||
        (includeSelf && sub.student_id === adminId)),
  );
  return {
    students: selected.filter((sub) => sub.student_id !== adminId).length,
    self: selected.some((sub) => sub.student_id === adminId),
    files: selected.reduce((count, sub) => count + sub.files.length, 0),
    size: selected.reduce(
      (total, sub) =>
        total + sub.files.reduce((sum, file) => sum + file.size, 0),
      0,
    ),
  };
}

export default function ExportDialog({
  task,
  user,
  onClose,
  toast,
}: {
  task: Task;
  user: User;
  onClose: () => void;
  toast: (value: string) => void;
}) {
  const [submissions, setSubmissions] = useState<Submission[] | null>(null);
  const [includeSelf, setIncludeSelf] = useState(true);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");
  const [readAt, setReadAt] = useState(0);
  const [revision, setRevision] = useState(0);
  const [phase, setPhase] = useState<"preparing" | "receiving">("preparing");
  const [notice, setNotice] = useState("");
  const alive = useRef(true),
    request = useRef<AbortController | null>(null),
    locked = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current?.abort();
    };
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    api<Submission[]>(`/tasks/${task.id}/submissions`).then(
      (data) => {
        if (!active) return;
        setSubmissions(data);
        setReadAt(Math.floor(Date.now() / 1000));
        setLoading(false);
      },
      (e) => {
        if (!active) return;
        setError(message(e));
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [task.id, revision]);
  const contents =
    submissions &&
    exportContents(submissions, task, user.student_id, includeSelf);
  async function download() {
    if (locked.current) return;
    locked.current = true;
    const controller = new AbortController();
    request.current = controller;
    setDownloading(true);
    setError("");
    setNotice("");
    setPhase("preparing");
    try {
      await downloadZip(task.id, task.title, includeSelf, {
        signal: controller.signal,
        onPhase: (next) => {
          if (alive.current) setPhase(next);
        },
      });
      if (!alive.current) return;
      toast("材料已打包下载");
      onClose();
    } catch (e) {
      if (!alive.current) return;
      if (
        typeof e === "object" &&
        e !== null &&
        "name" in e &&
        e.name === "AbortError"
      )
        setNotice("已取消下载，可以重新下载；已提交的材料不受影响。");
      else setError(message(e));
    } finally {
      locked.current = false;
      if (request.current === controller) request.current = null;
      if (alive.current) setDownloading(false);
    }
  }
  return (
    <Modal title="下载材料" onClose={onClose}>
      <div className="stack export-preview">
        <div className="export-package">
          <FolderArchive size={27} aria-hidden="true" />
          <div>
            <strong>{archiveFilename(task.title)}</strong>
            <p>解压后为同名文件夹，文件按姓名和学号命名。</p>
          </div>
        </div>
        {loading ? (
          <Loading />
        ) : (
          contents && (
            <>
              <dl className="export-counts" aria-label="当前导出范围">
                <div>
                  <dt>学生材料</dt>
                  <dd>{contents.students} 人</dd>
                </div>
                <div>
                  <dt>本人材料</dt>
                  <dd>{contents.self ? "已包含" : "未包含"}</dd>
                </div>
                <div>
                  <dt>文件数量</dt>
                  <dd>{contents.files} 件</dd>
                </div>
                <div>
                  <dt>原文件大小</dt>
                  <dd>{bytes(contents.size)}</dd>
                </div>
              </dl>
              <label className="check-inline">
                <input
                  type="checkbox"
                  checked={includeSelf}
                  disabled={downloading}
                  onChange={(e) => setIncludeSelf(e.target.checked)}
                />
                包含我在管理员端提交的材料
              </label>
              <p className="muted small">
                材料读取于{dateTime(readAt)}
                。未提交、已撤回和待补交不打包，只保留每人最新有效版本；下载按生成时的最新提交为准。
              </p>
              {!contents.files && (
                <p className="muted">
                  当前范围还没有可下载的材料，可稍后刷新。
                </p>
              )}
            </>
          )
        )}
        {notice && (
          <p className="muted" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="actions export-actions">
          {downloading && (
            <button
              className="secondary"
              onClick={() => request.current?.abort()}
            >
              取消下载
            </button>
          )}
          <button
            className="secondary"
            disabled={loading || downloading}
            onClick={() => setRevision((value) => value + 1)}
          >
            <RotateCw size={16} />
            刷新范围
          </button>
          <button
            className="primary"
            disabled={loading || downloading || !contents?.files}
            onClick={download}
          >
            <Download size={16} />
            {downloading
              ? phase === "receiving"
                ? "正在接收文件…"
                : "正在打包…"
              : "下载压缩包"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
