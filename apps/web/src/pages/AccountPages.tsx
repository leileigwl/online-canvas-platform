import { api, ApiError, type EmailCodePurpose, type User } from "@canvas/api-client";
import { useEffect, useState, type CSSProperties } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { BrandMarkSvg } from "../components/Icons";
import { StudioHeader } from "../components/StudioHeader";
import { consumePendingHomeIntent, pendingRefToFile } from "../lib/pending-intent";

type AuthMode = "login" | "register" | "reset";

const inputStyle: CSSProperties = {
  height: 38,
  padding: "0 12px",
  borderRadius: 10,
  border: "1px solid var(--border-hairline)",
  background: "var(--surface-input)",
  outline: 0,
};

function EmailCodeFields({
  purpose,
  email,
  onEmailChange,
  code,
  onCodeChange,
  emailLabel,
  emailPlaceholder = "name@163.com",
  onSent,
  onError,
}: {
  purpose: EmailCodePurpose;
  email: string;
  onEmailChange: (value: string) => void;
  code: string;
  onCodeChange: (value: string) => void;
  emailLabel: string;
  emailPlaceholder?: string;
  onSent: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [sending, setSending] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((prev) => Math.max(0, prev - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  const handleSend = async () => {
    const trimmed = email.trim();
    if (!trimmed) {
      onError("请先填写邮箱地址");
      return;
    }
    onError("");
    onSent("");
    setSending(true);
    try {
      const res = await api.sendEmailCode(trimmed, purpose);
      setCooldown(res.cooldown_seconds || 60);
      onSent(res.message || "验证码已发送，请查收邮箱");
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "验证码发送失败，请稍后重试";
      onError(msg);
      if (err instanceof ApiError && err.status === 429) {
        const matched = msg.match(/(\d+)\s*秒/);
        if (matched) {
          setCooldown(Number(matched[1]));
        }
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
        <span style={{ color: "var(--text-secondary)" }}>{emailLabel}</span>
        <input
          required
          type="email"
          maxLength={255}
          autoComplete="email"
          value={email}
          onChange={(e) => onEmailChange(e.target.value)}
          placeholder={emailPlaceholder}
          style={inputStyle}
        />
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
        <span style={{ color: "var(--text-secondary)" }}>邮箱验证码（6 位数字）</span>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            required
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            minLength={6}
            maxLength={6}
            pattern="[0-9]{6}"
            value={code}
            onChange={(e) => onCodeChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="输入 6 位验证码"
            style={{ ...inputStyle, flex: 1, minWidth: 0, letterSpacing: "0.14em" }}
          />
          <button
            type="button"
            className="fc-btn"
            disabled={sending || cooldown > 0 || !email.trim()}
            onClick={handleSend}
            style={{ height: 38, whiteSpace: "nowrap", padding: "0 14px" }}
          >
            {sending ? "发送中..." : cooldown > 0 ? `${cooldown}s 后重发` : "发送验证码"}
          </button>
        </div>
      </label>
    </>
  );
}

function AuthCard({ initialTab }: { initialTab: "login" | "register" }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<AuthMode>(initialTab);
  const [identifier, setIdentifier] = useState("");
  const [email, setEmail] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const switchMode = (nextMode: AuthMode) => {
    setMode(nextMode);
    setError(null);
    setNotice(null);
    setPassword("");
    setVerificationCode("");
  };

  const resumeAfterAuth = async () => {
    const returnTo = searchParams.get("returnTo");
    const intent = consumePendingHomeIntent();

    if (intent?.kind === "blank") {
      const projects = await api.listProjects();
      const canvas = await api.createCanvas(intent.canvasName, projects[0]?.id);
      navigate(`/canvas/${canvas.id}`, { replace: true });
      return;
    }

    if (intent?.kind === "generate") {
      const projects = await api.listProjects();
      const canvas = await api.createCanvas(
        (intent.prompt || "创意灵感画布").slice(0, 24),
        projects[0]?.id,
      );
      const uploaded = [];
      for (const ref of intent.refs) {
        uploaded.push(await api.uploadAsset(await pendingRefToFile(ref)));
      }
      const items = uploaded.map((asset, idx) => ({
        id: `intent-ref-${Date.now()}-${idx}`,
        type: "image" as const,
        x: -220 + idx * 240,
        y: -120,
        width: 210,
        height: Math.max(140, Math.round((210 * asset.height) / Math.max(1, asset.width))),
        title: asset.name,
        asset_id: asset.id,
        src: asset.src,
        visible: true,
      }));
      if (items.length > 0) {
        await api.saveCanvas(
          canvas.id,
          canvas.revision,
          { schema_version: 1, items },
          canvas.viewport,
        );
      }
      const pendingNotice = intent.prompt
        ? "已进入新建画布；请先在右上「设置」配好生图 API Key 后点击发送生图。"
        : "";
      navigate(
        `/canvas/${canvas.id}${pendingNotice ? `?notice=${encodeURIComponent(pendingNotice)}` : ""}`,
        { replace: true },
      );
      return;
    }

    navigate(returnTo || "/", { replace: true });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      if (mode === "login") {
        await api.login(identifier.trim(), password);
        await resumeAfterAuth();
        return;
      }
      if (mode === "register") {
        await api.register({
          username: username.trim(),
          email: email.trim(),
          password,
          verification_code: verificationCode.trim(),
        });
        await resumeAfterAuth();
        return;
      }
      await api.resetPassword({
        email: email.trim(),
        verification_code: verificationCode.trim(),
        new_password: password,
      });
      const resetEmail = email.trim();
      switchMode("login");
      setIdentifier(resetEmail);
      setNotice("密码已重置，请使用新密码登录");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "操作失败，请检查输入");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="dotted-gallery-bg"
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 20,
        position: "relative",
      }}
    >
      <Link
        to="/"
        style={{
          position: "fixed",
          top: 22,
          left: 24,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "7px 14px",
          borderRadius: 99,
          background: "var(--surface-glass)",
          border: "1px solid var(--border-hairline)",
          fontSize: 12.5,
          color: "var(--text-secondary)",
          boxShadow: "var(--shadow-card)",
        }}
      >
        ← 返回首页
      </Link>

      <form
        onSubmit={handleSubmit}
        style={{
          width: "min(416px, 100%)",
          background: "var(--surface-solid)",
          border: "1px solid var(--border-hairline)",
          borderRadius: 24,
          padding: "28px 26px",
          boxShadow: "var(--shadow-float)",
          display: "flex",
          flexDirection: "column",
          gap: 15,
        }}
      >
        <div className="brand-logo">
          <span className="brand-mark">
            <BrandMarkSvg />
          </span>
          <span>FlowCanvas</span>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            background: "var(--bg-ivory-2)",
            padding: 4,
            borderRadius: 12,
          }}
        >
          <button
            type="button"
            onClick={() => switchMode("login")}
            style={{
              height: 34,
              borderRadius: 9,
              fontSize: 12.5,
              fontWeight: 550,
              background: mode === "login" || mode === "reset" ? "var(--surface-solid)" : "transparent",
              color: mode === "login" || mode === "reset" ? "var(--text-primary)" : "var(--text-secondary)",
              boxShadow: mode === "login" || mode === "reset" ? "var(--shadow-card)" : "none",
            }}
          >
            登录
          </button>
          <button
            type="button"
            onClick={() => switchMode("register")}
            style={{
              height: 34,
              borderRadius: 9,
              fontSize: 12.5,
              fontWeight: 550,
              background: mode === "register" ? "var(--surface-solid)" : "transparent",
              color: mode === "register" ? "var(--text-primary)" : "var(--text-secondary)",
              boxShadow: mode === "register" ? "var(--shadow-card)" : "none",
            }}
          >
            注册账号
          </button>
        </div>

        <div>
          <h2 style={{ fontFamily: "var(--font-serif)", fontSize: 21, margin: "0 0 4px" }}>
            {mode === "login"
              ? "欢迎回到视觉工作台"
              : mode === "register"
                ? "创建 FlowCanvas 个人账户"
                : "通过邮箱重置密码"}
          </h2>
          <p style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.55, margin: 0 }}>
            {mode === "login"
              ? "支持已验证邮箱或用户名登录。登录成功自动续接你刚发起的画布或生图请求。"
              : mode === "register"
                ? "通过邮箱验证码完成注册后，将自动创建入门画布；可在「设置」中配置个人 API Key。"
                : "输入已绑定账户的邮箱并接收 6 位数字验证码，重置后原有登录会话将自动失效。"}
          </p>
        </div>

        {mode === "login" ? (
          <>
            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
              <span style={{ color: "var(--text-secondary)" }}>用户名或邮箱</span>
              <input
                required
                maxLength={255}
                autoComplete="username"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="demo_creator 或 name@163.com"
                style={inputStyle}
              />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ color: "var(--text-secondary)" }}>密码</span>
                <button
                  type="button"
                  onClick={() => {
                    const candidate = identifier.trim();
                    if (candidate.includes("@")) {
                      setEmail(candidate);
                    }
                    switchMode("reset");
                  }}
                  style={{
                    fontSize: 11.5,
                    color: "var(--text-secondary)",
                    textDecoration: "underline",
                    padding: 0,
                    background: "transparent",
                  }}
                >
                  忘记密码？
                </button>
              </div>
              <input
                required
                type="password"
                minLength={1}
                maxLength={128}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                style={inputStyle}
              />
            </label>
          </>
        ) : mode === "register" ? (
          <>
            <EmailCodeFields
              purpose="register"
              email={email}
              onEmailChange={setEmail}
              code={verificationCode}
              onCodeChange={setVerificationCode}
              emailLabel="验证邮箱（注册后可用于登录与找回密码）"
              onSent={(msg) => setNotice(msg || null)}
              onError={(msg) => setError(msg || null)}
            />

            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
              <span style={{ color: "var(--text-secondary)" }}>用户名（3–24 位字母、数字或下划线）</span>
              <input
                required
                minLength={3}
                maxLength={24}
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="demo_creator"
                style={inputStyle}
              />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
              <span style={{ color: "var(--text-secondary)" }}>登录密码（至少 8 位）</span>
              <input
                required
                type="password"
                minLength={8}
                maxLength={128}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                style={inputStyle}
              />
            </label>
          </>
        ) : (
          <>
            <EmailCodeFields
              purpose="reset_password"
              email={email}
              onEmailChange={setEmail}
              code={verificationCode}
              onCodeChange={setVerificationCode}
              emailLabel="账户已绑定邮箱"
              onSent={(msg) => setNotice(msg || null)}
              onError={(msg) => setError(msg || null)}
            />

            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
              <span style={{ color: "var(--text-secondary)" }}>新密码（至少 8 位）</span>
              <input
                required
                type="password"
                minLength={8}
                maxLength={128}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                style={inputStyle}
              />
            </label>
          </>
        )}

        {notice && (
          <div
            style={{
              padding: "8px 10px",
              borderRadius: 8,
              background: "rgba(22, 163, 74, 0.1)",
              color: "#15803d",
              fontSize: 12,
            }}
          >
            {notice}
          </div>
        )}

        {error && (
          <div
            style={{
              padding: "8px 10px",
              borderRadius: 8,
              background: "var(--danger-soft)",
              color: "var(--danger)",
              fontSize: 12,
            }}
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          className="fc-btn fc-btn-obsidian"
          style={{ height: 40 }}
          disabled={busy}
        >
          {busy
            ? "验证中..."
            : mode === "login"
              ? "登录并继续"
              : mode === "register"
                ? "验证邮箱并创建账号"
                : "确认重置密码"}
        </button>

        {mode === "reset" && (
          <button
            type="button"
            className="fc-btn"
            style={{ height: 36 }}
            onClick={() => switchMode("login")}
          >
            ← 返回登录
          </button>
        )}
      </form>
    </div>
  );
}

