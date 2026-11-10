import { useEffect, useRef, useState } from "react";
import { useLiveRefresh } from "./useLiveRefresh";
import {
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Pencil,
  UsersRound,
} from "lucide-react";
import { api, message } from "./api";
import { Heading, Loading, Modal, People } from "./ui";
import DutyPlanDialog from "./DutyPlanDialog";
import type { DutyState, User } from "./types";

export function dutyDate(value: string | null) {
  if (!value) return "日期待定";
  const [year, month, day] = value.split("-").map(Number);
  return `${year}年${month}月${day}日`;
}

export default function Duty({
  user,
  toast,
}: {
  user: User;
  toast: (text: string) => void;
}) {
  const [state, setState] = useState<DutyState | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [showOrder, setShowOrder] = useState(false),
    [schedule, setSchedule] = useState<DutyState | null>(null),
    [date, setDate] = useState(""),
    [reason, setReason] = useState(""),
    [confirming, setConfirming] = useState<DutyState | null>(null),
    [planning, setPlanning] = useState<DutyState | null>(null),
    [actionError, setActionError] = useState("");
  const locked = useRef(false),
    alive = useRef(true),
    operationKey = useRef("");
  const latestRead = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function load() {
    const generation = ++latestRead.current;
    try {
      const next = await api<DutyState>("/duty");
      if (!alive.current || generation !== latestRead.current) return;
      setState(next);
      setError("");
    } catch (e) {
      if (alive.current && generation === latestRead.current)
        setError(message(e));
    }
  }
  useLiveRefresh(load, 15000);
  async function confirm() {
    if (!confirming || !confirming.date || locked.current) return;
    locked.current = true;
    setBusy(true);
    setActionError("");
    try {
      await api("/duty/confirm", "POST", {
        key: operationKey.current,
        expected_index: confirming.next_index,
        date: confirming.date,
        expected_version: confirming.plan_version,
      });
      if (!alive.current) return;
      setConfirming(null);
      await load();
      toast("值日已记录，下一组已更新");
    } catch (e) {
      if (alive.current) setActionError(message(e));
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function change() {
    if (!schedule || locked.current) return;
    locked.current = true;
    setBusy(true);
    setActionError("");
    try {
      await api("/duty/schedule", "POST", {
        date,
        reason,
        key: operationKey.current,
        expected_version: schedule.plan_version,
      });
      if (!alive.current) return;
      setSchedule(null);
      await load();
      toast("值日日期已调整，人员顺序不变");
    } catch (e) {
      if (alive.current) setActionError(message(e));
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <>
      <Heading
        title="物理实验值日"
        description="每周一，每次5人。按物理实验参与名单轮换，完成后再安排下一组。"
        action={
          <button className="secondary" onClick={() => setShowOrder(true)}>
            <ClipboardList size={17} />
            查看轮换顺序
          </button>
        }
      />
      {error && (
        <p className="error-banner" role="alert">
          {error}
          <button onClick={load}>重试</button>
        </p>
      )}
      {!state ? (
        <Loading />
      ) : (
        <>
          <section className="duty-panel">
            <div className="duty-date">
              <CalendarDays size={25} />
              <p>已安排的值日日期</p>
              <strong>
                {state.date
                  ? `${Number(state.date.slice(5, 7))}月${Number(state.date.slice(8))}日`
                  : "日期待定"}
              </strong>
              <span>星期一 · 物理实验</span>
            </div>
            <div className="duty-group">
              <h2>{dutyDate(state.date)}（周一）值日同学</h2>
              <div className="duty-members">
                {state.next.map((person, index) => (
                  <div
                    key={person.student_id}
                    className={[
                      person.student_id === user.student_id ? "is-me" : "",
                      state.base_next?.[index] &&
                      state.base_next[index].student_id !== person.student_id
                        ? "is-substituted"
                        : "",
                    ].join(" ")}
                  >
                    <span>
                      {state.base_next?.[index] &&
                      state.base_next[index].student_id !== person.student_id
                        ? "原排 "
                        : ""}
                      {String(
                        ((state.next_index + index) % state.order.length) + 1,
                      ).padStart(2, "0")}
                    </span>
                    <strong>
                      {person.name}
                      {person.student_id === user.student_id && (
                        <small>我</small>
                      )}
                    </strong>
                    <p>{person.student_id}</p>
                    {state.base_next?.[index]?.student_id !==
                      person.student_id &&
                      state.base_next?.[index] && (
                        <p className="duty-substitution">
                          替 {state.base_next[index].name} 值日
                        </p>
                      )}
                  </div>
                ))}
              </div>
              <p className="muted small">
                1—32号之后，依次为示例同学01、示例同学02、示例同学37，再回到1号。
              </p>
              {!!state.exempt?.length && (
                <p className="duty-exemption-note">
                  {state.exempt.map((p) => p.name).join("、")}
                  不参加物理实验，不纳入值日轮换与替班。共{state.order.length}
                  人，每组5人。
                </p>
              )}
              {!!state.replacements?.length && (
                <div className="duty-plan-note">
                  <strong>该日期人员已调整</strong>
                  <p>{state.reason}</p>
                  <small>
                    完成后按原轮换顺序排下一组，不自动抵扣替班同学将来的值日。
                  </small>
                </div>
              )}
              {user.role === "admin" && (
                <div className="actions">
                  <button
                    className="primary"
                    onClick={() => {
                      operationKey.current = crypto.randomUUID();
                      setActionError("");
                      setConfirming(state);
                    }}
                    disabled={busy || !state.date}
                  >
                    <CheckCircle2 size={17} />
                    {busy ? "正在保存…" : `确认${dutyDate(state.date)}值日完成`}
                  </button>
                  <button
                    className="secondary"
                    onClick={() => {
                      setDate(state.date || "");
                      setReason("");
                      operationKey.current = crypto.randomUUID();
                      setActionError("");
                      setSchedule(state);
                    }}
                  >
                    <Pencil size={16} />
                    调整日期
                  </button>
                  <button
                    className="secondary"
                    onClick={() => setPlanning(state)}
                    disabled={busy}
                  >
                    <UsersRound size={16} />
                    调整值日人员
                  </button>
                </div>
              )}
            </div>
          </section>
          <section className="panel">
            <h2>值日记录</h2>
            {state.events.length ? (
              state.events.map((event) => (
                <div className="event-row" key={event.id}>
                  <div>
                    <strong>
                      {event.payload.members?.map((p) => p.name).join("、")}
                    </strong>
                    <p>{dutyDate(event.payload.date || null)}值日已完成</p>
                    {!!event.payload.replacements?.length && (
                      <p className="muted small">
                        原排：
                        {event.payload.base_members
                          ?.map((p) => p.name)
                          .join("、")}
                        。调整说明：{event.payload.reason}
                      </p>
                    )}
                  </div>
                  <time>{event.payload.date}</time>
                </div>
              ))
            ) : (
              <div className="quiet-empty">
                <CalendarDays size={22} />
                <p>尚无已确认完成的值日记录。上方展示已安排的日期和同学。</p>
              </div>
            )}
          </section>
          {!!state.plan_events?.length && (
            <section className="panel duty-plan-history">
              <h2>人员调整记录</h2>
              {state.plan_events.map((event) => (
                <div className="event-row" key={event.id}>
                  <div>
                    <strong>
                      {event.payload.replacements?.length
                        ? "调整值日人员"
                        : "恢复原排人员"}
                    </strong>
                    <p>
                      {dutyDate(event.payload.date || null)}安排：
                      {event.payload.members?.map((p) => p.name).join("、")}
                    </p>
                    <p className="muted small">说明：{event.payload.reason}</p>
                  </div>
                </div>
              ))}
            </section>
          )}
        </>
      )}
      {confirming && (
        <Modal
          title={`确认${dutyDate(confirming.date)}值日已完成`}
          onClose={() => {
            if (!locked.current) setConfirming(null);
          }}
        >
          <div className="stack">
            <p>
              {dutyDate(confirming.date)}（周一），
              {confirming.next.map((p) => p.name).join("、")}
              。确认后将记录本组实际值日人员，并按原轮换顺序排下一组5人。
            </p>
            {actionError && (
              <p className="error" role="alert">
                {actionError}
              </p>
            )}
            <div className="actions">
              <button
                className="secondary"
                disabled={busy}
                onClick={() => setConfirming(null)}
              >
                取消
              </button>
              <button className="primary" disabled={busy} onClick={confirm}>
                {busy ? "正在保存…" : "确认完成并排下一组"}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {planning && (
        <DutyPlanDialog
          initial={planning}
          onClose={() => setPlanning(null)}
          onSaved={() => {
            setPlanning(null);
            load();
            toast("值日人员已调整，已通知相关同学");
          }}
        />
      )}
      {showOrder && state && (
        <Modal title="物理值日轮换顺序" onClose={() => setShowOrder(false)}>
          <p className="muted">
            物理值日共{state.order.length}人；每次安排5人，跨末尾继续轮到开头。
          </p>
          {!!state.exempt?.length && (
            <p className="muted small">
              免物理值日：{state.exempt.map((p) => p.name).join("、")}
              。班级账号、任务提交与活动抽签按各自规则正常使用。
            </p>
          )}
          <People people={state.order} />
        </Modal>
      )}
      {schedule && (
        <Modal
          title={`调整${dutyDate(schedule.date)}的值日安排`}
          onClose={() => {
            if (!locked.current) setSchedule(null);
          }}
        >
          <div className="stack">
            <p className="muted">
              只调整日期，保留当前实际值日人员，不推进轮换顺序。物理实验日期须为周一。
            </p>
            <label>
              日期
              <input
                type="date"
                value={date}
                disabled={busy}
                onChange={(e) => {
                  setDate(e.target.value);
                  operationKey.current = crypto.randomUUID();
                  setActionError("");
                }}
                required
              />
            </label>
            <label>
              调整原因
              <textarea
                value={reason}
                disabled={busy}
                onChange={(e) => {
                  setReason(e.target.value);
                  operationKey.current = crypto.randomUUID();
                  setActionError("");
                }}
                rows={3}
                maxLength={300}
              />
            </label>
            {actionError && (
              <p className="error" role="alert">
                {actionError}
              </p>
            )}
            <button
              className="primary"
              disabled={busy || !date || reason.trim().length < 3}
              onClick={change}
            >
              保存并通知本组同学
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
