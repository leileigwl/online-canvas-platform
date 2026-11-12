import {
  api,
  ApiError,
  subscribeRunEvents,
  type AgentRun,
  type AgentTask,
  type CanvasSnapshot,
  type HarnessInspectResult,
  type HarnessRunOptions,
  type RunStreamEvent,
  type User,
} from "@canvas/api-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { StudioHeader } from "../components/StudioHeader";

type PreviewBox = {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  kind: "existing" | "proposed" | "collision";
  src?: string;
};

type PersonaCardInfo = {
  key: string;
  role: string;
  subtitle: string;
  status: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  durationMs?: number;
  detailText: string;
  rawPayload?: unknown;
};

function buildPreviewBoxes(
  snapshot: CanvasSnapshot | null,
  run: AgentRun | null,
  inspect: HarnessInspectResult | null,
): PreviewBox[] {
  const existing = (snapshot?.document?.items || []) as Array<Record<string, unknown>>;
  const collidingIds = new Set<string>();
  const issues = run?.proposal?.verifier?.issues || inspect?.layout_verification?.issues || [];
  for (const issue of issues) {
    if (issue.code === "overlap") {
      for (const oid of issue.object_ids || []) collidingIds.add(oid);
    }
  }

  const boxes: PreviewBox[] = [];
  for (const item of existing) {
    const id = String(item.id || "");
    if (!id || item.visible === false || item.type === "connector") continue;
    boxes.push({
      id,
      label: String(item.title || item.content || item.type || id).slice(0, 18),
      x: Number(item.x || 0),
      y: Number(item.y || 0),
      width: Math.max(24, Number(item.width || 160)),
      height: Math.max(24, Number(item.height || 100)),
      kind: collidingIds.has(id) ? "collision" : "existing",
      src: typeof item.src === "string" ? item.src : undefined,
    });
  }

  const ops = run?.proposal?.operations || [];
  ops.forEach((op, idx) => {
    const p = (op.params || {}) as Record<string, unknown>;
    const simId = `sim-new-${idx}`;
    if (op.tool === "move_object" && typeof p.object_id === "string") {
      const target = boxes.find((b) => b.id === p.object_id);
      if (target) {
        target.x = Number(p.x ?? target.x);
        target.y = Number(p.y ?? target.y);
        target.kind = collidingIds.has(target.id) ? "collision" : "proposed";
      }
      return;
    }
    if (op.tool === "resize_object" && typeof p.object_id === "string") {
      const target = boxes.find((b) => b.id === p.object_id);
      if (target) {
        target.width = Number(p.width ?? target.width);
        target.height = Number(p.height ?? target.height);
        target.kind = collidingIds.has(target.id) ? "collision" : "proposed";
      }
      return;
    }
    if (
      op.tool === "generate_image" ||
      op.tool === "edit_image" ||
      op.tool === "add_note" ||
      op.tool === "add_text" ||
      op.tool === "add_shape"
    ) {
      boxes.push({
        id: simId,
        label: String(op.result?.title || p.title || p.prompt || p.content || op.tool).slice(0, 18),
        x: Number(p.x || 0),
        y: Number(p.y || 0),
        width: Math.max(40, Number(p.width || 220)),
        height: Math.max(32, Number(p.height || 140)),
        kind: collidingIds.has(simId) ? "collision" : "proposed",
        src: op.result?.src,
      });
    }
  });
  return boxes;
}

function statusPillStyle(status: string): { bg: string; color: string; label: string } {
  switch (status) {
    case "running":
      return { bg: "rgba(37, 99, 235, 0.12)", color: "#1d4ed8", label: "思考/执行中" };
    case "succeeded":
      return { bg: "var(--emerald-soft)", color: "#047857", label: "完成" };
    case "repair":
      return { bg: "rgba(217, 119, 6, 0.14)", color: "#b45309", label: "驳回重修" };
    case "failed":
      return { bg: "var(--danger-soft)", color: "var(--danger)", label: "失败" };
    default:
      return { bg: "var(--bg-ivory-2)", color: "var(--text-muted)", label: "待命" };
  }
}

