import { useEffect, useRef, type ReactNode } from "react";
import { X, LoaderCircle, FileText, ChevronRight } from "lucide-react";
import type { Person } from "./types";

export const labels: Record<string, string> = {
  draft: "草稿",
  published: "进行中",
  closed: "已截止",
  archived: "已归档",
  missing: "未提交",
  submitted: "已提交",
  returned: "待补交",
  withdrawn: "已撤回",
  approved: "已通过",
};
export function Badge({ state }: { state: string }) {
  return <span className={`badge ${state}`}>{labels[state] || state}</span>;
}
export function Loading() {
  return (
    <div className="empty compact" role="status">
      <LoaderCircle className="spin" size={24} />
      正在读取…
    </div>
  );
}
export function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <FileText size={30} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef(document.activeElement as HTMLElement);
  useEffect(() => {
    const previous = previousFocus.current;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.showModal();
    return () => {
      ref.current?.close();
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? "wide" : ""}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-labelledby="modal-title"
    >
      <div className="modal-inner">
        <header>
          <h2 id="modal-title">{title}</h2>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="关闭弹窗"
          >
            <X />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
export function People({ people }: { people: Person[] }) {
  return (
    <div className="people-list">
      {people.map((p, index) => (
        <div className="person" key={p.student_id}>
          <span className="person-no">
            {String(index + 1).padStart(2, "0")}
          </span>
          <strong>{p.name}</strong>
          <span className="student-id">{p.student_id}</span>
        </div>
      ))}
    </div>
  );
}

export function ConfirmModal({
  title,
  description,
  label,
  onConfirm,
  onClose,
  busy = false,
}: {
  title: string;
  description: string;
  label: string;
  onConfirm: () => void;
  onClose: () => void;
  busy?: boolean;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="stack">
        <p>{description}</p>
        <div className="actions">
          <button className="secondary" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="primary" onClick={onConfirm} disabled={busy}>
            {busy ? "正在保存…" : label}
          </button>
        </div>
      </div>
    </Modal>
  );
}
export function Heading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
export function Arrow() {
  return <ChevronRight size={18} />;
}
export function dateTime(value: number | null) {
  return value
    ? new Date(value * 1000).toLocaleString("zh-CN", {
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "不限时间";
}
export function bytes(value: number) {
  return value >= 1048576
    ? `${(value / 1048576).toFixed(1)} MB`
    : `${Math.ceil(value / 1024)} KB`;
}