export function LoginPage() {
  return <AuthCard initialTab="login" />;
}

export function RegisterPage() {
  return <AuthCard initialTab="register" />;
}

export function AccountPage() {
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>(null);
  const [bindEmail, setBindEmail] = useState("");
  const [bindCode, setBindCode] = useState("");
  const [bindingEmail, setBindingEmail] = useState(false);
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [delPw, setDelPw] = useState("");
  const [message, setMessage] = useState<{ kind: "info" | "error"; text: string } | null>(null);

  useEffect(() => {
    api
      .me()
      .then(setUser)
      .catch(() => navigate("/login", { replace: true }));
  }, [navigate]);

  const handleBindEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);
    setBindingEmail(true);
    try {
      const updated = await api.bindEmail(bindEmail.trim(), bindCode.trim());
      setUser(updated);
      setBindEmail("");
      setBindCode("");
      setMessage({ kind: "info", text: `邮箱已绑定并验证：${updated.email}` });
    } catch (err) {
      setMessage({
        kind: "error",
        text: err instanceof ApiError ? err.message : "邮箱绑定失败，请稍后重试",
      });
    } finally {
      setBindingEmail(false);
    }
  };

  const handlePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);
    try {
      await api.changePassword(currentPw, newPw);
      setCurrentPw("");
      setNewPw("");
      setMessage({ kind: "info", text: "登录密码已修改" });
    } catch (err) {
      setMessage({
        kind: "error",
        text: err instanceof ApiError ? err.message : "密码修改失败",
      });
    }
  };

  const handleDeleteAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !window.confirm("确定永久删除当前账户和全部云端画布数据吗？")) return;
    try {
      await api.deleteAccount(user.username, delPw);
      navigate("/", { replace: true });
    } catch (err) {
      setMessage({
        kind: "error",
        text: err instanceof ApiError ? err.message : "注销账户失败",
      });
    }
  };

  return (
    <div className="dotted-gallery-bg" style={{ paddingBottom: 60 }}>
      <StudioHeader active="home" user={user} />

      <main style={{ width: "min(760px, calc(100vw - 32px))", margin: "28px auto 0", display: "flex", flexDirection: "column", gap: 16 }}>
        <div
          style={{
            background: "var(--surface-solid)",
            border: "1px solid var(--border-hairline)",
            borderRadius: 18,
            padding: 22,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div>
            <h1 style={{ fontFamily: "var(--font-serif)", fontSize: 22, margin: "0 0 6px" }}>
              账户管理：{user?.username ?? "…"}
            </h1>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span
                style={{
                  fontSize: 12,
                  padding: "3px 10px",
                  borderRadius: 99,
                  background:
                    user?.email && user?.email_verified
                      ? "rgba(22, 163, 74, 0.1)"
                      : "rgba(180, 83, 9, 0.1)",
                  color: user?.email && user?.email_verified ? "#15803d" : "#b45309",
                }}
              >
                {user?.email && user?.email_verified
                  ? `已验证邮箱：${user.email}`
                  : "未绑定邮箱（绑定后可用于邮箱登录与找回密码）"}
              </span>
            </div>
          </div>
          <button
            type="button"
            className="fc-btn"
            onClick={async () => {
              await api.logout();
              navigate("/", { replace: true });
            }}
          >
            退出登录
          </button>
        </div>

        {message && (
          <div
            style={{
              padding: "10px 14px",
              borderRadius: 12,
              background:
                message.kind === "error" ? "var(--danger-soft)" : "var(--surface-solid)",
              color: message.kind === "error" ? "var(--danger)" : "var(--text-primary)",
              border: "1px solid var(--border-hairline)",
              fontSize: 12.5,
            }}
          >
            {message.text}
          </div>
        )}

        <form
          onSubmit={handleBindEmail}
          style={{
            background: "var(--surface-solid)",
            border: "1px solid var(--border-hairline)",
            borderRadius: 18,
            padding: 22,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div>
            <strong style={{ fontSize: 14.5 }}>
              {user?.email ? "更换已验证邮箱" : "绑定并验证邮箱"}
            </strong>
            <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-secondary)" }}>
              {user?.email
                ? `当前已绑定 ${user.email}，验证新邮箱后将自动替换。`
                : "为当前历史账户绑定邮箱后，可使用邮箱登录及「忘记密码」重置密码。"}
            </p>
          </div>

          <EmailCodeFields
            purpose="bind_email"
            email={bindEmail}
            onEmailChange={setBindEmail}
            code={bindCode}
            onCodeChange={setBindCode}
            emailLabel={user?.email ? "新邮箱地址" : "邮箱地址"}
            onSent={(msg) => setMessage(msg ? { kind: "info", text: msg } : null)}
            onError={(msg) => setMessage(msg ? { kind: "error", text: msg } : null)}
          />

          <button
            type="submit"
            className="fc-btn fc-btn-obsidian"
            disabled={bindingEmail}
            style={{ alignSelf: "flex-start" }}
          >
            {bindingEmail ? "验证中..." : user?.email ? "验证并更换邮箱" : "验证并绑定邮箱"}
          </button>
        </form>

        <form
          onSubmit={handlePassword}
          style={{
            background: "var(--surface-solid)",
            border: "1px solid var(--border-hairline)",
            borderRadius: 18,
            padding: 22,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <strong style={{ fontSize: 14.5 }}>修改登录密码</strong>
          <input
            type="password"
            required
            minLength={8}
            placeholder="当前密码"
            value={currentPw}
            onChange={(e) => setCurrentPw(e.target.value)}
            style={{ height: 38, padding: "0 12px", borderRadius: 10, border: "1px solid var(--border-hairline)", background: "var(--surface-input)" }}
          />
          <input
            type="password"
            required
            minLength={8}
            placeholder="新密码（至少 8 位）"
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            style={{ height: 38, padding: "0 12px", borderRadius: 10, border: "1px solid var(--border-hairline)", background: "var(--surface-input)" }}
          />
          <button type="submit" className="fc-btn fc-btn-obsidian" style={{ alignSelf: "flex-start" }}>
            更新密码
          </button>
        </form>

        <form
          onSubmit={handleDeleteAccount}
          style={{
            background: "var(--surface-solid)",
            border: "1px solid rgba(185, 28, 28, 0.25)",
            borderRadius: 18,
            padding: 22,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <strong style={{ fontSize: 14.5, color: "var(--danger)" }}>注销账户并删除全部画布与素材</strong>
          <input
            type="password"
            required
            placeholder="输入当前登录密码确认注销"
            value={delPw}
            onChange={(e) => setDelPw(e.target.value)}
            style={{ height: 38, padding: "0 12px", borderRadius: 10, border: "1px solid var(--border-hairline)", background: "var(--surface-input)" }}
          />
          <button type="submit" className="fc-btn fc-btn-danger" style={{ alignSelf: "flex-start" }}>
            确认注销当前账户
          </button>
        </form>
      </main>
    </div>
  );
}
