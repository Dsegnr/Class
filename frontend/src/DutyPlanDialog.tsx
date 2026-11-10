import { useEffect, useRef, useState } from "react";
import { ArrowRight, RotateCcw, Save } from "lucide-react";
import { api, message } from "./api";
import { Modal } from "./ui";
import type { DutyState, EventRecord } from "./types";

export default function DutyPlanDialog({
  initial,
  onClose,
  onSaved,
}: {
  initial: DutyState;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [snapshot, setSnapshot] = useState(initial);
  const [selected, setSelected] = useState<Record<string, string>>(() =>
    selection(initial),
  );
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const request = useRef<string | null>(null),
    locked = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  function selection(state: DutyState) {
    return Object.fromEntries(
      state.base_next.map((p, index) => [
        p.student_id,
        state.next[index].student_id,
      ]),
    );
  }
  const values = snapshot.base_next.map((p) => selected[p.student_id]);
  const duplicate = new Set(values).size !== 5;
  const changed = values.some(
    (sid, index) => sid !== snapshot.next[index].student_id,
  );
  const replacements = snapshot.base_next
    .filter((p) => selected[p.student_id] !== p.student_id)
    .map((p) => ({
      original_id: p.student_id,
      substitute_id: selected[p.student_id],
    }));
  function edit(sid: string, value: string) {
    if (locked.current) return;
    setSelected((current) => ({ ...current, [sid]: value }));
    request.current = null;
    setError("");
  }
  async function refresh() {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setRefreshing(true);
    setError("");
    try {
      const latest = await api<DutyState>("/duty");
      if (!alive.current) return;
      setSnapshot(latest);
      setSelected(selection(latest));
      request.current = null;
    } catch (e) {
      if (alive.current) setError(message(e));
    } finally {
      locked.current = false;
      if (alive.current) {
        setBusy(false);
        setRefreshing(false);
      }
    }
  }
  async function save() {
    if (locked.current || duplicate || !changed || reason.trim().length < 3)
      return;
    locked.current = true;
    setBusy(true);
    setError("");
    request.current ||= crypto.randomUUID();
    try {
      const result = await api<EventRecord>("/duty/plan", "POST", {
        key: request.current,
        expected_version: snapshot.plan_version,
        replacements,
        reason: reason.trim(),
      });
      if (result?.kind !== "duty_plan" || result.payload?.members?.length !== 5)
        throw new Error("暂时无法确认保存结果，请重试或读取最新安排");
      if (alive.current) onSaved();
    } catch (e) {
      if (alive.current) setError(message(e));
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <Modal
      title={`${snapshot.date} 值日人员调整`}
      onClose={() => {
        if (!locked.current) onClose();
      }}
    >
      <div className="stack duty-plan-form">
        <p className="muted">
          修改这一天的实际值日同学。每行对应一位原排同学，调整后仍须为5位不同成员。
        </p>
        <div className="duty-plan-rows">
          {snapshot.base_next.map((person, index) => (
            <div className="duty-plan-row" key={person.student_id}>
              <div>
                <small>
                  原排{" "}
                  {String(
                    ((snapshot.next_index + index) % snapshot.order.length) + 1,
                  ).padStart(2, "0")}
                </small>
                <strong>{person.name}</strong>
              </div>
              <ArrowRight size={16} aria-hidden="true" />
              <label>
                <span className="sr-only">{person.name}对应的值日同学</span>
                <select
                  aria-label={`${person.name}对应的值日同学`}
                  aria-describedby={`duty-selected-${person.student_id}`}
                  value={selected[person.student_id]}
                  disabled={busy}
                  onChange={(e) => edit(person.student_id, e.target.value)}
                >
                  {snapshot.order.map((p) => (
                    <option key={p.student_id} value={p.student_id}>
                      {p.name}
                      {p.student_id === person.student_id ? "（原排）" : ""}
                    </option>
                  ))}
                </select>
                <small
                  id={`duty-selected-${person.student_id}`}
                  className="duty-plan-selection-id"
                >
                  {selected[person.student_id]}
                </small>
              </label>
            </div>
          ))}
        </div>
        {duplicate && (
          <p className="error" role="alert">
            有重复安排，请选满5位不同的同学。
          </p>
        )}
        <button
          className="text-button"
          disabled={busy}
          onClick={() => {
            setSelected(
              Object.fromEntries(
                snapshot.base_next.map((p) => [p.student_id, p.student_id]),
              ),
            );
            request.current = null;
            setError("");
          }}
        >
          <RotateCcw size={15} />
          全部恢复原排
        </button>
        <label>
          调整说明（班级可见）
          <textarea
            value={reason}
            rows={3}
            maxLength={300}
            disabled={busy}
            placeholder="写明人员调整说明，至少3个字；请勿填写个人隐私。"
            onChange={(e) => {
              setReason(e.target.value);
              request.current = null;
              setError("");
            }}
          />
        </label>
        <p className="duty-plan-policy">
          仅调整该日期。完成后仍按原轮换顺序排下一组5人，不自动抵扣替班同学将来的值日。
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button className="secondary" disabled={busy} onClick={refresh}>
            {refreshing ? "正在读取…" : "读取最新安排"}
          </button>
          <button
            className="primary"
            disabled={busy || duplicate || !changed || reason.trim().length < 3}
            onClick={save}
          >
            <Save size={16} />
            {busy
              ? refreshing
                ? "正在读取…"
                : "正在保存…"
              : "保存并通知相关同学"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
