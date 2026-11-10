import { useEffect, useState } from "react";
import { ClipboardCopy, KeyRound, Search, Users } from "lucide-react";
import { api, message } from "./api";
import type { Person } from "./types";

export default function AccountManager({
  toast,
}: {
  toast: (text: string) => void;
}) {
  const [people, setPeople] = useState<Person[]>([]),
    [search, setSearch] = useState(""),
    [selected, setSelected] = useState<Person | null>(null),
    [temporary, setTemporary] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api<Person[]>("/members")
      .then((all) =>
        setPeople(all.filter((p) => p.student_id !== "900000000213")),
      )
      .catch((e) => setError(message(e)));
  }, []);
  async function reset() {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ temporary_password: string }>(
        `/admin/accounts/${selected.student_id}/reset`,
        "POST",
      );
      setTemporary(result.temporary_password);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      className="account-manager disclosure"
      onToggle={(e) => {
        if (!e.currentTarget.open) {
          setTemporary("");
          setSelected(null);
          setError("");
        }
      }}
    >
      <summary>
        <Users size={16} />
        学生账号管理 · {people.length}人
      </summary>
      <div>
        {selected ? (
          <div className="stack">
            <h3>
              {selected.name} · {selected.student_id}
            </h3>
            {temporary ? (
              <>
                <p>
                  密码已重置，其他设备会话已撤销。请线下核对本人后交付此临时密码；同学可直接登录，也可在账号设置中自愿修改。
                </p>
                <label>
                  一次性显示的临时密码
                  <input value={temporary} readOnly autoComplete="off" />
                </label>
                <button
                  className="secondary"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(temporary);
                      toast("临时密码已复制，请只交付给本人");
                    } catch {
                      setError("复制失败，请手动选中复制");
                    }
                  }}
                >
                  <ClipboardCopy size={16} />
                  复制临时密码
                </button>
                <p className="muted small">
                  关闭本面板后不再显示。临时密码不会写入操作日志。
                </p>
              </>
            ) : (
              <>
                <p>
                  确认要重置这位同学的密码吗？现有登录会话将失效，原密码不再可用。
                </p>
                <button className="primary" disabled={busy} onClick={reset}>
                  <KeyRound size={16} />
                  {busy ? "正在重置…" : "确认重置密码"}
                </button>
              </>
            )}
            <button
              className="text-button"
              disabled={busy}
              onClick={() => {
                setTemporary("");
                setSelected(null);
              }}
            >
              返回账号名单
            </button>
          </div>
        ) : (
          <>
            <label>
              查找学生
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="姓名或学号"
              />
            </label>
            <div className="people-list">
              {people
                .filter(
                  (p) =>
                    p.name.includes(search) || p.student_id.includes(search),
                )
                .map((p) => (
                  <div className="person" key={p.student_id}>
                    <strong>{p.name}</strong>
                    <span className="student-id">{p.student_id}</span>
                    <button
                      className="text-button"
                      onClick={() => {
                        setSelected(p);
                        setError("");
                      }}
                    >
                      重置
                    </button>
                  </div>
                ))}
            </div>
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </details>
  );
}