function buildPersonaCards(
  run: AgentRun | null,
  events: RunStreamEvent[],
  inspect: HarnessInspectResult | null,
  llmMode: "real" | "scripted",
): PersonaCardInfo[] {
  const defaultModel =
    llmMode === "scripted"
      ? "scripted-harness"
      : inspect?.active_model?.model_name || "BYOK LLM";
  const roleModels = inspect?.active_model?.role_models || {};
  const tasks = run?.tasks || [];

  const taskStatusForRole = (roleName: string): AgentTask[] =>
    tasks.filter((t) => t.role === roleName);

  const metaOf = (taskList: AgentTask[]) => {
    let promptTokens = 0;
    let completionTokens = 0;
    let durationMs = 0;
    let model = "";
    for (const t of taskList) {
      const m = (t.output as Record<string, unknown> | null)?._meta as
        | Record<string, unknown>
        | undefined;
      if (!m) continue;
      if (typeof m.prompt_tokens === "number") promptTokens += m.prompt_tokens;
      if (typeof m.completion_tokens === "number") completionTokens += m.completion_tokens;
      if (typeof m.duration_ms === "number") durationMs += m.duration_ms;
      if (typeof m.model === "string") model = m.model;
    }
    return {
      promptTokens: promptTokens || undefined,
      completionTokens: completionTokens || undefined,
      durationMs: durationMs || undefined,
      model,
    };
  };

  const aggregateStatus = (taskList: AgentTask[]): string => {
    if (taskList.length === 0) return "idle";
    if (taskList.some((t) => t.status === "running")) return "running";
    if (taskList.some((t) => t.status === "failed")) return "failed";
    if (taskList.every((t) => t.status === "succeeded")) return "succeeded";
    return "idle";
  };

  const latestThinking = (roleName: string) =>
    [...events]
      .reverse()
      .find((e) => (e.type === "thinking" || e.type === "verifier") && e.data.role === roleName);

  const roles: Array<{ key: string; role: string; subtitle: string }> = [
    { key: "coordinator", role: "Coordinator", subtitle: "目标拆解 & Harness 路由" },
    { key: "planner", role: "Planner", subtitle: "空间构图 & 工具规划" },
    { key: "editor", role: "Canvas Editor", subtitle: "白名单工具执行 & 生图" },
    { key: "verifier", role: "Verifier", subtitle: "确定性几何/契约校验" },
    { key: "reviewer", role: "Reviewer", subtitle: "终审质量把关 & 打回闭环" },
  ];

  return roles.map(({ key, role, subtitle }) => {
    if (role === "Verifier") {
      const vEvt = [...events].reverse().find((e) => e.type === "verifier");
      const vProp = run?.proposal?.verifier;
      const passed = vEvt ? Boolean(vEvt.data.passed) : vProp ? Boolean(vProp.passed) : undefined;
      const issueCount = vEvt
        ? Number(vEvt.data.issue_count || 0)
        : Number(vProp?.issue_count || 0);
      const status =
        passed === true
          ? "succeeded"
          : passed === false
            ? run?.status === "running"
              ? "repair"
              : "failed"
            : "idle";
      return {
        key,
        role,
        subtitle,
        status,
        model: "deterministic-code",
        detailText:
          passed === undefined
            ? "等待 Canvas Editor 提案..."
            : passed
              ? "几何碰撞 & 边界校验全部通过（0 冲突）"
              : `检出 ${issueCount} 处几何/契约问题，触发闭环反馈`,
        rawPayload: vEvt?.data || vProp || null,
      };
    }

    const list = taskStatusForRole(role);
    const meta = metaOf(list);
    const thought = latestThinking(role);
    const firstErr = list.find((t) => t.error)?.error;
    let status = aggregateStatus(list);
    if (
      role === "Reviewer" &&
      status === "idle" &&
      run?.proposal?.repair_history &&
      run.proposal.repair_history.some((r) => !r.approved) &&
      run.status === "running"
    ) {
      status = "repair";
    }
    const detailText = firstErr
      ? `报错：${firstErr}`
      : thought
        ? `${String(thought.data.title || "")}${thought.data.text ? ` · ${String(thought.data.text)}` : ""}`
        : list.length > 0
          ? list.map((t) => `${t.title} (${t.status})`).join(" / ")
          : "等待上游角色交接...";

    return {
      key,
      role,
      subtitle,
      status,
      model: meta.model || roleModels[role] || defaultModel,
      promptTokens: meta.promptTokens,
      completionTokens: meta.completionTokens,
      durationMs: meta.durationMs,
      detailText,
      rawPayload: list.length === 1 ? list[0] : list,
    };
  });
}

