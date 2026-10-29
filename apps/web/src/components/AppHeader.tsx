import { ChevronDown, Leaf } from "lucide-react";
import { Link, NavLink } from "react-router";
import { cn } from "../lib/cn";

type AppHeaderProps = {
  active?: "canvases" | "assets";
  compact?: boolean;
};

export function Wordmark({ small = false }: { small?: boolean }) {
  return (
    <Link className={cn("wordmark", small && "wordmark-small")} to="/" aria-label="FlowCanvas 首页">
      <span className="wordmark-icon"><Leaf size={small ? 18 : 20} strokeWidth={2.2} /></span>
      <span>FlowCanvas</span>
    </Link>
  );
}

export function AppHeader({ active, compact = false }: AppHeaderProps) {
  return (
    <header className={cn("app-header", compact && "app-header-compact")}>
      <div className="header-left">
        <Wordmark />
        <nav className="main-nav" aria-label="主导航">
          <NavLink className={cn("nav-link", active === "canvases" && "nav-link-active")} to="/">我的画布</NavLink>
          <NavLink className={cn("nav-link", active === "assets" && "nav-link-active")} to="/assets">素材</NavLink>
        </nav>
      </div>
      <div className="header-right">
        <Link className="header-icon-button appearance-button" to="/settings/agent" aria-label="Agent 设置"><span className="appearance-glyph">✳</span></Link>
        <Link className="avatar-link" to="/account" aria-label="账户设置">
          <span className="avatar">林</span><ChevronDown size={14} />
        </Link>
      </div>
    </header>
  );
}
