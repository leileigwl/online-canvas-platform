import { api, ApiError, type User } from "@canvas/api-client";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { BrandMarkSvg } from "../components/Icons";
import { StudioHeader } from "../components/StudioHeader";
import { consumePendingHomeIntent, pendingRefToFile } from "../lib/pending-intent";

function AuthCard({ initialTab }: { initialTab: "login" | "register" }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<"login" | "register">(initialTab);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      const notice = intent.prompt
        ? "已进入新建画布；请先在右上「设置」配好生图 API Key 后点击发送生图。"
        : "";
      navigate(
        `/canvas/${canvas.id}${notice ? `?notice=${encodeURIComponent(notice)}` : ""}`,
        { replace: true },
      );
      return;
    }

    navigate(returnTo || "/", { replace: true });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (tab === "login") {
        await api.login(username.trim(), password);
      } else {
        await api.register(username.trim(), password);
      }
      await resumeAfterAuth();
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
          width: "min(404px, 100%)",
          background: "var(--surface-solid)",
          border: "1px solid var(--border-hairline)",
          borderRadius: 24,
          padding: "28px 26px",
          boxShadow: "var(--shadow-float)",
          display: "flex",
          flexDirection: "column",
          gap: 16,
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
            onClick={() => {
              setTab("login");
              setError(null);
            }}
            style={{
              height: 34,
              borderRadius: 9,
              fontSize: 12.5,
              fontWeight: 550,
              background: tab === "login" ? "var(--surface-solid)" : "transparent",
              color: tab === "login" ? "var(--text-primary)" : "var(--text-secondary)",
              boxShadow: tab === "login" ? "var(--shadow-card)" : "none",
            }}
          >
            登录
          </button>
          <button
            type="button"
            onClick={() => {
              setTab("register");
              setError(null);
            }}
            style={{
              height: 34,
              borderRadius: 9,
              fontSize: 12.5,
              fontWeight: 550,
              background: tab === "register" ? "var(--surface-solid)" : "transparent",
              color: tab === "register" ? "var(--text-primary)" : "var(--text-secondary)",
              boxShadow: tab === "register" ? "var(--shadow-card)" : "none",
            }}
          >
            注册账号
          </button>
        </div>

        <div>
          <h2 style={{ fontFamily: "var(--font-serif)", fontSize: 21, margin: "0 0 4px" }}>
            {tab === "login" ? "欢迎回到视觉工作台" : "创建 FlowCanvas 个人账户"}
          </h2>
          <p style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.55, margin: 0 }}>
            {tab === "login"
              ? "仅使用唯一用户名与密码，不采集邮箱。登录成功自动续接你刚发起的画布或生图请求。"
              : "注册成功后将自动为你创建一个入门画布，并在「设置」页支持配置你自己的 API Key。"}
          </p>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
          <span style={{ color: "var(--text-secondary)" }}>用户名（3–24 位字母、数字或下划线）</span>
          <input
            required
            minLength={3}
            maxLength={24}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="demo_creator"
            style={{
              height: 38,
              padding: "0 12px",
              borderRadius: 10,
              border: "1px solid var(--border-hairline)",
              background: "var(--surface-input)",
              outline: 0,
            }}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
          <span style={{ color: "var(--text-secondary)" }}>密码（至少 8 位）</span>
          <input
            required
            type="password"
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            style={{
              height: 38,
              padding: "0 12px",
              borderRadius: 10,
              border: "1px solid var(--border-hairline)",
              background: "var(--surface-input)",
              outline: 0,
            }}
          />
        </label>

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
          {busy ? "验证中..." : tab === "login" ? "登录并继续" : "创建账号并进入画布"}
        </button>
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
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [delPw, setDelPw] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    api
      .me()
      .then(setUser)
      .catch(() => navigate("/login", { replace: true }));
  }, [navigate]);

  const handlePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.changePassword(currentPw, newPw);
      setCurrentPw("");
      setNewPw("");
      setMessage("登录密码已修改");
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "密码修改失败");
    }
  };

  const handleDeleteAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !window.confirm("确定永久删除当前账户和全部云端画布数据吗？")) return;
    try {
      await api.deleteAccount(user.username, delPw);
      navigate("/", { replace: true });
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "注销账户失败");
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
          }}
        >
          <div>
            <h1 style={{ fontFamily: "var(--font-serif)", fontSize: 22, margin: "0 0 4px" }}>
              账户管理：{user?.username ?? "…"}
            </h1>
            <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-secondary)" }}>
              管理登录凭据与退出当前设备会话。
            </p>
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
          <div style={{ padding: "10px 14px", borderRadius: 12, background: "var(--surface-solid)", border: "1px solid var(--border-hairline)", fontSize: 12.5 }}>
            {message}
          </div>
        )}

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
