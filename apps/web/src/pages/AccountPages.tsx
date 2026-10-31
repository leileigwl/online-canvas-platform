import { ArrowRight, Eye, EyeOff, KeyRound, Leaf, LockKeyhole, ShieldCheck, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { api, ApiError } from "@canvas/api-client";
import { AppHeader, Wordmark } from "../components/AppHeader";

function AuthArtwork() {
  return (
    <section className="auth-artwork">
      <div className="auth-collage">
        <img className="collage-img collage-img-one" src="/assets/bloom.svg" alt="植物灵感图" />
        <img className="collage-img collage-img-two" src="/assets/mountain.svg" alt="山林灵感图" />
        <img className="collage-img collage-img-three" src="/assets/interior.svg" alt="室内光影灵感图" />
        <div className="paper-note"><span>好想法</span><strong>往往从一张画布<br />慢慢展开。</strong><i /></div>
        <span className="collage-tag tag-one"><i />灵感 / 自然</span>
        <span className="collage-tag tag-two"><i />素材 / 植物</span>
        <span className="scribble scribble-one">自然<br />总能提供<br />新的视角。</span>
        <span className="scribble scribble-two">把想法放在<br />同一个空间里</span>
      </div>
      <div className="auth-story">
        <h2>灵感，从一张画布开始</h2>
        <p>在无限的画布上，收集想法、整理素材、建立联系，<br />让零散的灵感慢慢成为清晰的图景。</p>
      </div>
    </section>
  );
}

function AuthFrame({ children }: { children: ReactNode }) {
  return <div className="auth-page dotted-page"><AuthArtwork /><main className="auth-panel"><div className="auth-brand"><Wordmark /></div>{children}</main></div>;
}

function PasswordField({ label = "密码", placeholder = "请输入密码", name }: { label?: string; placeholder?: string; name?: string }) {
  const [visible, setVisible] = useState(false);
  return (
    <label className="form-field">
      <span>{label}</span>
      <span className="field-shell"><LockKeyhole size={17} /><input name={name} type={visible ? "text" : "password"} placeholder={placeholder} minLength={8} required /><button type="button" className="field-action" onClick={() => setVisible(!visible)} aria-label={visible ? "隐藏密码" : "显示密码"}>{visible ? <Eye size={17} /> : <EyeOff size={17} />}</button></span>
    </label>
  );
}

export function LoginPage() {
  const navigate = useNavigate();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError("");
    setBusy(true);
    try {
      await api.login(String(form.get("username") ?? ""), String(form.get("password") ?? ""));
      setMessage("登录成功，正在打开个人画布。");
      navigate("/");
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "无法连接服务端，请确认 API 已启动。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthFrame>
      <div className="auth-heading"><h1>欢迎回来</h1><p>登录你的 FlowCanvas 账户，继续在画布上创作。</p></div>
      <form className="auth-form" onSubmit={submit}>
        <label className="form-field"><span>用户名</span><span className="field-shell"><UserRound size={17} /><input name="username" autoComplete="username" placeholder="请输入用户名" required /></span></label>
        <PasswordField name="password" />
        <div className="auth-options"><label className="check-label"><input type="checkbox" defaultChecked /><span>记住登录状态</span></label><span className="disabled-recovery">忘记密码？暂不支持找回</span></div>
        <button className="button button-light auth-submit" type="submit" disabled={busy}>{busy ? "正在登录…" : "登录"}</button>
        {message && <p className="form-success"><ShieldCheck size={15} />{message}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
      </form>
      <div className="auth-switch"><span>还没有账户？</span><Link to="/register">注册 <ArrowRight size={14} /></Link></div>
      <div className="auth-legal">用户名与密码由你自行保管 · 暂不提供邮箱找回</div>
    </AuthFrame>
  );
}

export function RegisterPage() {
  const navigate = useNavigate();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (form.get("password") !== form.get("confirm-password")) {
      setError("两次输入的密码不一致，请检查后重试。");
      setMessage("");
      return;
    }
    setError("");
    setBusy(true);
    try {
      await api.register(String(form.get("username") ?? ""), String(form.get("password") ?? ""));
      setMessage("账户已创建，正在打开你的画布空间。");
      navigate("/");
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "无法连接服务端，请确认 API 已启动。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthFrame>
      <div className="auth-heading"><h1>创建你的画布空间</h1><p>用一个用户名开始整理灵感与素材。</p></div>
      <form className="auth-form" onSubmit={submit}>
        <label className="form-field"><span>用户名</span><span className="field-shell"><UserRound size={17} /><input name="username" autoComplete="username" placeholder="设置一个用户名" minLength={3} maxLength={24} pattern="[A-Za-z0-9_]{3,24}" title="请输入 3–24 个字母、数字或下划线" required /></span><small>3–24 个字符，可使用字母、数字和下划线</small></label>
        <PasswordField name="password" label="设置密码" placeholder="至少 8 位字符" />
        <PasswordField name="confirm-password" label="确认密码" placeholder="再次输入密码" />
        <label className="check-label terms-check"><input type="checkbox" required /><span>我已阅读并同意服务条款与隐私说明</span></label>
        <button className="button button-light auth-submit" type="submit" disabled={busy}>{busy ? "正在创建…" : "创建账户"}</button>
        {message && <p className="form-success"><ShieldCheck size={15} />{message}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
      </form>
      <div className="auth-switch"><span>已经有账户？</span><Link to="/login">返回登录 <ArrowRight size={14} /></Link></div>
      <div className="auth-legal">不需要邮箱 · 忘记密码暂不支持自助恢复</div>
    </AuthFrame>
  );
}

export function AccountPage() {
  const navigate = useNavigate();
  const [saved, setSaved] = useState(false);
  const [username, setUsername] = useState("");
  const [error, setError] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  useEffect(() => {
    api.me().then((user) => setUsername(user.username)).catch((cause) => {
      if (cause instanceof ApiError && cause.status === 401) navigate("/login");
      else setError(cause instanceof ApiError ? cause.message : "无法连接服务端。");
    });
  }, [navigate]);

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError("");
    try {
      await api.changePassword(String(form.get("current_password") ?? ""), String(form.get("new_password") ?? ""));
      setSaved(true);
      setError("密码已更新，请使用新密码重新登录。");
      await api.logout();
      navigate("/login");
    } catch (cause) {
      setSaved(false);
      setError(cause instanceof ApiError ? cause.message : "密码更新失败，请重试。");
    }
  }

  async function deleteAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setDeleteError("");
    setDeleteBusy(true);
    try {
      await api.deleteAccount(
        String(form.get("delete-username") ?? ""),
        String(form.get("delete-password") ?? ""),
      );
      navigate("/register");
    } catch (cause) {
      setDeleteError(cause instanceof ApiError ? cause.message : "账户注销失败，请重试。");
    } finally {
      setDeleteBusy(false);
    }
  }
  return (
    <div className="settings-page dotted-page">
      <AppHeader />
      <main className="settings-content">
        <div className="settings-title"><span className="eyebrow">账户与安全</span><h1>账户设置</h1><p>管理你的登录信息和账户安全。</p></div>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="设置导航"><button className="settings-nav-item active"><UserRound size={17} />个人资料</button><button className="settings-nav-item"><KeyRound size={17} />密码与安全</button><Link className="settings-nav-item" to="/settings/agent"><Leaf size={17} />Agent 设置</Link></nav>
          <section className="settings-card">
            <div className="settings-card-heading"><div><h2>登录信息</h2><p>用户名用于登录你的 FlowCanvas 账户。</p></div><span className="status-pill"><span />账户正常</span></div>
            <label className="form-field"><span>用户名</span><span className="field-shell"><UserRound size={17} /><input value={username} readOnly /></span></label>
            <div className="settings-divider" />
            <div className="settings-card-heading"><div><h2>修改密码</h2><p>修改密码后，需要使用新密码重新登录。</p></div></div>
            <form onSubmit={changePassword}>
              <PasswordField name="current_password" label="当前密码" placeholder="输入当前密码" />
              <PasswordField name="new_password" label="新密码" placeholder="输入至少 8 位的新密码" />
              <button className="button button-light settings-save" type="submit">保存账户设置</button>
            </form>
            {saved && <p className="form-success"><ShieldCheck size={15} />密码已更新。</p>}
            {error && <p className="form-error" role="alert">{error}</p>}
          </section>
        </div>
        <div className="danger-zone">
          <div><strong>注销账户</strong><p>账户、项目和个人素材将被删除，且无法恢复。</p></div>
          {!deleteOpen ? (
            <button className="button button-danger" onClick={() => setDeleteOpen(true)}>注销账户</button>
          ) : (
            <form className="danger-confirm-form" onSubmit={deleteAccount}>
              <label className="form-field"><span>确认用户名</span><input className="text-field" name="delete-username" autoComplete="username" required /></label>
              <PasswordField name="delete-password" label="当前密码" placeholder="输入当前密码" />
              <button className="button button-quiet" type="button" disabled={deleteBusy} onClick={() => { setDeleteOpen(false); setDeleteError(""); }}>取消</button>
              <button className="button button-danger" type="submit" disabled={deleteBusy}>{deleteBusy ? "正在注销…" : "确认永久注销"}</button>
              {deleteError && <p className="form-error" role="alert">{deleteError}</p>}
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
