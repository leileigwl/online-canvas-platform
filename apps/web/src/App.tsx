import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useParams } from "react-router";
import { AccountPage, LoginPage, RegisterPage } from "./pages/AccountPages";
import { AgentSettingsPage } from "./pages/AgentSettingsPage";
import { AssetsPage } from "./pages/AssetsPage";
import { HomePage } from "./pages/HomePage";

const CanvasPage = lazy(() => import("./pages/CanvasPage").then((module) => ({ default: module.CanvasPage })));

function CanvasRoute() {
  const { canvasId } = useParams();
  return <Suspense fallback={<div className="route-loading">正在打开画布…</div>}><CanvasPage key={canvasId} /></Suspense>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/assets" element={<AssetsPage />} />
      <Route path="/canvas/:canvasId" element={<CanvasRoute />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/account" element={<AccountPage />} />
      <Route path="/settings/agent" element={<AgentSettingsPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