export function AgentLabPage() {
  const navigate = useNavigate();
  const { canvasId: routeCanvasId } = useParams();

  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [canvases, setCanvases] = useState<CanvasSnapshot[]>([]);
  const [selectedCanvasId, setSelectedCanvasId] = useState<string>(routeCanvasId || "");
  const [snapshot, setSnapshot] = useState<CanvasSnapshot | null>(null);
  const [inspect, setInspect] = useState<HarnessInspectResult | null>(null);

  const [goal, setGoal] = useState(
    "生成一张暖象牙极简香氛静物主图，并在右侧配一张无重叠的设计说明卡片",
  );
  const [llmMode, setLlmMode] = useState<"scripted" | "real">("real");
  const [useMockImage, setUseMockImage] = useState(true);
  const [labScenario, setLabScenario] = useState<
    "normal" | "collision_repair" | "memory_compaction"
  >("normal");
  const [forceCompact, setForceCompact] = useState(false);
  const [maxRepairRounds, setMaxRepairRounds] = useState(2);
  const [compactionThresholdPct, setCompactionThresholdPct] = useState(65);

  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [events, setEvents] = useState<RunStreamEvent[]>([]);
  const [selectedPersonaKey, setSelectedPersonaKey] = useState<string>("coordinator");
  const [leftTab, setLeftTab] = useState<"layout" | "context" | "events">("layout");
  const [statusMsg, setStatusMsg] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const unsubRef = useRef<(() => void) | null>(null);

  const refreshCanvasState = useCallback(async (cid: string, preferRunId?: string) => {
    if (!cid) return;
    const [snap, insp, hist] = await Promise.all([
      api.getCanvas(cid),
      api.inspectCanvasHarness(cid, []),
      api.listAgentRuns(cid),
    ]);
    setSnapshot(snap);
    setInspect(insp);
    setRuns(hist);
    if (insp.active_model?.configured === false) {
      setLlmMode("scripted");
    }
    if (preferRunId) {
      const target = hist.find((r) => r.id === preferRunId);
      if (target) setActiveRun(target);
    } else if (hist.length > 0) {
      setActiveRun((prev) => (prev && prev.canvas_id === cid ? hist.find((r) => r.id === prev.id) || hist[0] : hist[0]));
    } else {
      setActiveRun(null);
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const sess = await api.session();
        if (!active) return;
        if (!sess.user) {
          setUser(null);
          return;
        }
        setUser(sess.user);
        const projects = await api.listProjects();
        const allCanvases = (
          await Promise.all(projects.map((p) => api.listCanvases(p.id)))
        ).flat();
        if (!active) return;
        setCanvases(allCanvases);
        const initialId =
          routeCanvasId && allCanvases.some((c) => c.id === routeCanvasId)
            ? routeCanvasId
            : allCanvases[0]?.id || "";
        setSelectedCanvasId(initialId);
      } catch {
        if (active) setUser(null);
      } finally {
        if (active) setAuthChecked(true);
      }
    })();
    return () => {
      active = false;
      unsubRef.current?.();
    };
  }, [routeCanvasId]);

  useEffect(() => {
    if (!selectedCanvasId || !user) return;
    void refreshCanvasState(selectedCanvasId);
  }, [selectedCanvasId, user, refreshCanvasState]);

  const subscribeToRun = useCallback((runId: string, cid: string) => {
    unsubRef.current?.();
    setEvents([]);
    unsubRef.current = subscribeRunEvents(
      runId,
      async (evt) => {
        setEvents((prev) =>
          prev.some((p) => p.sequence === evt.sequence) ? prev : [...prev, evt],
        );
        if (evt.type === "task_created" || evt.type === "task_updated") {
          void api.getAgentRun(runId).then(setActiveRun).catch(() => {});
        }
        if (evt.type === "context") {
          void api.inspectCanvasHarness(cid, []).then(setInspect).catch(() => {});
        }
        if (evt.type === "succeeded" || evt.type === "failed" || evt.type === "canceled") {
          const [latestRun, insp, hist, snap] = await Promise.all([
            api.getAgentRun(runId),
            api.inspectCanvasHarness(cid, []),
            api.listAgentRuns(cid),
            api.getCanvas(cid),
          ]);
          setActiveRun(latestRun);
          setInspect(insp);
          setRuns(hist);
          setSnapshot(snap);
          setBusy(false);
          if (latestRun.status === "failed" && latestRun.error) {
            setStatusMsg({ kind: "error", text: `运行失败：${latestRun.error}` });
          } else if (latestRun.status === "succeeded") {
            setStatusMsg({ kind: "info", text: "Agent 闭环运行完成，可检查右侧人物状态与提案结果。" });
          }
        }
      },
      () => {
        setBusy(false);
      },
    );
  }, []);

  const handleLaunchRun = async () => {
    if (!selectedCanvasId || !goal.trim() || busy) return;
    setStatusMsg(null);
    setBusy(true);
    try {
      const harness_options: HarnessRunOptions = {
        llm_mode: llmMode,
        use_mock_image: useMockImage,
        lab_scenario: labScenario,
        force_compact: forceCompact,
        max_repair_rounds: maxRepairRounds,
        compaction_threshold_pct: compactionThresholdPct,
      };
      const created = await api.submitAgentGoal({
        canvas_id: selectedCanvasId,
        goal: goal.trim(),
        reference_asset_ids: [],
        harness_options,
        idempotency_key: `lab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });
      setActiveRun(created);
      if (created.status === "failed") {
        setBusy(false);
        setStatusMsg({ kind: "error", text: created.error || "Agent 运行失败" });
        return;
      }
      subscribeToRun(created.id, selectedCanvasId);
    } catch (err) {
      setBusy(false);
      setStatusMsg({
        kind: "error",
        text: err instanceof ApiError ? err.message : "启动实验运行失败",
      });
    }
  };

  const handleApplyProposal = async () => {
    if (!activeRun || !snapshot) return;
    try {
      const updated = await api.applyProposal(activeRun.id, snapshot.revision);
      setSnapshot(updated);
      await refreshCanvasState(selectedCanvasId, activeRun.id);
      setStatusMsg({ kind: "info", text: `提案已应用至真实画布（revision v${updated.revision}）` });
    } catch (err) {
      setStatusMsg({ kind: "error", text: err instanceof ApiError ? err.message : "应用失败" });
    }
  };

  const handleRevertProposal = async () => {
    if (!activeRun || !snapshot) return;
    try {
      const reverted = await api.revertProposal(activeRun.id, snapshot.revision);
      setSnapshot(reverted);
      await refreshCanvasState(selectedCanvasId, activeRun.id);
      setStatusMsg({
        kind: "info",
        text: "已整批撤回该提案，并将回退信号记录至 Harness 否决记忆。",
      });
    } catch (err) {
      setStatusMsg({ kind: "error", text: err instanceof ApiError ? err.message : "撤回失败" });
    }
  };

  const handleRejectProposal = async () => {
    if (!activeRun) return;
    try {
      await api.rejectProposal(activeRun.id);
      await refreshCanvasState(selectedCanvasId, activeRun.id);
      setStatusMsg({ kind: "info", text: "已否决该提案并注入 Harness 避坑记忆。" });
    } catch (err) {
      setStatusMsg({ kind: "error", text: err instanceof ApiError ? err.message : "否决失败" });
    }
  };

  const handleCompactMemory = async () => {
    if (!selectedCanvasId) return;
    setStatusMsg(null);
    try {
      const res = await api.compactCanvasMemory(selectedCanvasId, llmMode);
      const insp = await api.inspectCanvasHarness(selectedCanvasId, []);
      setInspect(insp);
      setStatusMsg({
        kind: "info",
        text: `上下文压缩完成：已蒸馏 ${res.compacted_run_count} 轮历史，核心记忆摘要已更新。`,
      });
    } catch (err) {
      setStatusMsg({ kind: "error", text: err instanceof ApiError ? err.message : "压缩失败" });
    }
  };

  const handleClearMemory = async () => {
    if (!selectedCanvasId) return;
    await api.clearCanvasMemory(selectedCanvasId);
    const insp = await api.inspectCanvasHarness(selectedCanvasId, []);
    setInspect(insp);
    setStatusMsg({ kind: "info", text: "已清空当前画布的 Harness 核心记忆与避坑记录。" });
  };

  const handleCreateTestCanvas = async () => {
    const projects = await api.listProjects();
    const created = await api.createCanvas(
      `Harness 测试画布 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`,
      projects[0]?.id,
    );
    setCanvases((prev) => [created, ...prev]);
    setSelectedCanvasId(created.id);
    setActiveRun(null);
    setEvents([]);
  };

  const previewBoxes = useMemo(
    () => buildPreviewBoxes(snapshot, activeRun, inspect),
    [snapshot, activeRun, inspect],
  );

  const svgViewBox = useMemo(() => {
    if (previewBoxes.length === 0) return "-400 -280 800 560";
    const minX = Math.min(...previewBoxes.map((b) => b.x)) - 60;
    const minY = Math.min(...previewBoxes.map((b) => b.y)) - 60;
    const maxX = Math.max(...previewBoxes.map((b) => b.x + b.width)) + 60;
    const maxY = Math.max(...previewBoxes.map((b) => b.y + b.height)) + 60;
    return `${minX} ${minY} ${Math.max(360, maxX - minX)} ${Math.max(240, maxY - minY)}`;
  }, [previewBoxes]);

  const personaCards = useMemo(
    () => buildPersonaCards(activeRun, events, inspect, llmMode),
    [activeRun, events, inspect, llmMode],
  );
  const selectedPersona =
    personaCards.find((p) => p.key === selectedPersonaKey) || personaCards[0];

  const latestContextEvt = useMemo(
    () => [...events].reverse().find((e) => e.type === "context"),
    [events],
  );

  // Compute Claude-Code-style segmented token bar metrics
  const tokenMeter = useMemo(() => {
    const tb = inspect?.token_breakdown;
    const maxTok = tb?.max_context_tokens || 32768;
    const sysTok = tb?.system_prompts_tokens ?? 620;
    const canvasTok = tb?.canvas_brief_tokens ?? 0;
    const coreTok = tb?.core_memory_tokens ?? 0;
    const recentTok = tb?.recent_turns_tokens ?? 0;
    const liveTok = activeRun?.completion_tokens_used ?? tb?.live_run_tokens ?? 0;
    const totalTok = sysTok + canvasTok + coreTok + recentTok + liveTok;
    const thresholdTok = Math.round(maxTok * (compactionThresholdPct / 100));
    const pct = (n: number) => Math.min(100, Math.round((n / Math.max(1, maxTok)) * 1000) / 10);
    return {
      maxTok,
      sysTok,
      canvasTok,
      coreTok,
      recentTok,
      liveTok,
      totalTok,
      thresholdTok,
      totalPct: pct(totalTok),
      sysPct: pct(sysTok),
      canvasPct: pct(canvasTok),
      corePct: pct(coreTok),
      recentPct: pct(recentTok),
      livePct: pct(liveTok),
    };
  }, [inspect, activeRun, compactionThresholdPct]);

  const cardStyle: React.CSSProperties = {
    background: "var(--surface-solid)",
    border: "1px solid var(--border-hairline)",
    borderRadius: 18,
    padding: 18,
    boxShadow: "var(--shadow-card)",
  };

  const controlStyle: React.CSSProperties = {
    height: 36,
    padding: "0 10px",
    borderRadius: 10,
    border: "1px solid var(--border-hairline)",
    background: "var(--surface-input)",
    fontSize: 12.5,
  };

  return (
    <div className="dotted-gallery-bg" style={{ minHeight: "100vh", paddingBottom: 56 }}>
      <StudioHeader
        active="lab"
        user={user}
        returnCanvasId={selectedCanvasId || null}
        rightSlot={
          selectedCanvasId ? (
            <button
              type="button"
              className="fc-btn fc-btn-sm"
              onClick={() => window.open(`/canvas/${selectedCanvasId}`, "_blank", "noopener")}
            >
              ↗ 新窗口打开画布对比
            </button>
          ) : null
        }
      />

      <main style={{ width: "min(1340px, calc(100vw - 32px))", margin: "22px auto 0", display: "flex", flexDirection: "column", gap: 16 }}>
        {!authChecked ? (
          <div style={cardStyle}>正在初始化 Agent 实验室...</div>
        ) : !user ? (
          <div style={{ ...cardStyle, textAlign: "center", padding: 40 }}>
            <h2 style={{ fontFamily: "var(--font-serif)", marginTop: 0 }}>请先登录使用 Harness & Agent 实验室</h2>
            <button
              type="button"
              className="fc-btn fc-btn-obsidian"
              onClick={() => navigate("/login?returnTo=/agent-lab")}
            >
              前往登录
            </button>
          </div>
        ) : (
          <>
            {/* Top Experiment Launcher */}
            <section style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
                <div>
                  <h1 style={{ fontFamily: "var(--font-serif)", fontSize: 20, margin: "0 0 2px" }}>
                    Harness & Agent 闭环实验室
                  </h1>
                  <p style={{ margin: 0, fontSize: 12, color: "var(--text-secondary)" }}>
                    透视真实上下文构成与压缩触发线、多角色人物状态（Coordinator / Planner / Editor / Verifier / Reviewer）及闭环自修复。
                  </p>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  {inspect?.active_model?.configured && (
                    <span
                      style={{
                        fontSize: 11.5,
                        padding: "4px 10px",
                        borderRadius: 99,
                        background: "var(--emerald-soft)",
                        color: "#047857",
                      }}
                    >
                      已接入真实模型：{inspect.active_model.model_name}
                    </span>
                  )}
                  <select
                    style={controlStyle}
                    value={selectedCanvasId}
                    onChange={(e) => {
                      setSelectedCanvasId(e.target.value);
                      setActiveRun(null);
                      setEvents([]);
                    }}
                  >
                    {canvases.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} (v{c.revision})
                      </option>
                    ))}
                  </select>
                  <button type="button" className="fc-btn fc-btn-sm" onClick={handleCreateTestCanvas}>
                    + 新建测试画布
                  </button>
                </div>
              </div>

              {/* Scenario Presets */}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>预设联调剧本：</span>
                <button
                  type="button"
                  className={`chip-btn ${labScenario === "normal" && llmMode === "real" ? "active" : ""}`}
                  onClick={() => {
                    setLabScenario("normal");
                    setLlmMode("real");
                    setUseMockImage(true);
                    setCompactionThresholdPct(65);
                    setGoal("生成一张暖象牙极简香氛静物主图，并在右侧配一张无重叠的设计说明卡片");
                  }}
                >
                  真实 BYOK LLM + Mock 生图联调
                </button>
                <button
                  type="button"
                  className={`chip-btn ${labScenario === "collision_repair" ? "active" : ""}`}
                  onClick={() => {
                    setLabScenario("collision_repair");
                    setLlmMode("scripted");
                    setUseMockImage(true);
                    setMaxRepairRounds(2);
                    setGoal("生成暖象牙极简香氛主图并配右侧注释卡（第1轮重叠碰撞 → Reviewer打回 → 第2轮自修复）");
                  }}
                >
                  可控碰撞驳回自修复闭环
                </button>
                <button
                  type="button"
                  className={`chip-btn ${labScenario === "memory_compaction" ? "active" : ""}`}
                  onClick={() => {
                    setLabScenario("memory_compaction");
                    setLlmMode("real");
                    setUseMockImage(true);
                    setForceCompact(true);
                    setCompactionThresholdPct(10);
                    setGoal("延续前面画布风格，新增一组材质研究图卡并验证记忆自动压缩");
                  }}
                >
                  真实模型 + 低压缩线自动蒸馏测试
                </button>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10 }}>
                <input
                  style={{ ...controlStyle, height: 42, padding: "0 14px", fontSize: 13 }}
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  placeholder="输入实验目标 prompt..."
                />
                <button
                  type="button"
                  className="fc-btn fc-btn-obsidian"
                  disabled={busy || !selectedCanvasId}
                  onClick={handleLaunchRun}
                  style={{ height: 42, padding: "0 20px" }}
                >
                  {busy ? "Agent 闭环执行中..." : "▶ 启动闭环运行"}
                </button>
              </div>

              <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center", fontSize: 12, color: "var(--text-secondary)" }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  推理引擎：
                  <select
                    style={{ ...controlStyle, height: 30 }}
                    value={llmMode}
                    onChange={(e) => setLlmMode(e.target.value as "scripted" | "real")}
                  >
                    <option value="real">
                      真实 BYOK LLM（{inspect?.active_model?.model_name || "需先配置"}）
                    </option>
                    <option value="scripted">可控剧本模拟（免 LLM Key）</option>
                  </select>
                </label>

                <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={useMockImage}
                    onChange={(e) => setUseMockImage(e.target.checked)}
                  />
                  Mock 生图接口（免Key真实PNG）
                </label>

                <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  自动压缩线：
                  <select
                    style={{ ...controlStyle, height: 30 }}
                    value={compactionThresholdPct}
                    onChange={(e) => setCompactionThresholdPct(Number(e.target.value))}
                  >
                    <option value={5}>5%（压测极速触发）</option>
                    <option value={15}>15%（短上下文实验）</option>
                    <option value={40}>40%</option>
                    <option value={65}>65%（生产默认）</option>
                  </select>
                </label>

                <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  自修复上限：
                  <select
                    style={{ ...controlStyle, height: 30 }}
                    value={maxRepairRounds}
                    onChange={(e) => setMaxRepairRounds(Number(e.target.value))}
                  >
                    <option value={0}>0 轮</option>
                    <option value={1}>1 轮</option>
                    <option value={2}>2 轮</option>
                    <option value={3}>3 轮</option>
                  </select>
                </label>

                <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={forceCompact}
                    onChange={(e) => setForceCompact(e.target.checked)}
                  />
                  开跑前强制压缩旧轮次
                </label>
              </div>

              {statusMsg && (
                <div
                  style={{
                    padding: "8px 12px",
                    borderRadius: 10,
                    fontSize: 12.5,
                    background:
                      statusMsg.kind === "error" ? "var(--danger-soft)" : "var(--emerald-soft)",
                    color: statusMsg.kind === "error" ? "var(--danger)" : "#047857",
                  }}
                >
                  {statusMsg.text}
                </div>
              )}
            </section>

            {/* Dual-Pane Inspector */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(460px, 1fr))", gap: 16, alignItems: "start" }}>
              {/* Left Pane: 2D Spatial Preview + Context Inspector + Raw SSE */}
              <section style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      className={`chip-btn ${leftTab === "layout" ? "active" : ""}`}
                      onClick={() => setLeftTab("layout")}
                    >
                      2D 排版与碰撞透视
                    </button>
                    <button
                      type="button"
                      className={`chip-btn ${leftTab === "context" ? "active" : ""}`}
                      onClick={() => setLeftTab("context")}
                    >
                      上下文透视 (/context)
                    </button>
                    <button
                      type="button"
                      className={`chip-btn ${leftTab === "events" ? "active" : ""}`}
                      onClick={() => setLeftTab("events")}
                    >
                      SSE 事件流 ({events.length})
                    </button>
                  </div>
                  {runs.length > 0 && (
                    <select
                      style={{ ...controlStyle, height: 30, maxWidth: 250 }}
                      value={activeRun?.id || ""}
                      onChange={(e) => {
                        const found = runs.find((r) => r.id === e.target.value) || null;
                        setActiveRun(found);
                      }}
                    >
                      {runs.map((r) => (
                        <option key={r.id} value={r.id}>
                          [{r.status}] {r.goal.slice(0, 22)}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                {leftTab === "layout" && (
                  <>
                    <div
                      style={{
                        borderRadius: 14,
                        border: "1px solid var(--border-hairline)",
                        background: "#FBF9F6",
                        padding: 10,
                      }}
                    >
                      <svg viewBox={svgViewBox} style={{ width: "100%", height: 290, display: "block" }}>
                        {previewBoxes.map((box) => {
                          const stroke =
                            box.kind === "collision"
                              ? "#dc2626"
                              : box.kind === "proposed"
                                ? "#2563eb"
                                : "#78716c";
                          const fill =
                            box.kind === "collision"
                              ? "rgba(220, 38, 38, 0.14)"
                              : box.kind === "proposed"
                                ? "rgba(37, 99, 235, 0.10)"
                                : "rgba(231, 226, 216, 0.72)";
                          return (
                            <g key={box.id}>
                              <rect
                                x={box.x}
                                y={box.y}
                                width={box.width}
                                height={box.height}
                                rx={10}
                                fill={fill}
                                stroke={stroke}
                                strokeWidth={3}
                                strokeDasharray={box.kind === "proposed" ? "8 5" : undefined}
                              />
                              <text x={box.x + 10} y={box.y + 24} fontSize={14} fill="#1c1917">
                                {box.label}
                              </text>
                              <text x={box.x + 10} y={box.y + 44} fontSize={11} fill="#57534e">
                                {`${Math.round(box.x)},${Math.round(box.y)} (${Math.round(box.width)}×${Math.round(box.height)})`}
                              </text>
                            </g>
                          );
                        })}
                      </svg>
                      <div style={{ display: "flex", gap: 14, fontSize: 11, color: "var(--text-secondary)", marginTop: 6 }}>
                        <span>■ 灰褐：画布现有对象</span>
                        <span style={{ color: "#2563eb" }}>┄ 蓝框：Agent 本轮提案对象</span>
                        <span style={{ color: "#dc2626" }}>■ 红框：几何校验碰撞警告</span>
                      </div>
                    </div>

                    {activeRun?.error && (
                      <div style={{ padding: "8px 10px", borderRadius: 10, background: "var(--danger-soft)", color: "var(--danger)", fontSize: 12 }}>
                        <strong>失败诊断：</strong>
                        {activeRun.error}
                      </div>
                    )}

                    {activeRun?.proposal && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                          <span
                            style={{
                              fontSize: 11.5,
                              padding: "3px 10px",
                              borderRadius: 99,
                              background: activeRun.proposal.verifier?.passed
                                ? "var(--emerald-soft)"
                                : "var(--danger-soft)",
                              color: activeRun.proposal.verifier?.passed
                                ? "#047857"
                                : "var(--danger)",
                            }}
                          >
                            {activeRun.proposal.verifier?.passed
                              ? "几何校验通过（0 碰撞）"
                              : `几何校验发现 ${activeRun.proposal.verifier?.issue_count || 0} 处问题`}
                          </span>
                          <span
                            style={{
                              fontSize: 11.5,
                              padding: "3px 10px",
                              borderRadius: 99,
                              background: "var(--surface-muted)",
                              color: "var(--text-primary)",
                            }}
                          >
                            闭环轮次：{activeRun.proposal.attempt_count || 1} 轮 · 模型调用{" "}
                            {activeRun.model_calls_used}/{activeRun.model_call_budget}
                          </span>
                        </div>

                        {activeRun.proposal.review?.feedback && (
                          <div style={{ fontSize: 12, color: "var(--text-secondary)", background: "var(--bg-ivory-2)", padding: "8px 10px", borderRadius: 10 }}>
                            <strong>Reviewer 结论：</strong>
                            {activeRun.proposal.review.feedback}
                          </div>
                        )}

                        {activeRun.proposal.operations.some((op) => op.result?.src) && (
                          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                            {activeRun.proposal.operations
                              .filter((op) => op.result?.src)
                              .map((op, i) => (
                                <div
                                  key={`${op.result?.asset_id}-${i}`}
                                  style={{
                                    width: 148,
                                    borderRadius: 12,
                                    overflow: "hidden",
                                    border: "1px solid var(--border-hairline)",
                                    background: "#fff",
                                  }}
                                >
                                  <img
                                    src={op.result?.src}
                                    alt={op.result?.title || "generated"}
                                    style={{ width: "100%", height: 110, objectFit: "cover", display: "block" }}
                                  />
                                  <div style={{ padding: "6px 8px", fontSize: 11, color: "var(--text-secondary)" }}>
                                    {op.result?.width}×{op.result?.height} · {op.tool}
                                  </div>
                                </div>
                              ))}
                          </div>
                        )}

                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <button
                            type="button"
                            className="fc-btn fc-btn-sm fc-btn-obsidian"
                            disabled={Boolean(activeRun.proposal.applied || activeRun.proposal.rejected)}
                            onClick={handleApplyProposal}
                          >
                            应用提案到画布
                          </button>
                          <button
                            type="button"
                            className="fc-btn fc-btn-sm"
                            disabled={!activeRun.proposal.applied || Boolean(activeRun.proposal.reverted)}
                            onClick={handleRevertProposal}
                          >
                            整批撤回并记入反馈
                          </button>
                          <button
                            type="button"
                            className="fc-btn fc-btn-sm fc-btn-danger"
                            disabled={Boolean(activeRun.proposal.applied || activeRun.proposal.rejected)}
                            onClick={handleRejectProposal}
                          >
                            否决并写入避坑记忆
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}

                {leftTab === "context" && inspect && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 12 }}>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 8 }}>
                      <div style={{ padding: 8, borderRadius: 10, background: "rgba(79,70,229,0.08)" }}>
                        <div style={{ fontSize: 11, color: "#4338ca" }}>系统提示词</div>
                        <strong>{tokenMeter.sysTok} tok</strong>
                      </div>
                      <div style={{ padding: 8, borderRadius: 10, background: "rgba(217,119,6,0.1)" }}>
                        <div style={{ fontSize: 11, color: "#b45309" }}>画布对象 Brief</div>
                        <strong>{tokenMeter.canvasTok} tok</strong>
                      </div>
                      <div style={{ padding: 8, borderRadius: 10, background: "rgba(5,150,105,0.1)" }}>
                        <div style={{ fontSize: 11, color: "#047857" }}>Core Memory</div>
                        <strong>{tokenMeter.coreTok} tok</strong>
                      </div>
                      <div style={{ padding: 8, borderRadius: 10, background: "rgba(2,132,199,0.1)" }}>
                        <div style={{ fontSize: 11, color: "#0369a1" }}>近期轮次</div>
                        <strong>{tokenMeter.recentTok} tok</strong>
                      </div>
                      <div style={{ padding: 8, borderRadius: 10, background: "rgba(124,58,237,0.1)" }}>
                        <div style={{ fontSize: 11, color: "#6d28d9" }}>模型生成输出</div>
                        <strong>{tokenMeter.liveTok} tok</strong>
                      </div>
                    </div>

                    <pre
                      style={{
                        margin: 0,
                        padding: 12,
                        borderRadius: 12,
                        background: "#18181b",
                        color: "#f4f4f5",
                        fontSize: 11.5,
                        maxHeight: 360,
                        overflow: "auto",
                      }}
                    >
                      {JSON.stringify(
                        {
                          live_context_snapshot: latestContextEvt?.data || null,
                          canvas_brief: inspect.canvas_brief,
                          harness_memory: inspect.memory,
                          recent_turns: inspect.recent_turns || [],
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </div>
                )}

                {leftTab === "events" && (
                  <pre
                    style={{
                      margin: 0,
                      padding: 12,
                      borderRadius: 12,
                      background: "#18181b",
                      color: "#e4e4e7",
                      fontSize: 11,
                      maxHeight: 420,
                      overflow: "auto",
                    }}
                  >
                    {events.length > 0
                      ? JSON.stringify(events, null, 2)
                      : "暂无当前会话实时 SSE 流，点击「启动闭环运行」后这里将实时展示完整协议流。"}
                  </pre>
                )}
              </section>

              {/* Right Pane: Context Bar + Live Persona State + Self-Correction Trace */}
              <section style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {/* Context Window & Compaction Line Meter (Claude Code /context style) */}
                <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <div>
                      <strong style={{ fontSize: 14.5 }}>上下文窗口与压缩管理</strong>
                      <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginTop: 2 }}>
                        总占用 <strong>{tokenMeter.totalTok}</strong> / {tokenMeter.maxTok} tokens（
                        {tokenMeter.totalPct}%） · 自动压缩触发线{" "}
                        <strong>
                          {compactionThresholdPct}% ({tokenMeter.thresholdTok} tok)
                        </strong>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button type="button" className="fc-btn fc-btn-sm" onClick={handleCompactMemory}>
                        手动压缩记忆
                      </button>
                      <button type="button" className="fc-btn fc-btn-sm" onClick={handleClearMemory}>
                        清空记忆
                      </button>
                    </div>
                  </div>

                  {/* Segmented Bar + Vertical Compaction Line Marker */}
                  <div style={{ position: "relative", paddingTop: 18, paddingBottom: 4 }}>
                    <div
                      style={{
                        position: "absolute",
                        top: 0,
                        left: `${compactionThresholdPct}%`,
                        transform: "translateX(-50%)",
                        fontSize: 10.5,
                        color: "#b45309",
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                      }}
                    >
                      ▼ 压缩线 {compactionThresholdPct}%
                    </div>
                    <div
                      style={{
                        height: 12,
                        borderRadius: 99,
                        background: "var(--bg-ivory-2)",
                        overflow: "hidden",
                        display: "flex",
                        position: "relative",
                      }}
                    >
                      <div style={{ width: `${tokenMeter.sysPct}%`, background: "#4f46e5" }} title={`系统提示 ~${tokenMeter.sysTok}`} />
                      <div style={{ width: `${tokenMeter.canvasPct}%`, background: "#d97706" }} title={`画布 Brief ~${tokenMeter.canvasTok}`} />
                      <div style={{ width: `${tokenMeter.corePct}%`, background: "#059669" }} title={`Core Memory ~${tokenMeter.coreTok}`} />
                      <div style={{ width: `${tokenMeter.recentPct}%`, background: "#0284c7" }} title={`近期轮次 ~${tokenMeter.recentTok}`} />
                      <div style={{ width: `${tokenMeter.livePct}%`, background: "#7c3aed" }} title={`输出累计 ~${tokenMeter.liveTok}`} />
                    </div>
                    <div
                      style={{
                        position: "absolute",
                        top: 15,
                        bottom: 0,
                        left: `${compactionThresholdPct}%`,
                        width: 2,
                        background: "#d97706",
                        pointerEvents: "none",
                      }}
                    />
                  </div>

                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 11, color: "var(--text-secondary)" }}>
                    <span><i style={{ color: "#4f46e5" }}>●</i> 系统 {tokenMeter.sysTok}</span>
                    <span><i style={{ color: "#d97706" }}>●</i> 画布 {tokenMeter.canvasTok}</span>
                    <span><i style={{ color: "#059669" }}>●</i> 记忆 {tokenMeter.coreTok}</span>
                    <span><i style={{ color: "#0284c7" }}>●</i> 轮次 {tokenMeter.recentTok}</span>
                    <span><i style={{ color: "#7c3aed" }}>●</i> 输出 {tokenMeter.liveTok}</span>
                  </div>

                  <div style={{ fontSize: 12, background: "var(--bg-ivory-2)", padding: "8px 10px", borderRadius: 10 }}>
                    <strong>Core Memory（已压缩 {inspect?.memory.compacted_run_count || 0} 轮 · 未压缩 {inspect?.recent_turns?.length || 0} 轮）：</strong>
                    <div style={{ marginTop: 4, color: "var(--text-secondary)", whiteSpace: "pre-wrap" }}>
                      {inspect?.memory.compacted_summary || "尚无 Core Memory 摘要（可点击「手动压缩记忆」将已完成/失败轮次立即蒸馏写入）"}
                    </div>
                  </div>
                </div>

                {/* Live Agent Persona State Matrix */}
                <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <strong style={{ fontSize: 14.5 }}>Agent 多角色人物状态</strong>
                    <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                      点击任意角色可下钻查看上下文交接与输出
                    </span>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
                    {personaCards.map((p) => {
                      const pill = statusPillStyle(p.status);
                      const isSel = selectedPersona.key === p.key;
                      return (
                        <button
                          key={p.key}
                          type="button"
                          onClick={() => setSelectedPersonaKey(p.key)}
                          style={{
                            textAlign: "left",
                            padding: 10,
                            borderRadius: 12,
                            border: isSel ? "1.5px solid #111111" : "1px solid var(--border-hairline)",
                            background: isSel ? "var(--bg-ivory-2)" : "var(--surface-solid)",
                            display: "flex",
                            flexDirection: "column",
                            gap: 4,
                            cursor: "pointer",
                          }}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 4 }}>
                            <strong style={{ fontSize: 12.5 }}>{p.role}</strong>
                            <span
                              style={{
                                fontSize: 10.5,
                                padding: "2px 6px",
                                borderRadius: 99,
                                background: pill.bg,
                                color: pill.color,
                                fontWeight: 600,
                              }}
                            >
                              {pill.label}
                            </span>
                          </div>
                          <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{p.subtitle}</div>
                          <div style={{ fontSize: 10.5, color: "var(--text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {p.model}
                            {p.completionTokens ? ` · ${p.completionTokens} tok` : ""}
                            {p.durationMs ? ` · ${p.durationMs}ms` : ""}
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  {selectedPersona && (
                    <div style={{ borderRadius: 12, background: "var(--bg-ivory-2)", padding: 10, fontSize: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <strong>
                          {selectedPersona.role} · 人物当前状态详情
                        </strong>
                        <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                          {selectedPersona.promptTokens ? `输入 ~${selectedPersona.promptTokens} tok` : ""}
                          {selectedPersona.completionTokens ? ` · 输出 ${selectedPersona.completionTokens} tok` : ""}
                        </span>
                      </div>
                      <div style={{ color: "var(--text-secondary)", lineHeight: 1.5 }}>
                        {selectedPersona.detailText}
                      </div>
                      {Boolean(selectedPersona.rawPayload) && (
                        <pre
                          style={{
                            margin: 0,
                            padding: 8,
                            borderRadius: 8,
                            background: "#18181b",
                            color: "#e4e4e7",
                            fontSize: 11,
                            maxHeight: 150,
                            overflow: "auto",
                          }}
                        >
                          {JSON.stringify(selectedPersona.rawPayload, null, 2)}
                        </pre>
                      )}
                    </div>
                  )}

                  {activeRun?.proposal?.repair_history && activeRun.proposal.repair_history.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {activeRun.proposal.repair_history.map((round) => (
                        <div
                          key={round.round}
                          style={{
                            padding: "8px 10px",
                            borderRadius: 10,
                            border: "1px solid var(--border-hairline)",
                            background: round.approved
                              ? "rgba(22, 163, 74, 0.08)"
                              : "rgba(220, 38, 38, 0.07)",
                            fontSize: 12,
                          }}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 600 }}>
                            <span>第 {round.round} 轮 · {round.approved ? "审阅通过" : "驳回重修"}</span>
                            <span>
                              几何校验：{round.verifier_passed ? "通过" : `${round.issue_count} 个碰撞`}
                            </span>
                          </div>
                          {round.feedback && (
                            <div style={{ marginTop: 4, color: "var(--text-secondary)" }}>{round.feedback}</div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
