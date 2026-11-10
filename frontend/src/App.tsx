import { useEffect, useRef, useState } from "react";
import {
  Bell,
  CalendarDays,
  Check,
  ChevronDown,
  ClipboardList,
  Dices,
  LogOut,
  Settings,
  ShieldCheck,
  X,
} from "lucide-react";
import { api, message, setCsrf } from "./api";
import { connectRealtime } from "./realtime";
import { useLiveRefresh } from "./useLiveRefresh";
import { Login, PasswordForm } from "./auth";
import Tasks from "./Tasks";
import Draw from "./Draw";
import Duty from "./Duty";
import AccountManager from "./AccountManager";
import { dateTime, Loading, Modal } from "./ui";
import type { Notice, User } from "./types";

export default function App() {
  const [user, setUser] = useState<User | null>(null),
    [loading, setLoading] = useState(true),
    [page, setPage] = useState("tasks"),
    [notices, setNotices] = useState<Notice[]>([]),
    [showNotices, setShowNotices] = useState(false),
    [settings, setSettings] = useState(false),
    [toastText, setToastText] = useState("");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeOwner = useRef(user);
  noticeOwner.current = user;
  function toast(text: string) {
    setToastText(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastText(""), 5000);
  }
  useEffect(() => {
    api<User>("/auth/me")
      .then((me) => {
        setCsrf(me.csrf);
        setUser(me);
      })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
    const unauthorized = () => {
      setUser(null);
      setCsrf("");
      setNotices([]);
      setSettings(false);
      setShowNotices(false);
    };
    window.addEventListener("class:unauthorized", unauthorized);
    const drag = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", drag);
    window.addEventListener("drop", drag);
    return () => {
      window.removeEventListener("class:unauthorized", unauthorized);
      window.removeEventListener("dragover", drag);
      window.removeEventListener("drop", drag);
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);
  useEffect(() => {
    if (!user) return;
    return connectRealtime();
  }, [user]);
  useLiveRefresh(
    async () => {
      if (!user) return;
      const owner = user;
      try {
        const next = await api<Notice[]>("/notifications");
        if (noticeOwner.current === owner) setNotices(next);
      } catch {
        /* Auth expiry is handled globally; polling retries transport errors. */
      }
    },
    8000,
    user,
  );
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [page]);
  async function logout() {
    try {
      await api("/auth/logout", "POST");
      setUser(null);
      setNotices([]);
      setCsrf("");
      setSettings(false);
      setShowNotices(false);
    } catch (e) {
      toast(message(e));
    }
  }
  const navigation = [
    { id: "tasks", label: "任务", icon: ClipboardList },
    { id: "draw", label: "活动抽签", icon: Dices },
    { id: "duty", label: "物理值日", icon: CalendarDays },
  ];
  const unread = notices.filter((n) => !n.read).length;
  if (loading)
    return (
      <div className="startup">
        <span className="brand-word">Class</span>
        <Loading />
      </div>
    );
  if (!user)
    return (
      <Login
        onLogin={(next) => {
          setNotices([]);
          setUser(next);
          setPage("tasks");
        }}
      />
    );
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <aside className="sidebar">
        <a className="brand" href={import.meta.env.BASE_URL}>
          <span className="brand-mark">
            C<span>·</span>
          </span>
          <span>
            Class<small>班级事务空间</small>
          </span>
        </a>
        <div className="class-label">
          <span>计算机科学与技术</span>
          <strong>示例班级</strong>
        </div>
        <nav aria-label="主要导航">
          {navigation.map((item) => (
            <button
              key={item.id}
              className={page === item.id ? "active" : ""}
              onClick={() => setPage(item.id)}
              aria-current={page === item.id ? "page" : undefined}
            >
              <item.icon size={20} />
              {item.label}
              {page === item.id && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="role-label">
            <ShieldCheck size={15} />
            {user.role === "admin" ? "管理员工作台" : "班级成员"}
          </span>
          <p>
            材料请按任务要求提交。
            <br />
            如需补交，请留意通知。
          </p>
          <span className="small muted">Class / 2026</span>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            示例班级<span>/</span>
            {navigation.find((n) => n.id === page)?.label}
          </div>
          <span className="mobile-brand">Class</span>
          <div className="topbar-actions">
            <button
              className="icon-button notice-button"
              aria-label={`通知${unread ? `，${unread}条未读` : ""}`}
              onClick={() => setShowNotices(true)}
            >
              <Bell size={20} />
              {unread > 0 && <span>{unread > 9 ? "9+" : unread}</span>}
            </button>
            <button
              className="account-button"
              onClick={() => setSettings(true)}
            >
              <span className="avatar">{user.name.slice(-2)}</span>
              <span>
                {user.name}
                <small>{user.role === "admin" ? "管理员" : "班级成员"}</small>
              </span>
              <ChevronDown size={14} />
            </button>
          </div>
        </header>
        <main id="main-content" className="main-content">
          {page === "tasks" ? (
            <Tasks user={user} toast={toast} />
          ) : page === "draw" ? (
            <Draw user={user} toast={toast} />
          ) : (
            <Duty user={user} toast={toast} />
          )}
        </main>
        <footer className="workspace-footer">
          Class · 示例班级<span>任务与参与记录仅班内可见</span>
        </footer>
      </div>
      <nav className="mobile-nav" aria-label="手机导航">
        {navigation.map((item) => (
          <button
            key={item.id}
            className={page === item.id ? "active" : ""}
            onClick={() => setPage(item.id)}
            aria-current={page === item.id ? "page" : undefined}
          >
            <item.icon size={21} />
            {item.label}
          </button>
        ))}
      </nav>
      {toastText && (
        <div className="toast" role="status">
          <Check size={18} />
          {toastText}
          <button
            className="icon-button"
            aria-label="关闭提示"
            onClick={() => setToastText("")}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {showNotices && (
        <Modal title="班级通知" onClose={() => setShowNotices(false)}>
          {notices.length ? (
            <div className="notice-list">
              {notices.map((n) => (
                <article key={n.id} className={n.read ? "" : "unread"}>
                  <header>
                    <strong>{n.title}</strong>
                    <time>{dateTime(n.created)}</time>
                  </header>
                  <p>{n.body}</p>
                  {!n.read && (
                    <button
                      className="text-button"
                      onClick={async () => {
                        try {
                          await api(`/notifications/${n.id}/read`, "POST");
                          setNotices((items) =>
                            items.map((item) =>
                              item.id === n.id ? { ...item, read: true } : item,
                            ),
                          );
                        } catch (e) {
                          toast(message(e));
                        }
                      }}
                    >
                      标为已读
                    </button>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <div className="quiet-empty">
              <Bell />
              <p>暂时没有通知。</p>
            </div>
          )}
        </Modal>
      )}
      {settings && (
        <Modal title="账号设置" onClose={() => setSettings(false)}>
          <div className="settings-profile">
            <span className="avatar large">{user.name.slice(-2)}</span>
            <div>
              <strong>{user.name}</strong>
              <p>
                {user.student_id} ·{" "}
                {user.role === "admin" ? "管理员" : "班级成员"}
              </p>
            </div>
          </div>
          {user.role === "student" ? (
            <PasswordForm
              user={user}
              onChanged={(next) => {
                setUser(next);
                setSettings(false);
                toast("密码已修改，其他设备已退出");
              }}
            />
          ) : (
            <>
              <p className="muted">
                管理员通过独立密钥登录。更换密钥请使用专用轮换流程，学生账号和登录不受影响。
              </p>
              <AccountManager toast={toast} />
            </>
          )}
          <button className="secondary danger full" onClick={logout}>
            <LogOut size={16} />
            退出登录
          </button>
        </Modal>
      )}
    </div>
  );
}
