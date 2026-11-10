import { useEffect, useRef, useState } from "react";
import { Undo2 } from "lucide-react";
import { api, message } from "./api";
import { Modal } from "./ui";
import type { Submission } from "./types";

export default function WithdrawSubmission({
  submission,
  onWithdrawn,
}: {
  submission: Submission;
  onWithdrawn: () => void;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const locked = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  function close() {
    if (!locked.current) {
      setOpen(false);
      setError("");
    }
  }
  async function withdraw() {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api<Submission>(
        `/submissions/${submission.id}/withdraw`,
        "POST",
      );
      if (!alive.current) return;
      if (result?.id !== submission.id || result.status !== "withdrawn")
        throw new Error("暂时无法确认撤回结果，请重试");
      setOpen(false);
      onWithdrawn();
    } catch (e) {
      if (alive.current) setError(message(e));
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <>
      <button className="text-button" onClick={() => setOpen(true)}>
        <Undo2 size={15} />
        撤回提交
      </button>
      {open && (
        <Modal title="撤回这次提交？" onClose={close}>
          <div className="stack">
            <p>
              撤回后，你将进入未交名单，这份材料也不会出现在导出包中。原文件和回执仍保留在历史记录里；准备好后，可重新上传并提交新版本。
            </p>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="actions">
              <button className="secondary" disabled={busy} onClick={close}>
                保留提交
              </button>
              <button className="primary" disabled={busy} onClick={withdraw}>
                {busy ? "正在撤回…" : "确认撤回"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
