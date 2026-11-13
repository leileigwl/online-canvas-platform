import {
  api,
  ApiError,
  subscribeRunEvents,
  type AgentRun,
  type AgentSession,
  type Asset,
  type CanvasItem,
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

type TraceStep = {
  id: string;
  action: string;
  label: string;
  detail: string;
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

function actionBadge(action: string): { text: string; bg: string; color: string } {
  switch (action) {
    case "compact":
      return { text: "记忆压缩", bg: "rgba(5, 150, 105, 0.12)", color: "#047857" };
    case "plan":
      return { text: "拆解", bg: "rgba(79, 70, 229, 0.10)", color: "#4338ca" };
    case "design_canvas":
    case "tool_call":
      return { text: "设计", bg: "rgba(37, 99, 235, 0.10)", color: "#1d4ed8" };
    case "verifier":
      return { text: "校验", bg: "rgba(217, 119, 6, 0.12)", color: "#b45309" };
    case "repair":
      return { text: "自修", bg: "rgba(220, 38, 38, 0.10)", color: "#b91c1c" };
    case "inspect_canvas":
      return { text: "读画布", bg: "rgba(87, 83, 78, 0.10)", color: "#44403c" };
    default:
      return { text: "思考", bg: "var(--bg-ivory-2)", color: "var(--text-secondary)" };
  }
}

function liveStepsFromEvents(events: RunStreamEvent[]): TraceStep[] {
  const steps: TraceStep[] = [];
  for (const evt of events) {
    if (evt.type === "thinking") {
      steps.push({
        id: `evt-${evt.sequence}`,
        action: String(evt.data.action || "think"),
        label: String(evt.data.title || "思考中"),
        detail: String(evt.data.text || ""),
      });
    } else if (evt.type === "tool_call") {
      steps.push({
        id: `evt-${evt.sequence}`,
        action: "tool_call",
        label: String(evt.data.label || evt.data.tool || "工具调用"),
        detail: JSON.stringify(evt.data.params || {}),
      });
    } else if (evt.type === "verifier") {
      steps.push({
        id: `evt-${evt.sequence}`,
        action: "verifier",
        label: String(evt.data.title || "几何校验"),
        detail: String(evt.data.text || ""),
      });
    }
  }
  return steps;
}

export function AgentLabPage() {
  const navigate = useNavigate();
  const { canvasId: routeCanvasId } = useParams();

  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [canvases, setCanvases] = useState<CanvasSnapshot[]>([]);
  const [selectedCanvasId, setSelectedCanvasId] = useState<string>(routeCanvasId || "");
  const [snapshot, setSnapshot] = useState<CanvasSnapshot | null>(null);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  const [inspect, setInspect] = useState<HarnessInspectResult | null>(null);

  const [goal, setGoal] = useState("");
  const [llmMode, setLlmMode] = useState<"scripted" | "real">("real");
  const [imageEngine, setImageEngine] = useState<"local-mflux" | "cloud-api" | "mock">("local-mflux");
  const [showFluxPlayground, setShowFluxPlayground] = useState(false);
  const [fluxPrompt, setFluxPrompt] = useState(
    "a cute cat sitting on a windowsill, soft natural lighting, high detail",
  );
  const [fluxAspect, setFluxAspect] = useState<"16:9" | "1:1" | "4:3" | "9:16">("16:9");
  const [fluxSteps, setFluxSteps] = useState(4);
  const [fluxRendering, setFluxRendering] = useState(false);
  const [fluxResult, setFluxResult] = useState<Asset | null>(null);
  const [labScenario, setLabScenario] = useState<
    "normal" | "collision_repair" | "memory_compaction"
  >("normal");
  const [forceCompact, setForceCompact] = useState(false);
  const [compactionThresholdPct, setCompactionThresholdPct] = useState(85);

  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [events, setEvents] = useState<RunStreamEvent[]>([]);
  const [expandedRunIds, setExpandedRunIds] = useState<Record<string, boolean>>({});
  const [rightTab, setRightTab] = useState<"context" | "layout" | "events">("context");
  const [statusMsg, setStatusMsg] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const unsubRef = useRef<(() => void) | null>(null);
  const chatBottomRef = useRef<HTMLDivElement | null>(null);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) || null,
    [sessions, activeSessionId],
  );

  const refreshSessionView = useCallback(
    async (
      cid: string,
      sid: string,
      thresholdPct: number,
      preferRunId?: string,
    ) => {
      if (!cid || !sid) return;
      const [snap, sessList, insp, hist] = await Promise.all([
        api.getCanvas(cid),
        api.listAgentSessions(cid),
        api.inspectCanvasHarness(cid, [], {
          session_id: sid,
          compaction_threshold_pct: thresholdPct,
        }),
        api.listAgentRuns(cid, sid),
      ]);
      setSnapshot(snap);
      setSessions(sessList);
      setInspect(insp);
      setRuns(hist);
      if (insp.active_model?.configured === false) {
        setLlmMode("scripted");
      }
      if (preferRunId) {
        const target = hist.find((r) => r.id === preferRunId);
        if (target) setActiveRun(target);
      } else if (hist.length > 0) {
        setActiveRun((prev) =>
          prev && prev.session_id === sid
            ? hist.find((r) => r.id === prev.id) || hist[0]
            : hist[0],
        );
      } else {
        setActiveRun(null);
      }
    },
    [],
  );

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
    let active = true;
    (async () => {
      const sessList = await api.listAgentSessions(selectedCanvasId);
      if (!active) return;
      setSessions(sessList);
      const nextSid = sessList.some((s) => s.id === activeSessionId)
        ? activeSessionId
        : sessList[0]?.id || "";
      if (nextSid && nextSid !== activeSessionId) {
        setActiveSessionId(nextSid);
        return;
      }
      if (nextSid) {
        await refreshSessionView(selectedCanvasId, nextSid, compactionThresholdPct);
      }
    })();
    return () => {
      active = false;
    };
  }, [selectedCanvasId, user, activeSessionId, compactionThresholdPct, refreshSessionView]);

  const subscribeToRun = useCallback(
    (runId: string, cid: string, sid: string, thresholdPct: number) => {
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
            void api
              .inspectCanvasHarness(cid, [], {
                session_id: sid,
                compaction_threshold_pct: thresholdPct,
              })
              .then(setInspect)
              .catch(() => {});
          }
          if (evt.type === "succeeded" || evt.type === "failed" || evt.type === "canceled") {
            await refreshSessionView(cid, sid, thresholdPct, runId);
            setBusy(false);
          }
        },
        () => {
          setBusy(false);
        },
      );
    },
    [refreshSessionView],
  );

  const handleSendMessage = async (overrideGoal?: string, overrideScenario?: typeof labScenario) => {
    const promptText = (overrideGoal ?? goal).trim();
    if (!selectedCanvasId || !activeSessionId || !promptText || busy) return;
    const scenarioToUse = overrideScenario ?? labScenario;
    setStatusMsg(null);
    setBusy(true);
    if (!overrideGoal) setGoal("");
    try {
      const harness_options: HarnessRunOptions = {
        llm_mode: llmMode,
        loop_mode: "autonomous",
        use_mock_image: imageEngine === "mock",
        image_engine: imageEngine,
        lab_scenario: scenarioToUse,
        force_compact: forceCompact,
        max_repair_rounds: 2,
        max_loop_steps: 10,
        compaction_threshold_pct: compactionThresholdPct,
      };
      const created = await api.submitAgentGoal({
        canvas_id: selectedCanvasId,
        session_id: activeSessionId,
        goal: promptText,
        reference_asset_ids: [],
        harness_options,
        idempotency_key: `lab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });
      setRuns((prev) => [created, ...prev]);
      setActiveRun(created);
      setTimeout(() => chatBottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
      if (created.status === "failed") {
        setBusy(false);
        setStatusMsg({ kind: "error", text: created.error || "Agent 执行失败" });
        return;
      }
      subscribeToRun(created.id, selectedCanvasId, activeSessionId, compactionThresholdPct);
    } catch (err) {
      setBusy(false);
      setStatusMsg({
        kind: "error",
        text: err instanceof ApiError ? err.message : "发送指令失败",
      });
    }
  };

  const handleCreateNewAgent = async () => {
    if (!selectedCanvasId || busy) return;
    unsubRef.current?.();
    const created = await api.createAgentSession(selectedCanvasId);
    setSessions((prev) => [created, ...prev]);
    setActiveSessionId(created.id);
    setRuns([]);
    setActiveRun(null);
    setEvents([]);
    setStatusMsg({
      kind: "info",
      text: `已开启完全独立的「${created.title}」（全新空白上下文与独立云端记忆）`,
    });
  };

  const handleClearCurrentChat = async () => {
    if (!activeSessionId || !selectedCanvasId || busy) return;
    await api.clearAgentChat(activeSessionId, true, llmMode);
    setRuns([]);
    setActiveRun(null);
    setEvents([]);
    await refreshSessionView(selectedCanvasId, activeSessionId, compactionThresholdPct);
    setStatusMsg({
      kind: "info",
      text: "已清除上方聊天对话与短期消息，但保留了当前 Agent 在云端的历史记忆摘要。",
    });
  };

  const handleCompactMemory = async () => {
    if (!selectedCanvasId || !activeSessionId) return;
    setStatusMsg(null);
    try {
      const updatedSess = await api.compactSessionMemory(activeSessionId, llmMode);
      await refreshSessionView(selectedCanvasId, activeSessionId, compactionThresholdPct);
      setStatusMsg({
        kind: "info",
        text: `已手工触发记忆压缩：累计沉淀 ${updatedSess.compacted_run_count} 轮决策至云端记忆。`,
      });
    } catch (err) {
      setStatusMsg({ kind: "error", text: err instanceof ApiError ? err.message : "压缩失败" });
    }
  };

  const handleResetSessionMemory = async () => {
    if (!selectedCanvasId || !activeSessionId) return;
    await api.resetSessionMemory(activeSessionId);
    await refreshSessionView(selectedCanvasId, activeSessionId, compactionThresholdPct);
    setStatusMsg({
      kind: "info",
      text: "已彻底重置当前 Agent 的云端记忆摘要与避坑记录。",
    });
  };

  const handleGenerateFlux = async () => {
    if (!fluxPrompt.trim() || fluxRendering) return;
    setFluxRendering(true);
    setStatusMsg(null);
    try {
      let w = 1024;
      let h = 1024;
      if (fluxAspect === "16:9") {
        w = 1024;
        h = 576;
      } else if (fluxAspect === "4:3") {
        w = 1024;
        h = 768;
      } else if (fluxAspect === "9:16") {
        w = 576;
        h = 1024;
      }

      const res = await api.generateImage({
        prompt: fluxPrompt.trim(),
        model: "RunPod/FLUX.2-klein-4B-mflux-4bit",
        reference_asset_ids: [],
        quality: "auto",
        width: w,
        height: h,
        align_to_16: true,
        resolution: "auto",
        aspect_ratio: fluxAspect,
        transparent: false,
        count: 1,
      });
      if (res.images && res.images.length > 0) {
        setFluxResult(res.images[0]);
        setStatusMsg({ kind: "info", text: "Flux 2 Klein 本地生图成功！已持久化至云端 MinIO。" });
      }
    } catch (err) {
      setStatusMsg({
        kind: "error",
        text: err instanceof ApiError ? err.message : "生图失败，请检查本地 mflux 服务",
      });
    } finally {
      setFluxRendering(false);
    }
  };

  const handlePushFluxToCanvas = async () => {
    if (!fluxResult || !snapshot || !selectedCanvasId) return;
    try {
      const curDoc = snapshot.document || { schema_version: 1, items: [] };
      const curItems = Array.isArray(curDoc.items) ? curDoc.items : [];
      let maxX = -120;
      let suggestedY = -120;
      for (const it of curItems) {
        if (typeof it.x === "number" && typeof it.width === "number") {
          maxX = Math.max(maxX, it.x + it.width);
        }
      }
      const rightClearX = maxX > -120 ? Math.round(maxX + 48) : -120;

      const newItem: CanvasItem = {
        id: `flux-${Date.now()}`,
        type: "image",
        asset_id: fluxResult.id,
        src: `/api/assets/${fluxResult.id}/content`,
        x: rightClearX,
        y: suggestedY,
        width: fluxAspect === "16:9" ? 512 : 384,
        height: fluxAspect === "16:9" ? 288 : 384,
        title: fluxResult.name || "Flux 2 生成图",
      };

      const newDoc = {
        ...curDoc,
        items: [...curItems, newItem],
      };

      const saved = await api.saveCanvas(
        selectedCanvasId,
        snapshot.revision,
        newDoc,
        snapshot.viewport,
      );
      setSnapshot(saved);
      setStatusMsg({
        kind: "info",
        text: `已将 Flux 生成图推入画布右侧 (x=${newItem.x}, y=${newItem.y})！`,
      });
      await refreshSessionView(selectedCanvasId, activeSessionId, compactionThresholdPct);
    } catch (err) {
      setStatusMsg({
        kind: "error",
        text: err instanceof ApiError ? err.message : "推入画布失败",
      });
    }
  };

  const handleApplyProposal = async (runToApply: AgentRun) => {
    if (!snapshot) return;
    try {
      const updated = await api.applyProposal(runToApply.id, snapshot.revision);
      setSnapshot(updated);
      await refreshSessionView(selectedCanvasId, activeSessionId, compactionThresholdPct, runToApply.id);
      setStatusMsg({ kind: "info", text: `提案已写入画布（revision v${updated.revision}）` });
    } catch (err) {
      setStatusMsg({ kind: "error", text: err instanceof ApiError ? err.message : "应用失败" });
    }
  };

  const handleRevertProposal = async (runToRevert: AgentRun) => {
    if (!snapshot) return;
    try {
      const reverted = await api.revertProposal(runToRevert.id, snapshot.revision);
      setSnapshot(reverted);
      await refreshSessionView(
        selectedCanvasId,
        activeSessionId,
        compactionThresholdPct,
        runToRevert.id,
      );
      setStatusMsg({ kind: "info", text: "已整批撤回该提案，并记入当前 Agent 避坑记忆。" });
    } catch (err) {
      setStatusMsg({ kind: "error", text: err instanceof ApiError ? err.message : "撤回失败" });
    }
  };

  const handleRejectProposal = async (runToReject: AgentRun) => {
    try {
      await api.rejectProposal(runToReject.id);
      await refreshSessionView(
        selectedCanvasId,
        activeSessionId,
        compactionThresholdPct,
        runToReject.id,
      );
      setStatusMsg({ kind: "info", text: "已否决该提案并写入避坑记忆。" });
    } catch (err) {
      setStatusMsg({ kind: "error", text: err instanceof ApiError ? err.message : "否决失败" });
    }
  };

  const handleCreateTestCanvas = async () => {
    const projects = await api.listProjects();
    const created = await api.createCanvas(
      `Agent 测试画布 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`,
      projects[0]?.id,
    );
    setCanvases((prev) => [created, ...prev]);
    setSelectedCanvasId(created.id);
    setActiveSessionId("");
    setRuns([]);
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

  const latestContextEvt = useMemo(
    () => [...events].reverse().find((e) => e.type === "context"),
    [events],
  );

  const liveStreamSteps = useMemo(() => liveStepsFromEvents(events), [events]);

  const tokenMeter = useMemo(() => {
    const evtBd = (latestContextEvt?.data?.breakdown || null) as Record<string, number> | null;
    const tb = inspect?.token_breakdown;
    const maxTok = evtBd?.max_context_tokens || tb?.max_context_tokens || 32768;
    const sysTok = evtBd?.system_prompts_tokens ?? tb?.system_prompts_tokens ?? 520;
    const pinnedTok = evtBd?.pinned_values_tokens ?? tb?.pinned_values_tokens ?? 0;
    const canvasTok = evtBd?.canvas_brief_tokens ?? tb?.canvas_brief_tokens ?? 0;
    const coreTok = evtBd?.core_memory_tokens ?? tb?.core_memory_tokens ?? 0;
    const recentTok = evtBd?.recent_turns_tokens ?? tb?.recent_turns_tokens ?? 0;
    const liveTok =
      busy && evtBd
        ? evtBd.live_run_tokens ?? 0
        : activeRun?.completion_tokens_used ?? tb?.live_run_tokens ?? 0;
    const totalTok = sysTok + pinnedTok + canvasTok + coreTok + recentTok + liveTok;
    const thresholdTok = Math.round(maxTok * (compactionThresholdPct / 100));
    const pct = (n: number) => Math.min(100, Math.round((n / Math.max(1, maxTok)) * 1000) / 10);
    return {
      maxTok,
      sysTok,
      pinnedTok,
      canvasTok,
      coreTok,
      recentTok,
      liveTok,
      totalTok,
      thresholdTok,
      totalPct: pct(totalTok),
      sysPct: pct(sysTok),
      pinnedPct: pct(pinnedTok),
      canvasPct: pct(canvasTok),
      corePct: pct(coreTok),
      recentPct: pct(recentTok),
      livePct: pct(liveTok),
      compactedSaved: Number(latestContextEvt?.data?.compacted_saved_tokens || 0),
      compactedInLoop: Boolean(latestContextEvt?.data?.compacted),
    };
  }, [inspect, activeRun, latestContextEvt, compactionThresholdPct, busy]);

  const chronologicalRuns = useMemo(() => [...runs].reverse(), [runs]);

  const cardStyle: React.CSSProperties = {
    background: "var(--surface-solid)",
    border: "1px solid var(--border-hairline)",
    borderRadius: 18,
    padding: 16,
    boxShadow: "var(--shadow-card)",
  };

  const controlStyle: React.CSSProperties = {
    height: 34,
    padding: "0 10px",
    borderRadius: 10,
    border: "1px solid var(--border-hairline)",
    background: "var(--surface-input)",
    fontSize: 12.5,
  };

  return (
    <div className="dotted-gallery-bg" style={{ minHeight: "100vh", paddingBottom: 40 }}>
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

      <main
        style={{
          width: "min(1340px, calc(100vw - 32px))",
          margin: "18px auto 0",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        {!authChecked ? (
          <div style={cardStyle}>正在连接 Agent 会话空间...</div>
        ) : !user ? (
          <div style={{ ...cardStyle, textAlign: "center", padding: 40 }}>
            <h2 style={{ fontFamily: "var(--font-serif)", marginTop: 0 }}>
              请先登录使用 AI Agent 自主循环实验室
            </h2>
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
            {/* Top Session Switcher & Clear vs New Agent Controls */}
            <section
              style={{
                ...cardStyle,
                padding: "12px 16px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 10,
              }}
            >
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <strong style={{ fontFamily: "var(--font-serif)", fontSize: 16 }}>
                  Agent 自主对话工作台
                </strong>
                <select
                  aria-label="选择画布"
                  style={controlStyle}
                  value={selectedCanvasId}
                  onChange={(e) => {
                    setSelectedCanvasId(e.target.value);
                    setActiveSessionId("");
                    setRuns([]);
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
                  + 新建画布
                </button>
              </div>

              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <select
                  aria-label="切换独立 Agent"
                  style={{ ...controlStyle, fontWeight: 600 }}
                  value={activeSessionId}
                  onChange={(e) => {
                    setActiveSessionId(e.target.value);
                    setActiveRun(null);
                    setEvents([]);
                    setStatusMsg(null);
                  }}
                >
                  {sessions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title}
                      {s.compacted_run_count > 0 ? ` · 云端记忆${s.compacted_run_count}轮` : ""}
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  className="fc-btn fc-btn-sm fc-btn-obsidian"
                  disabled={busy || !selectedCanvasId}
                  onClick={handleCreateNewAgent}
                  title="新建完全独立的 Agent 会话（独立聊天与空白云端记忆）"
                >
                  + 开启全新 Agent
                </button>

                <button
                  type="button"
                  className="fc-btn fc-btn-sm"
                  disabled={busy || !activeSessionId}
                  onClick={handleClearCurrentChat}
                  title="清除当前聊天气泡与短期消息，但保留该 Agent 的云端压缩记忆"
                >
                  清空当前聊天（保留记忆）
                </button>
              </div>
            </section>

            {statusMsg && (
              <div
                style={{
                  padding: "8px 14px",
                  borderRadius: 12,
                  fontSize: 12.5,
                  background:
                    statusMsg.kind === "error" ? "var(--danger-soft)" : "var(--emerald-soft)",
                  color: statusMsg.kind === "error" ? "var(--danger)" : "#047857",
                }}
              >
                {statusMsg.text}
              </div>
            )}

            {/* Main Two-Column Layout: Left Minimalist Chat + Right Context & Preview */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))",
                gap: 14,
                alignItems: "start",
              }}
            >
              {/* Left Column: Conversational Lead Agent Thread */}
              <section
                style={{
                  ...cardStyle,
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                  minHeight: 560,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    paddingBottom: 8,
                    borderBottom: "1px solid var(--border-hairline)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: busy ? "#2563eb" : "#10b981",
                      }}
                    />
                    <strong style={{ fontSize: 13.5 }}>
                      {activeSession?.title || "主对话 Agent"}
                    </strong>
                    {activeSession?.chat_cleared_at && (
                      <span
                        style={{
                          fontSize: 11,
                          padding: "2px 8px",
                          borderRadius: 99,
                          background: "var(--bg-ivory-2)",
                          color: "var(--text-secondary)",
                        }}
                      >
                        已清屏 · 保留云端记忆
                      </span>
                    )}
                  </div>
                  <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                    {inspect?.active_model?.configured && llmMode === "real"
                      ? inspect.active_model.model_name
                      : "scripted-harness"}
                  </span>
                </div>

                {/* Chat Message List */}
                <div
                  style={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    gap: 14,
                    maxHeight: 460,
                    overflowY: "auto",
                    paddingRight: 4,
                  }}
                >
                  {chronologicalRuns.length === 0 ? (
                    <div
                      style={{
                        margin: "auto 0",
                        padding: 24,
                        textAlign: "center",
                        color: "var(--text-secondary)",
                        fontSize: 13,
                        lineHeight: 1.7,
                      }}
                    >
                      <div style={{ fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>
                        {activeSession?.compacted_summary
                          ? "当前对话已清空，云端核心记忆仍在"
                          : "与自主主 Agent 开始对话"}
                      </div>
                      <div>
                        发送一条想法，主 Agent 会自行决定何时思考、拆解任务、执行画布设计并自动校验；
                        中间过程默认折叠收纳，需要时展开即可。
                      </div>
                    </div>
                  ) : (
                    chronologicalRuns.map((runItem) => {
                      const isLiveTurn = busy && activeRun?.id === runItem.id;
                      const persistedSteps = (runItem.proposal?.steps || []).map((s, idx) => ({
                        id: `${runItem.id}-step-${idx}`,
                        action: s.action,
                        label: s.label,
                        detail: s.detail,
                      }));
                      const stepsToRender =
                        isLiveTurn && liveStreamSteps.length > 0 ? liveStreamSteps : persistedSteps;
                      const isExpanded = Boolean(expandedRunIds[runItem.id]) || isLiveTurn;
                      const compactionCount = Number(runItem.proposal?.compaction_count || 0);
                      const replyText =
                        runItem.proposal?.reply ||
                        runItem.summary ||
                        (runItem.status === "failed"
                          ? `执行失败：${runItem.error || "请检查模型配置"}`
                          : isLiveTurn
                            ? "正在自主循环思考与执行中..."
                            : "已完成处理。");
                      const ops = runItem.proposal?.operations || [];
                      const imgOps = ops.filter((op) => op.result?.src);

                      return (
                        <div
                          key={runItem.id}
                          onClick={() => setActiveRun(runItem)}
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 8,
                            cursor: "pointer",
                          }}
                        >
                          {/* User Bubble */}
                          <div style={{ display: "flex", justifyContent: "flex-end" }}>
                            <div
                              style={{
                                maxWidth: "82%",
                                padding: "9px 13px",
                                borderRadius: "14px 14px 4px 14px",
                                background: "#18181b",
                                color: "#fafafa",
                                fontSize: 13,
                                lineHeight: 1.5,
                              }}
                            >
                              {runItem.goal}
                            </div>
                          </div>

                          {/* Agent Response Card with Minimalist Collapsible Process */}
                          <div
                            style={{
                              maxWidth: "92%",
                              padding: "10px 13px",
                              borderRadius: "4px 14px 14px 14px",
                              background: "var(--bg-ivory-2)",
                              border:
                                activeRun?.id === runItem.id
                                  ? "1px solid #18181b"
                                  : "1px solid var(--border-hairline)",
                              display: "flex",
                              flexDirection: "column",
                              gap: 8,
                            }}
                          >
                            {/* Minimalist Collapsible Process Drawer */}
                            {(stepsToRender.length > 0 || isLiveTurn) && (
                              <div
                                style={{
                                  borderRadius: 10,
                                  background: "var(--surface-solid)",
                                  border: "1px solid var(--border-hairline)",
                                  overflow: "hidden",
                                }}
                              >
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setExpandedRunIds((prev) => ({
                                      ...prev,
                                      [runItem.id]: !prev[runItem.id],
                                    }));
                                  }}
                                  style={{
                                    width: "100%",
                                    padding: "6px 10px",
                                    display: "flex",
                                    justifyContent: "space-between",
                                    alignItems: "center",
                                    fontSize: 11.5,
                                    color: "var(--text-secondary)",
                                    fontWeight: 500,
                                  }}
                                >
                                  <span>
                                    {isExpanded ? "▾" : "▸"}{" "}
                                    {isLiveTurn
                                      ? `正在自主运行（第 ${stepsToRender.length} 步）...`
                                      : `已完成 ${stepsToRender.length} 步思考与执行${
                                          compactionCount > 0 ? ` · 自动压缩 ${compactionCount} 次` : ""
                                        }`}
                                  </span>
                                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                                    {runItem.model_calls_used} calls
                                  </span>
                                </button>

                                {isExpanded && stepsToRender.length > 0 && (
                                  <div
                                    style={{
                                      borderTop: "1px solid var(--border-hairline)",
                                      padding: "6px 10px",
                                      display: "flex",
                                      flexDirection: "column",
                                      gap: 5,
                                    }}
                                  >
                                    {stepsToRender.map((st) => {
                                      const badge = actionBadge(st.action);
                                      return (
                                        <div
                                          key={st.id}
                                          style={{
                                            display: "flex",
                                            alignItems: "baseline",
                                            gap: 6,
                                            fontSize: 11.5,
                                            lineHeight: 1.45,
                                          }}
                                        >
                                          <span
                                            style={{
                                              flexShrink: 0,
                                              fontSize: 10.5,
                                              padding: "1px 6px",
                                              borderRadius: 99,
                                              background: badge.bg,
                                              color: badge.color,
                                              fontWeight: 600,
                                            }}
                                          >
                                            {badge.text}
                                          </span>
                                          <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                                            {st.label}
                                          </span>
                                          {st.detail && (
                                            <span
                                              style={{
                                                color: "var(--text-secondary)",
                                                overflow: "hidden",
                                                textOverflow: "ellipsis",
                                                whiteSpace: "nowrap",
                                              }}
                                              title={st.detail}
                                            >
                                              · {st.detail}
                                            </span>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            )}

                            {/* First-person concise conversational reply */}
                            <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--text-primary)" }}>
                              {replyText}
                            </div>

                            {/* Optional Canvas Edit Proposal Preview */}
                            {ops.length > 0 && (
                              <div
                                style={{
                                  display: "flex",
                                  flexDirection: "column",
                                  gap: 8,
                                  paddingTop: 4,
                                }}
                              >
                                {imgOps.length > 0 && (
                                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                    {imgOps.map((op, i) => (
                                      <img
                                        key={`${op.result?.asset_id}-${i}`}
                                        src={op.result?.src}
                                        alt={op.result?.title || "generated"}
                                        style={{
                                          width: 112,
                                          height: 84,
                                          objectFit: "cover",
                                          borderRadius: 8,
                                          border: "1px solid var(--border-hairline)",
                                        }}
                                      />
                                    ))}
                                  </div>
                                )}
                                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                                  <span
                                    style={{
                                      fontSize: 11,
                                      padding: "2px 8px",
                                      borderRadius: 99,
                                      background: runItem.proposal?.verifier?.passed
                                        ? "var(--emerald-soft)"
                                        : "var(--danger-soft)",
                                      color: runItem.proposal?.verifier?.passed
                                        ? "#047857"
                                        : "var(--danger)",
                                    }}
                                  >
                                    {runItem.proposal?.verifier?.passed
                                      ? `${ops.length} 项设计 · 0 碰撞`
                                      : "检测到几何警告"}
                                  </span>
                                  <button
                                    type="button"
                                    className="fc-btn fc-btn-sm fc-btn-obsidian"
                                    disabled={Boolean(
                                      runItem.proposal?.applied || runItem.proposal?.rejected,
                                    )}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void handleApplyProposal(runItem);
                                    }}
                                  >
                                    {runItem.proposal?.applied ? "已应用" : "应用到画布"}
                                  </button>
                                  {runItem.proposal?.applied && !runItem.proposal?.reverted && (
                                    <button
                                      type="button"
                                      className="fc-btn fc-btn-sm"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        void handleRevertProposal(runItem);
                                      }}
                                    >
                                      撤回
                                    </button>
                                  )}
                                  {!runItem.proposal?.applied && !runItem.proposal?.rejected && (
                                    <button
                                      type="button"
                                      className="fc-btn fc-btn-sm"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        void handleRejectProposal(runItem);
                                      }}
                                    >
                                      否决
                                    </button>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                  <div ref={chatBottomRef} />
                </div>

                {/* Compact Debug Bar + Chat Input Composer */}
                <div
                  style={{
                    borderTop: "1px solid var(--border-hairline)",
                    paddingTop: 10,
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      flexWrap: "wrap",
                      alignItems: "center",
                      fontSize: 11.5,
                      color: "var(--text-secondary)",
                    }}
                  >
                    <select
                      style={{ ...controlStyle, height: 28, fontSize: 11.5 }}
                      value={llmMode}
                      onChange={(e) => setLlmMode(e.target.value as "scripted" | "real")}
                    >
                      <option value="real">
                        真实模型（{inspect?.active_model?.model_name || "需先配置"}）
                      </option>
                      <option value="scripted">脚本调试模式（免 Key）</option>
                    </select>

                    <select
                      style={{ ...controlStyle, height: 28, fontSize: 11.5 }}
                      value={compactionThresholdPct}
                      onChange={(e) => setCompactionThresholdPct(Number(e.target.value))}
                      title="自动压缩触发线"
                    >
                      <option value={85}>压缩线 85%（推荐·生产标准）</option>
                      <option value={90}>压缩线 90%（高容忍）</option>
                      <option value={95}>压缩线 95%（极限水位）</option>
                      <option value={5}>压缩线 5%（短窗压测专用）</option>
                    </select>

                    <select
                      style={{ ...controlStyle, height: 28, fontSize: 11.5 }}
                      value={imageEngine}
                      onChange={(e) => {
                        const val = e.target.value as "local-mflux" | "cloud-api" | "mock";
                        setImageEngine(val);
                      }}
                      title="生图引擎选择"
                    >
                      <option value="local-mflux">本地 Flux (mflux-4b ⚡)</option>
                      <option value="cloud-api">云端 API 生图</option>
                      <option value="mock">Mock 极速生图</option>
                    </select>

                    <button
                      type="button"
                      className="chip-btn"
                      style={{ background: "#7c3aed", color: "#fff", border: "none", fontWeight: 600 }}
                      onClick={() => setShowFluxPlayground(true)}
                      title="打开 Flux 2 Klein 本地生图实验室"
                    >
                      🎨 Flux 生图实验室
                    </button>

                    <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <input
                        type="checkbox"
                        checked={forceCompact}
                        onChange={(e) => setForceCompact(e.target.checked)}
                      />
                      强制预压缩
                    </label>

                    <button
                      type="button"
                      className="chip-btn"
                      disabled={busy}
                      onClick={() => {
                        setLabScenario("memory_compaction");
                        setCompactionThresholdPct(85);
                        setLlmMode("scripted");
                        void handleSendMessage(
                          "测试多步循环上下文超阈值后自动压缩记忆，并保留云端摘要",
                          "memory_compaction",
                        );
                      }}
                    >
                      ⚡ 压测 85% 压缩线
                    </button>

                    <button
                      type="button"
                      className="chip-btn"
                      disabled={busy}
                      onClick={() => {
                        setLabScenario("collision_repair");
                        setLlmMode("scripted");
                        void handleSendMessage(
                          "生成暖象牙极简主图并配右侧便签（自动检测碰撞并自修复）",
                          "collision_repair",
                        );
                      }}
                    >
                      ↻ 测试碰撞自修复
                    </button>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
                    <input
                      style={{ ...controlStyle, height: 42, padding: "0 14px", fontSize: 13 }}
                      value={goal}
                      onChange={(e) => setGoal(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          void handleSendMessage();
                        }
                      }}
                      placeholder="像正常对话一样告诉 Agent 你想在画布上创作什么..."
                    />
                    <button
                      type="button"
                      className="fc-btn fc-btn-obsidian"
                      disabled={busy || !selectedCanvasId || !activeSessionId || !goal.trim()}
                      onClick={() => void handleSendMessage()}
                      style={{ height: 42, padding: "0 20px" }}
                    >
                      {busy ? "循环执行中..." : "发送"}
                    </button>
                  </div>
                </div>
              </section>

              {/* Right Column: Context Window Compaction Meter + Cloud Session Memory + 2D Preview */}
              <section style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className={`chip-btn ${rightTab === "context" ? "active" : ""}`}
                    onClick={() => setRightTab("context")}
                  >
                    上下文与云端记忆 (/context)
                  </button>
                  <button
                    type="button"
                    className={`chip-btn ${rightTab === "layout" ? "active" : ""}`}
                    onClick={() => setRightTab("layout")}
                  >
                    2D 排版校验
                  </button>
                  <button
                    type="button"
                    className={`chip-btn ${rightTab === "events" ? "active" : ""}`}
                    onClick={() => setRightTab("events")}
                  >
                    SSE 流 ({events.length})
                  </button>
                </div>

                {rightTab === "context" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <strong style={{ fontSize: 13.5 }}>实时上下文窗口 & 自动压缩线</strong>
                        <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                          {tokenMeter.totalTok} / {tokenMeter.maxTok} tok ({tokenMeter.totalPct}%)
                        </span>
                      </div>

                      {/* Segmented Bar + Dynamic Compaction Threshold Line */}
                      <div style={{ position: "relative", paddingTop: 20, paddingBottom: 6 }}>
                        <div
                          style={{
                            position: "absolute",
                            top: 2,
                            left: `${compactionThresholdPct}%`,
                            transform: "translateX(-50%)",
                            fontSize: 10.5,
                            color: "#b45309",
                            fontWeight: 600,
                            whiteSpace: "nowrap",
                          }}
                        >
                          ▼ 压缩线 {compactionThresholdPct}% ({tokenMeter.thresholdTok} tok)
                        </div>
                        <div
                          style={{
                            height: 12,
                            borderRadius: 99,
                            background: "var(--bg-ivory-2)",
                            overflow: "hidden",
                            display: "flex",
                          }}
                        >
                          <div style={{ width: `${tokenMeter.sysPct}%`, background: "#4f46e5" }} title="系统 Prompt" />
                          <div style={{ width: `${tokenMeter.pinnedPct}%`, background: "#9333ea" }} title="用户核心观点与参数" />
                          <div style={{ width: `${tokenMeter.canvasPct}%`, background: "#d97706" }} title="画布现状" />
                          <div style={{ width: `${tokenMeter.corePct}%`, background: "#059669" }} title="云端因果记忆" />
                          <div style={{ width: `${tokenMeter.recentPct}%`, background: "#0284c7" }} title="近期对话" />
                          <div style={{ width: `${tokenMeter.livePct}%`, background: "#7c3aed" }} title="当前循环" />
                        </div>
                        <div
                          style={{
                            position: "absolute",
                            top: 17,
                            bottom: 2,
                            left: `${compactionThresholdPct}%`,
                            width: 2,
                            background: "#d97706",
                            pointerEvents: "none",
                          }}
                        />
                      </div>

                      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 11, color: "var(--text-secondary)" }}>
                        <span><i style={{ color: "#4f46e5" }}>●</i> 系统 {tokenMeter.sysTok}</span>
                        <span><i style={{ color: "#9333ea" }}>●</i> 核心观点/参数 {tokenMeter.pinnedTok}</span>
                        <span><i style={{ color: "#d97706" }}>●</i> 画布 {tokenMeter.canvasTok}</span>
                        <span><i style={{ color: "#059669" }}>●</i> 因果记忆 {tokenMeter.coreTok}</span>
                        <span><i style={{ color: "#0284c7" }}>●</i> 近期对话 {tokenMeter.recentTok}</span>
                        <span><i style={{ color: "#7c3aed" }}>●</i> 当前循环 {tokenMeter.liveTok}</span>
                      </div>
                    </div>

                    {tokenMeter.compactedInLoop && (
                      <div
                        style={{
                          padding: "8px 10px",
                          borderRadius: 10,
                          background: "var(--emerald-soft)",
                          color: "#047857",
                          fontSize: 12,
                        }}
                      >
                        <strong>循环内自动压缩已触发：</strong>
                        已自动将用户核心观点与硬参数剥离固化，并修剪试错过程写入云端
                        {tokenMeter.compactedSaved > 0
                          ? `，本次释放约 ${tokenMeter.compactedSaved} tokens`
                          : ""}
                        。
                      </div>
                    )}

                    {/* Layer 2: Pinned User Directives / Core Values (Immutable Anchor) */}
                    <div
                      style={{
                        borderRadius: 12,
                        border: "1px solid #e9d5ff",
                        background: "#faf5ff",
                        padding: 12,
                        display: "flex",
                        flexDirection: "column",
                        gap: 8,
                        fontSize: 12,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ fontSize: 13 }}>📌</span>
                          <strong style={{ color: "#6b21a8" }}>
                            用户核心观点与硬参数（不可压缩强锚定区）
                          </strong>
                        </div>
                        <span
                          style={{
                            fontSize: 11,
                            padding: "1px 8px",
                            borderRadius: 99,
                            background: "#f3e8ff",
                            color: "#7e22ce",
                            fontWeight: 600,
                          }}
                        >
                          {(activeSession?.pinned_user_values || []).length} 条准则
                        </span>
                      </div>
                      {(activeSession?.pinned_user_values || []).length === 0 ? (
                        <div style={{ color: "#7e22ce", opacity: 0.85, lineHeight: 1.5 }}>
                          暂无提取观点（达到 85% 压缩线或清理聊天保留记忆时，将自动从对话中提炼专员观点、比例色值等硬参数，语义去重覆写并 100% 置顶保真）。
                        </div>
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          {(activeSession?.pinned_user_values || []).map((val, idx) => (
                            <div
                              key={idx}
                              style={{
                                display: "flex",
                                alignItems: "flex-start",
                                gap: 6,
                                padding: "6px 9px",
                                background: "#ffffff",
                                borderRadius: 6,
                                border: "1px solid #f3e8ff",
                                fontSize: 12,
                                color: "#581c87",
                                lineHeight: 1.45,
                              }}
                            >
                              <span style={{ color: "#9333ea", fontWeight: 700 }}>•</span>
                              <span>{val}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Layer 4 Pruning: Cloud Session Core Memory Box (Pruned Causal Memory) */}
                    <div
                      style={{
                        borderRadius: 12,
                        background: "var(--bg-ivory-2)",
                        padding: 12,
                        display: "flex",
                        flexDirection: "column",
                        gap: 8,
                        fontSize: 12,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ fontSize: 13 }}>☁️</span>
                          <strong>
                            过程蒸馏与因果经验（已压缩{" "}
                            {inspect?.memory.compacted_run_count || 0} 轮 · 活跃{" "}
                            {inspect?.recent_turns?.length || 0} 轮）
                          </strong>
                        </div>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button type="button" className="fc-btn fc-btn-sm" onClick={handleCompactMemory}>
                            手动压缩
                          </button>
                          <button type="button" className="fc-btn fc-btn-sm" onClick={handleResetSessionMemory}>
                            重置记忆
                          </button>
                        </div>
                      </div>
                      <div style={{ color: "var(--text-secondary)", whiteSpace: "pre-wrap", lineHeight: 1.55 }}>
                        {inspect?.memory.compacted_summary ||
                          "暂无过程摘要（当循环触及压缩线、手动点击压缩或「清空聊天并保留记忆」时，中间试错将被修剪为关键因果经验）"}
                      </div>
                    </div>

                    {inspect && (
                      <pre
                        style={{
                          margin: 0,
                          padding: 10,
                          borderRadius: 10,
                          background: "#18181b",
                          color: "#f4f4f5",
                          fontSize: 11,
                          maxHeight: 230,
                          overflow: "auto",
                        }}
                      >
                        {JSON.stringify(
                          {
                            session_id: activeSessionId,
                            live_context_snapshot: latestContextEvt?.data || null,
                            recent_turns: inspect.recent_turns || [],
                            canvas_brief_count: inspect.item_count,
                          },
                          null,
                          2,
                        )}
                      </pre>
                    )}
                  </div>
                )}

                {rightTab === "layout" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <div
                      style={{
                        borderRadius: 12,
                        border: "1px solid var(--border-hairline)",
                        background: "#FBF9F6",
                        padding: 8,
                      }}
                    >
                      <svg viewBox={svgViewBox} style={{ width: "100%", height: 280, display: "block" }}>
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
                    </div>
                    <div style={{ display: "flex", gap: 12, fontSize: 11, color: "var(--text-secondary)" }}>
                      <span>■ 灰褐：画布已有对象</span>
                      <span style={{ color: "#2563eb" }}>┄ 蓝框：本轮提案对象</span>
                      <span style={{ color: "#dc2626" }}>■ 红框：碰撞警告</span>
                    </div>
                  </div>
                )}

                {rightTab === "events" && (
                  <pre
                    style={{
                      margin: 0,
                      padding: 12,
                      borderRadius: 12,
                      background: "#18181b",
                      color: "#e4e4e7",
                      fontSize: 11,
                      maxHeight: 400,
                      overflow: "auto",
                    }}
                  >
                    {events.length > 0
                      ? JSON.stringify(events, null, 2)
                      : "发送消息启动自主循环后，这里将展示实时 SSE 协议事件流。"}
                  </pre>
                )}
              </section>
            </div>
          </>
        )}
      </main>

      {showFluxPlayground && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(0, 0, 0, 0.45)",
            backdropFilter: "blur(4px)",
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowFluxPlayground(false);
          }}
        >
          <div
            style={{
              background: "#fff",
              borderRadius: 16,
              boxShadow: "0 20px 40px rgba(0,0,0,0.2)",
              width: "100%",
              maxWidth: 720,
              maxHeight: "90vh",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "16px 20px",
                borderBottom: "1px solid var(--border-color)",
                background: "#fafaf9",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 20 }}>🎨</span>
                <div>
                  <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
                    Flux 2 Klein (4-bit) 本地生图实验室
                  </h3>
                  <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    基于 Apple Silicon MLX GPU · 本地桥接: http://127.0.0.1:8002/v1
                  </span>
                </div>
              </div>
              <button
                type="button"
                className="fc-btn fc-btn-ghost fc-btn-sm"
                style={{ fontSize: 16, cursor: "pointer" }}
                onClick={() => setShowFluxPlayground(false)}
              >
                ✕
              </button>
            </div>

            <div
              style={{
                padding: 20,
                overflowY: "auto",
                display: "flex",
                flexDirection: "column",
                gap: 16,
              }}
            >
              <div>
                <label
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    display: "block",
                    marginBottom: 6,
                  }}
                >
                  快速填入预设需求场景：
                </label>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {[
                    {
                      label: "🐱 窗台小猫 (16:9)",
                      prompt:
                        "a cute cat sitting on a windowsill, soft natural lighting, high detail",
                      aspect: "16:9",
                    },
                    {
                      label: "🐕 3只不同品种狗狗 (16:9)",
                      prompt:
                        "three different cute dogs, golden retriever, corgi and siberian husky, studio lighting",
                      aspect: "16:9",
                    },
                    {
                      label: "🎨 极简暖象牙主图 (16:9)",
                      prompt:
                        "warm ivory minimalist editorial background visual, elegant aesthetics, 16:9 aspect ratio",
                      aspect: "16:9",
                    },
                    {
                      label: "🏥 医疗对比图像 (4:3)",
                      prompt:
                        "high contrast cold gray minimalist abstract concept visual, professional clarity",
                      aspect: "4:3",
                    },
                  ].map((p, idx) => (
                    <button
                      key={idx}
                      type="button"
                      className="chip-btn"
                      style={{ fontSize: 11.5 }}
                      onClick={() => {
                        setFluxPrompt(p.prompt);
                        setFluxAspect(p.aspect as "16:9" | "1:1" | "4:3" | "9:16");
                      }}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    display: "block",
                    marginBottom: 6,
                  }}
                >
                  提示词 (Prompt):
                </label>
                <textarea
                  rows={3}
                  value={fluxPrompt}
                  onChange={(e) => setFluxPrompt(e.target.value)}
                  style={{
                    width: "100%",
                    padding: 10,
                    borderRadius: 8,
                    border: "1px solid var(--border-color)",
                    fontSize: 13,
                    boxSizing: "border-box",
                  }}
                  placeholder="输入画面描述..."
                />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                <div>
                  <label
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      display: "block",
                      marginBottom: 6,
                    }}
                  >
                    画幅比例 (Aspect Ratio):
                  </label>
                  <div style={{ display: "flex", gap: 8 }}>
                    {(["16:9", "1:1", "4:3", "9:16"] as const).map((r) => (
                      <button
                        key={r}
                        type="button"
                        className="fc-btn fc-btn-sm"
                        style={{
                          flex: 1,
                          background: fluxAspect === r ? "#7c3aed" : "var(--bg-card)",
                          color: fluxAspect === r ? "#fff" : "inherit",
                          border: "1px solid var(--border-color)",
                        }}
                        onClick={() => setFluxAspect(r)}
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      display: "block",
                      marginBottom: 6,
                    }}
                  >
                    渲染步数 (Steps: {fluxSteps} 步 - 4步极速推理):
                  </label>
                  <input
                    type="range"
                    min={1}
                    max={12}
                    value={fluxSteps}
                    onChange={(e) => setFluxSteps(Number(e.target.value))}
                    style={{ width: "100%", accentColor: "#7c3aed" }}
                  />
                </div>
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
                <button
                  type="button"
                  className="fc-btn fc-btn-primary"
                  style={{ background: "#7c3aed", borderColor: "#7c3aed" }}
                  disabled={fluxRendering || !fluxPrompt.trim()}
                  onClick={() => void handleGenerateFlux()}
                >
                  {fluxRendering
                    ? "⚡ 正在调用 Apple Silicon MLX 渲染..."
                    : "🚀 开始本地渲染 (RunPod/FLUX.2-klein-4B)"}
                </button>
              </div>

              {fluxResult && (
                <div
                  style={{
                    marginTop: 10,
                    padding: 14,
                    borderRadius: 12,
                    background: "#fafaf9",
                    border: "1px solid var(--border-color)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 12,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <span style={{ fontSize: 12, fontWeight: 600, color: "#166534" }}>
                      ✓ 渲染成功 · MinIO 资产持久化就绪
                    </span>
                    <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                      ID: {fluxResult.id.slice(0, 8)}... | {fluxResult.width}×
                      {fluxResult.height} ({fluxAspect})
                    </span>
                  </div>

                  <div
                    style={{
                      width: "100%",
                      maxHeight: 320,
                      borderRadius: 8,
                      overflow: "hidden",
                      background: "#000",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <img
                      src={`/api/assets/${fluxResult.id}/content`}
                      alt="Flux 2 Preview"
                      style={{
                        maxWidth: "100%",
                        maxHeight: 320,
                        objectFit: "contain",
                      }}
                    />
                  </div>

                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                      引擎: Apple Silicon MLX (mflux-4bit) · 存储: S3/MinIO
                    </span>
                    <button
                      type="button"
                      className="fc-btn fc-btn-sm"
                      style={{
                        background: "#10b981",
                        color: "#fff",
                        border: "none",
                        fontWeight: 600,
                      }}
                      onClick={() => void handlePushFluxToCanvas()}
                    >
                      📥 一键推入画布 (无重叠落盘)
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
