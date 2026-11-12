import type { User } from "@canvas/api-client";
import { useNavigate } from "react-router";
import { BrandMarkSvg } from "./Icons";

type StudioHeaderProps = {
  active: "home" | "assets" | "settings" | "lab";
  user: User | null;
  rightSlot?: React.ReactNode;
  returnCanvasId?: string | null;
};

export function StudioHeader({ active, user, rightSlot, returnCanvasId }: StudioHeaderProps) {
  const navigate = useNavigate();
  const suffix = returnCanvasId ? `?canvasId=${encodeURIComponent(returnCanvasId)}` : "";

  return (
    <header className="studio-nav">
      <button type="button" className="brand-logo" onClick={() => navigate("/")}>
        <span className="brand-mark">
          <BrandMarkSvg />
        </span>
        <span>FlowCanvas</span>
      </button>

      <nav className="studio-nav-links" aria-label="主导航">
        <button
          type="button"
          className={`studio-nav-link ${active === "home" ? "active" : ""}`}
          onClick={() => navigate("/")}
        >
          我的画布
        </button>
        <button
          type="button"
          className={`studio-nav-link ${active === "assets" ? "active" : ""}`}
          onClick={() => navigate(`/assets${suffix}`)}
        >
          素材库
        </button>
        <button
          type="button"
          className={`studio-nav-link ${active === "settings" ? "active" : ""}`}
          onClick={() => navigate(`/settings/agent${suffix}`)}
        >
          模型与生图设置
        </button>
        <button
          type="button"
          className={`studio-nav-link ${active === "lab" ? "active" : ""}`}
          onClick={() => navigate(returnCanvasId ? `/agent-lab/${returnCanvasId}` : "/agent-lab")}
        >
          Agent 实验室
        </button>
      </nav>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {rightSlot}
        <button
          type="button"
          className="avatar-pill"
          onClick={() => navigate(user ? "/account" : "/login")}
        >
          <span className="avatar-dot">
            {user ? user.username.slice(0, 1).toUpperCase() : "?"}
          </span>
          <span>{user ? user.username : "登录 / 注册"}</span>
        </button>
      </div>
    </header>
  );
}
