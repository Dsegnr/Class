import { useState, type FormEvent } from "react";
import {
  ArrowUpRight,
  ShieldCheck,
  Eye,
  EyeOff,
  ClipboardCheck,
  Dices,
  CalendarDays,
  Check,
} from "lucide-react";
import { api, message, setCsrf } from "./api";
import EntryArtwork from "./EntryArtwork";
import type { User } from "./types";

export function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [admin, setAdmin] = useState(false),
    [visible, setVisible] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(e.currentTarget);
    try {
      const user = await api<User>(
        admin ? "/auth/admin" : "/auth/login",
        "POST",
        admin
          ? { key: form.get("password") }
          : {
              student_id: form.get("student_id"),
              password: form.get("password"),
            },
      );
      setCsrf(user.csrf);
      onLogin(user);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="entry-layout">
      <div className="entry-frame">
        <aside className="entry-story">
          <a className="brand" href={import.meta.env.BASE_URL}>
            <span className="brand-mark">
              C<span>·</span>
            </span>
            <span>Class</span>
          </a>
          <span className="entry-class-tag">示例班级</span>
          <div className="entry-copy">
            <p className="entry-class">计算机科学与技术 · 37人的班级事务簿</p>
            <h1>同班，同步。</h1>
            <p>
              材料、活动、周一值日。
              <span>班级里的每件小事，一起做好。</span>
            </p>
          </div>
          <EntryArtwork />
          <div className="entry-topics" aria-label="班级事务">
            <span>
              <ClipboardCheck size={15} />
              材料任务
            </span>
            <span>
              <Dices size={15} />
              活动抽签
            </span>
            <span>
              <CalendarDays size={15} />
              物理值日
            </span>
          </div>
          <footer>
            <span className="entry-dot" />
            班级内部空间<span>Class / 示例班级</span>
          </footer>
        </aside>
        <main className="entry-main">
          <div className="entry-form">
            <span className="entry-welcome">
              <span /> 欢迎回到班级
            </span>
            <h2>{admin ? "管理员入口" : "登录 Class"}</h2>
            <p className="muted">
              {admin
                ? "使用独立管理密钥进入工作台。"
                : "使用你的学号和密码，查看班级任务。"}
            </p>
            <form onSubmit={submit} className="stack" key={String(admin)}>
              {!admin && (
                <label>
                  学号
                  <input
                    name="student_id"
                    inputMode="numeric"
                    autoComplete="username"
                    placeholder="请输入12位学号"
                    maxLength={12}
                    minLength={12}
                    pattern="[0-9]{12}"
                    required
                  />
                </label>
              )}
              <label>
                {admin ? "管理密钥" : "密码"}
                <span className="password-input">
                  <input
                    name="password"
                    type={visible ? "text" : "password"}
                    autoComplete={admin ? "off" : "current-password"}
                    placeholder={admin ? "请输入管理密钥" : "请输入登录密码"}
                    required
                    maxLength={256}
                  />
                  <button
                    type="button"
                    onClick={() => setVisible(!visible)}
                    aria-label={visible ? "隐藏密码" : "显示密码"}
                  >
                    {visible ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </span>
              </label>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <button className="primary full" disabled={busy}>
                {busy ? "正在登录…" : "进入班级空间"}
                <ArrowUpRight size={18} />
              </button>
            </form>
            <p className="entry-help">
              {admin
                ? "密钥仅由管理员保管，请勿转发。"
                : "仅对预设班级账号开放。忘记密码请联系管理员。"}
            </p>
            <button
              className="text-button entry-admin"
              onClick={() => {
                setAdmin(!admin);
                setError("");
                setVisible(false);
              }}
            >
              <ShieldCheck size={16} />
              {admin ? "返回学生登录" : "管理员密钥登录"}
            </button>
          </div>
          <footer>
            <ShieldCheck size={15} />
            仅限班级成员访问 · 资料与记录班内可见
          </footer>
        </main>
      </div>
    </div>
  );
}

export function PasswordForm({
  user,
  onChanged,
  onCancel,
}: {
  user: User;
  onChanged: (user: User) => void;
  onCancel?: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    const form = new FormData(e.currentTarget);
    const body = Object.fromEntries(form);
    if (body.new_password !== body.confirm_password) {
      setError("两次新密码不一致");
      return;
    }
    setBusy(true);
    try {
      const next = await api<User>("/auth/password", "POST", body);
      setCsrf(next.csrf);
      onChanged(next);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="password-panel">
      <ShieldCheck size={32} className="blue" />
      <h2>修改登录密码</h2>
      <p className="muted">
        密码可自愿修改。修改后，其他设备的登录会话会失效。 新密码至少10位。
      </p>
      <form className="stack" onSubmit={submit}>
        <label>
          原密码
          <input
            name="old_password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={256}
          />
        </label>
        <label>
          新密码
          <input
            name="new_password"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            maxLength={128}
          />
        </label>
        <label>
          再次输入新密码
          <input
            name="confirm_password"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            maxLength={128}
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button className="primary" disabled={busy}>
            {busy ? "正在保存…" : "保存新密码"}
          </button>
          {onCancel && (
            <button type="button" className="secondary" onClick={onCancel}>
              取消
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
