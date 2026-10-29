import { ArrowRight, Eye, EyeOff, KeyRound, Leaf, LockKeyhole, ShieldCheck, UserRound } from "lucide-react";
import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Link, useNavigate } from "react-router";
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
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("原型登录已完成，将进入个人画布。");
    window.setTimeout(() => navigate("/"), 700);
  }
  return (
    <AuthFrame>
      <div className="auth-heading"><h1>欢迎回来</h1><p>登录你的 FlowCanvas 账户，继续在画布上创作。</p></div>
      <form className="auth-form" onSubmit={submit}>
        <label className="form-field"><span>用户名</span><span className="field-shell"><UserRound size={17} /><input autoComplete="username" placeholder="请输入用户名" required /></span></label>
        <PasswordField />
        <div className="auth-options"><label className="check-label"><input type="checkbox" defaultChecked /><span>记住登录状态</span></label><span className="disabled-recovery">忘记密码？暂不支持找回</span></div>
        <button className="button button-light auth-submit" type="submit">登录</button>
        {message && <p className="form-success"><ShieldCheck size={15} />{message}</p>}
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
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (form.get("password") !== form.get("confirm-password")) {
      setError("两次输入的密码不一致，请检查后重试。");
      setMessage("");
      return;
    }
    setError("");
    setMessage("本地原型账户已创建。");
    window.setTimeout(() => navigate("/"), 700);
  }
  return (
    <AuthFrame>
      <div className="auth-heading"><h1>创建你的画布空间</h1><p>用一个用户名开始整理灵感与素材。</p></div>
      <form className="auth-form" onSubmit={submit}>
        <label className="form-field"><span>用户名</span><span className="field-shell"><UserRound size={17} /><input autoComplete="username" placeholder="设置一个用户名" minLength={3} maxLength={24} pattern="[A-Za-z0-9_]{3,24}" title="请输入 3–24 个字母、数字或下划线" required /></span><small>3–24 个字符，可使用字母、数字和下划线</small></label>
        <PasswordField name="password" label="设置密码" placeholder="至少 8 位字符" />
        <PasswordField name="confirm-password" label="确认密码" placeholder="再次输入密码" />
        <label className="check-label terms-check"><input type="checkbox" required /><span>我已阅读并同意服务条款与隐私说明</span></label>
        <button className="button button-light auth-submit" type="submit">创建账户</button>
        {message && <p className="form-success"><ShieldCheck size={15} />{message}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
      </form>
      <div className="auth-switch"><span>已经有账户？</span><Link to="/login">返回登录 <ArrowRight size={14} /></Link></div>
      <div className="auth-legal">不需要邮箱 · 忘记密码暂不支持自助恢复</div>
    </AuthFrame>
  );
}

export function AccountPage() {
  const [saved, setSaved] = useState(false);
  return (
    <div className="settings-page dotted-page">
      <AppHeader />
      <main className="settings-content">
        <div className="settings-title"><span className="eyebrow">账户与安全</span><h1>账户设置</h1><p>管理你的登录信息和账户安全。</p></div>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="设置导航"><button className="settings-nav-item active"><UserRound size={17} />个人资料</button><button className="settings-nav-item"><KeyRound size={17} />密码与安全</button><Link className="settings-nav-item" to="/settings/agent"><Leaf size={17} />Agent 设置</Link></nav>
          <section className="settings-card">
            <div className="settings-card-heading"><div><h2>登录信息</h2><p>用户名用于登录你的 FlowCanvas 账户。</p></div><span className="status-pill"><span />账户正常</span></div>
            <label className="form-field"><span>用户名</span><span className="field-shell"><UserRound size={17} /><input defaultValue="canvas-maker" /></span></label>
            <div className="settings-divider" />
            <div className="settings-card-heading"><div><h2>修改密码</h2><p>修改密码后，需要使用新密码重新登录。</p></div></div>
            <PasswordField label="当前密码" placeholder="输入当前密码" />
            <PasswordField label="新密码" placeholder="输入至少 8 位的新密码" />
            <button className="button button-light settings-save" onClick={() => setSaved(true)}>保存账户设置</button>
            {saved && <p className="form-success"><ShieldCheck size={15} />设置已保存（界面原型）。</p>}
          </section>
        </div>
        <div className="danger-zone"><div><strong>注销账户</strong><p>注销后将按数据保留规则处理你的项目与素材。</p></div><button className="button button-danger" onClick={() => window.alert("账户注销为静态界面原型，尚未连接后端。")}>注销账户</button></div>
      </main>
    </div>
  );
}
