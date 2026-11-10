import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  Code2,
  History,
  Play,
  RotateCcw,
  Users,
  ShieldCheck,
  Check,
} from "lucide-react";
import { api, ApiError, message } from "./api";
import { useLiveRefresh } from "./useLiveRefresh";
import { dateTime, Heading, Loading, Modal, People } from "./ui";
import type { DrawState, EventRecord, Person, User } from "./types";

const algorithm = `def draw(candidates, count):
    # 候选为本轮尚未参与的成员，使用系统安全随机源
    pool = list(candidates)
    for i in range(count):
        j = i + secrets.randbelow(len(pool) - i)
        pool[i], pool[j] = pool[j], pool[i]
    return pool[:count]

# 正式结果与候选快照、通知在同一事务保存。
# 动画仅展示结果，不决定谁被抽中。`;

export default function Draw({
  user,
  toast,
}: {
  user: User;
  toast: (text: string) => void;
}) {
  const [state, setState] = useState<DrawState | null>(null),
    [error, setError] = useState(""),
    [people, setPeople] = useState<Person[]>([]),
    [list, setList] = useState<"eligible" | "participated" | null>(null),
    [search, setSearch] = useState(""),
    [count, setCount] = useState<number | "">(""),
    [busy, setBusy] = useState(false),
    [reveal, setReveal] = useState<EventRecord | null>(null),
    [animating, setAnimating] = useState(false),
    [newCycle, setNewCycle] = useState(false),
    [reason, setReason] = useState(""),
    [pending, setPending] = useState<{
      key: string;
      count: number;
      expected_pool: string;
    } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const latest = useRef<string | null>(null),
    mounted = useRef(false),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function show(event: EventRecord) {
    setReveal(event);
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    setAnimating(!reduce);
    if (timer.current) clearTimeout(timer.current);
    if (!reduce) timer.current = setTimeout(() => setAnimating(false), 1500);
  }
  async function load() {
    try {
      const next = await api<DrawState>("/draw");
      setState(next);
      setError("");
      const event = next.events.find((e) => e.kind === "draw");
      if (mounted.current && event && event.id !== latest.current) show(event);
      latest.current = event?.id || null;
      mounted.current = true;
    } catch (e) {
      setError(message(e));
    }
  }
  useEffect(() => {
    api<Person[]>("/members")
      .then(setPeople)
      .catch((e) => setError(message(e)));
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  useLiveRefresh(load, 5000);
  async function run() {
    if (
      !state ||
      (!pending &&
        (count === "" ||
          !Number.isInteger(Number(count)) ||
          Number(count) < 1 ||
          Number(count) > state.eligible.length))
    )
      return;
    setConfirming(false);
    const body = pending || {
      key: crypto.randomUUID(),
      count: Number(count),
      expected_pool: state.pool_version,
    };
    setPending(body);
    setBusy(true);
    setError("");
    try {
      const event = await api<EventRecord>("/draw", "POST", body);
      latest.current = event.id;
      show(event);
      setPending(null);
      setCount("");
      await load();
      toast("抽签结果已保存并通知全班");
    } catch (e) {
      if (e instanceof ApiError && e.status < 500) {
        setPending(null);
        await load();
        toast(message(e));
        return;
      }
      setError(
        message(e) + "。若连接中断，请使用下方原请求重试，系统不会重复开奖。",
      );
    } finally {
      setBusy(false);
    }
  }
  async function reset() {
    setBusy(true);
    try {
      await api("/draw/cycle", "POST", {
        key: crypto.randomUUID(),
        reason,
        excluded: [],
      });
      setNewCycle(false);
      setReason("");
      setReveal(null);
      setCount("");
      await load();
      toast("新一轮已开启，37位同学重新参与");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  if (!state)
    return (
      <>
        <Heading
          title="活动抽签"
          description="按轮次安排参与同学，结果对全班可见。"
        />
        {error ? (
          <p className="error-banner">
            {error}
            <button onClick={load}>重试</button>
          </p>
        ) : (
          <Loading />
        )}
      </>
    );
  const latestEvent = reveal || state.events.find((e) => e.kind === "draw");
  const participated = new Set([...state.excluded, ...state.selected]);
  const validCount =
    count !== "" &&
    Number.isInteger(Number(count)) &&
    Number(count) >= 1 &&
    Number(count) <= state.eligible.length;
  const rows =
    list === "eligible"
      ? state.eligible
      : people.filter((p) => participated.has(p.student_id));
  return (
    <>
      <Heading
        title="活动抽签"
        description="本轮已参与的同学不再重复抽取。轮换结束后，由管理员开启新一轮。"
        action={
          <button
            className="secondary"
            onClick={() => {
              setList("eligible");
              setSearch("");
            }}
          >
            <Users size={16} />
            候选名单 · {state.eligible.length}人
          </button>
        }
      />
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      <div className="draw-layout">
        <section
          className={`draw-stage ${!latestEvent ? "waiting" : ""} ${animating ? "revealing" : ""}`}
          aria-label="抽签结果"
        >
          <div className="stage-top">
            <span>
              <span className="live-dot" />
              抽签公示
            </span>
            <span>{latestEvent ? "最近一次抽签结果" : "等待下一次抽签"}</span>
          </div>
          <div className="stage-content">
            {animating ? (
              <div className="draw-loading" role="status">
                <div className="draw-dots">
                  <i />
                  <i />
                  <i />
                </div>
                <h2>正在揭晓</h2>
                <button onClick={() => setAnimating(false)}>跳过动画</button>
              </div>
            ) : latestEvent?.payload.winners ? (
              <>
                <p className="stage-caption">最近一次抽中的同学</p>
                <div className="winner-list" aria-live="polite">
                  {latestEvent.payload.winners.map((person, index) => (
                    <div
                      key={person.student_id}
                      style={{ animationDelay: `${index * 90}ms` }}
                    >
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <h2>{person.name}</h2>
                      <small>{person.student_id}</small>
                    </div>
                  ))}
                </div>
                <p className="stage-time">
                  <Check size={15} />
                  {dateTime(latestEvent.created)} 已公布
                </p>
              </>
            ) : (
              <>
                <div className="stage-symbol">
                  {state.eligible.length}
                  <span>位候选同学</span>
                </div>
                <h2>等待下一次抽签</h2>
                <p className="stage-caption">
                  下一次从这 {state.eligible.length}{" "}
                  位同学中抽取，人数由管理员按活动需求确定。
                </p>
              </>
            )}
          </div>
          <div className="stage-footer">
            <ShieldCheck size={16} />
            等概率抽取 · 本轮不重复 · 全程保留记录
          </div>
        </section>
        <aside className="draw-sidebar">
          <section className="panel">
            <h2>本轮参与情况</h2>
            <button
              className="rotation-row"
              onClick={() => {
                setList("eligible");
                setSearch("");
              }}
            >
              <span>待抽候选</span>
              <strong>{state.eligible.length}人</strong>
              <ChevronDown size={15} />
            </button>
            <button
              className="rotation-row"
              onClick={() => {
                setList("participated");
                setSearch("");
              }}
            >
              <span>已参与（本轮免抽）</span>
              <strong>{participated.size}人</strong>
              <ChevronDown size={15} />
            </button>
            <p className="muted small">
              已参与同学本轮不再进入候选名单。下一次活动的抽取人数尚未确定。
            </p>
          </section>
          {user.role === "admin" ? (
            <section className="panel draw-controls">
              <h2>下一次抽签</h2>
              <label>
                活动需要人数
                <input
                  type="number"
                  min={1}
                  max={state.eligible.length}
                  value={count}
                  placeholder="人数待定，由管理员填写"
                  disabled={busy || !!pending}
                  onChange={(e) =>
                    setCount(
                      e.target.value === "" ? "" : Number(e.target.value),
                    )
                  }
                />
              </label>
              <button
                className="primary full"
                disabled={busy || !validCount}
                onClick={() => (pending ? run() : setConfirming(true))}
              >
                <Play size={16} />
                {busy
                  ? "正在保存结果…"
                  : pending
                    ? "重试上一次抽签"
                    : "开始抽签"}
              </button>
              <p className="muted small">
                先按具体活动确定人数，再确认发起；填写人数不会自动抽签。
              </p>
              {pending && (
                <p className="muted small">
                  请求尚未确认，保持相同请求编号重试即可。
                </p>
              )}
              <button
                className="text-button"
                disabled={busy || !!pending}
                onClick={() => setNewCycle(true)}
              >
                <RotateCcw size={15} />
                开启新一轮
              </button>
            </section>
          ) : (
            <section className="panel">
              <h2>等待下一次抽签</h2>
              <p className="muted">
                下一次活动人数由管理员确定。抽签结果公布后，你会收到站内通知；页面每5秒同步一次。
              </p>
            </section>
          )}
        </aside>
      </div>
      <details className="disclosure algorithm">
        <summary>
          <Code2 size={17} />
          抽签规则与算法说明<span>展开查看</span>
        </summary>
        <div>
          <h3>每位候选同学拥有相同机会</h3>
          <p>
            以当前候选名单为准，使用系统安全随机数进行无放回抽取。每选中一位，就将其从本轮候选池移出。抽取k人时，每位同学入选概率为
            k / 候选人数。
          </p>
          <p>
            结果在服务器保存后才播放动画。候选快照、算法版本、时间和结果共同记录；刷新页面或重复点击不会重新开奖。
          </p>
          <pre>
            <code>{algorithm}</code>
          </pre>
          <p className="muted small">
            公开算法和操作记录便于核对，但不等于第三方随机源证明。人工导入的历史记录单独标记。
          </p>
        </div>
      </details>
      <section className="panel history-panel">
        <h2>
          <History size={18} />
          抽签记录
        </h2>
        {state.events.map((event) => (
          <div className="event-row" key={event.id}>
            <div>
              <strong>
                {event.kind === "draw"
                  ? event.payload.winners?.map((p) => p.name).join("、")
                  : event.kind === "history"
                    ? "已参与名单（历史补录）"
                    : "开启新一轮"}
              </strong>
              <p>
                {event.kind === "draw"
                  ? `从${event.payload.pool?.length}人中抽取${event.payload.count}人`
                  : event.kind === "history"
                    ? `人工补录：已参与${new Set([...(event.payload.excluded || []), ...(event.payload.selected || [])]).size}人，非系统开奖`
                    : event.payload.reason}
              </p>
            </div>
            <time>
              {event.kind === "history" ? "导入于 " : ""}
              {dateTime(event.created)}
            </time>
          </div>
        ))}
      </section>
      {list && (
        <Modal
          title={`${list === "eligible" ? "待抽候选名单" : "已参与名单（本轮免抽）"} · ${rows.length}人`}
          onClose={() => setList(null)}
        >
          <label className="search-label">
            查找同学
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="姓名或学号"
            />
          </label>
          <People
            people={rows.filter(
              (p) => p.name.includes(search) || p.student_id.includes(search),
            )}
          />
        </Modal>
      )}
      {confirming && (
        <Modal title="确认发起本次抽签" onClose={() => setConfirming(false)}>
          <div className="stack">
            <p>
              从当前 <strong>{state.eligible.length}位</strong> 候选同学中抽取{" "}
              <strong>{count}人</strong>
              。结果将保存，并通知全班。抽中后本轮不再重复参与。
            </p>
            <div className="actions">
              <button
                className="secondary"
                onClick={() => setConfirming(false)}
              >
                返回检查
              </button>
              <button className="primary" disabled={busy} onClick={run}>
                确认抽取 {count} 人
              </button>
            </div>
          </div>
        </Modal>
      )}
      {newCycle && (
        <Modal title="开启新一轮" onClose={() => setNewCycle(false)}>
          <div className="stack">
            <p>
              当前仍有 <strong>{state.eligible.length}人</strong>{" "}
              尚未参与。开启后，37位同学将重新进入候选池，当前记录会保留。
            </p>
            <label>
              开启原因
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="说明本轮结束或提前开启的原因"
                minLength={3}
                maxLength={300}
              />
            </label>
            <button
              className="primary"
              disabled={busy || reason.trim().length < 3}
              onClick={reset}
            >
              {busy ? "正在保存…" : "确认开启新轮"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
