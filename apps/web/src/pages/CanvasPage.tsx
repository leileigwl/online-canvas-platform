import {
  api,
  ApiError,
  type AgentRun,
  type Asset,
  type CanvasMemory,
  type CanvasVersion,
  type ImageModelConfig,
  subscribeRunEvents,
  type User,
} from "@canvas/api-client";
import type { CanvasDocument, CanvasItem, CanvasViewport } from "@canvas/canvas-core";
import type Konva from "konva";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import {
  CanvasMinimap,
} from "../components/canvas/CanvasMinimap";
import {
  DynamicImageParams,
  type GenerationParamState,
  summarizeGenerationRule,
} from "../components/canvas/DynamicImageParams";
import { KonvaStageView } from "../components/canvas/KonvaStageView";
import { LeftLayersDrawer } from "../components/canvas/LeftLayersDrawer";
import { type CanvasToolMode, LeftToolRail } from "../components/canvas/LeftToolRail";
import {
  RightAgentDrawer,
  type StreamThinkingItem,
  type StreamToolCallItem,
} from "../components/canvas/RightAgentDrawer";
import {
  BrandMarkSvg,
  ImageIcon,
  SendUpIcon,
  SlidersIcon,
  SparkleIcon,
} from "../components/Icons";
import { clearCanvasDraft, loadCanvasDraft, saveCanvasDraft } from "../lib/draft-db";
import { exportKonvaCanvasPng, exportSelectedAsset } from "../lib/export-canvas";

export function CanvasPage() {
  const { canvasId = "" } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [user, setUser] = useState<User | null>(null);
  const [canvasName, setCanvasName] = useState("加载中...");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState("");
  const [revision, setRevision] = useState(0);
  const [doc, setDoc] = useState<CanvasDocument>({ schema_version: 1, items: [] });
  const [viewport, setViewport] = useState<CanvasViewport>({ x: 520, y: 340, scale: 1 });
  const [syncState, setSyncState] = useState<"synced" | "dirty" | "saving" | "error">("synced");

  const [undoStack, setUndoStack] = useState<CanvasDocument[]>([]);
  const [redoStack, setRedoStack] = useState<CanvasDocument[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [refAssetIds, setRefAssetIds] = useState<string[]>([]);

  const [assets, setAssets] = useState<Asset[]>([]);
  const [imageConfig, setImageConfig] = useState<ImageModelConfig | null>(null);

  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(false);
  const [tool, setTool] = useState<CanvasToolMode>("select");
  const [spacePressed, setSpacePressed] = useState(false);
  const [textFont, setTextFont] = useState<"sans" | "serif" | "mono">("sans");
  const [textSize, setTextSize] = useState(22);
  const [brushWidth, setBrushWidth] = useState(4);
  const [strokeColor, setStrokeColor] = useState("#141413");

  const [dockMode, setDockMode] = useState<"image" | "agent">("image");
  const [prompt, setPrompt] = useState("");
  const [paramsOpen, setParamsOpen] = useState(false);
  const [genParams, setGenParams] = useState<GenerationParamState>({
    model: "auto",
    aspectRatio: "auto",
    quality: "auto",
    inputFidelity: "high",
    transparent: false,
    count: 1,
  });
  const [submitting, setSubmitting] = useState(false);

  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [versions, setVersions] = useState<CanvasVersion[]>([]);

  // Live SSE & Harness Multi-Turn Agent State
  const [agentRun, setAgentRun] = useState<AgentRun | null>(null);
  const [pastRuns, setPastRuns] = useState<AgentRun[]>([]);
  const [canvasMemory, setCanvasMemory] = useState<CanvasMemory | null>(null);
  const [thinkingSteps, setThinkingSteps] = useState<StreamThinkingItem[]>([]);
  const [toolCalls, setToolCalls] = useState<StreamToolCallItem[]>([]);
  const [sseActive, setSseActive] = useState(false);
  const [applying, setApplying] = useState(false);
  const unsubSseRef = useRef<(() => void) | null>(null);

  const [stageSize, setStageSize] = useState({
    width: typeof window !== "undefined" ? window.innerWidth : 1440,
    height: typeof window !== "undefined" ? window.innerHeight : 900,
  });
  const [toast, setToast] = useState<string | null>(null);

  const stageRef = useRef<Konva.Stage | null>(null);
  const contentLayerRef = useRef<Konva.Layer | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const loadedRevisionRef = useRef(0);
  const dirtyRef = useRef(false);
  const docRef = useRef(doc);
  docRef.current = doc;

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 3200);
  }, []);

  const fitView = useCallback((itemsList: CanvasItem[], vw: number, vh: number) => {
    const visible = itemsList.filter((i) => i.visible !== false);
    if (!visible.length) {
      setViewport({ x: vw / 2, y: vh * 0.45, scale: 1 });
      return;
    }
    const minX = Math.min(...visible.map((i) => i.x));
    const minY = Math.min(...visible.map((i) => i.y));
    const maxX = Math.max(...visible.map((i) => i.x + i.width));
    const maxY = Math.max(...visible.map((i) => i.y + i.height));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const bw = Math.max(240, maxX - minX + 260);
    const bh = Math.max(220, maxY - minY + 260);
    const scale = Math.max(0.35, Math.min(1.15, Math.min(vw / bw, vh / bh)));
    setViewport({ x: vw / 2 - cx * scale, y: vh * 0.45 - cy * scale, scale });
  }, []);

  // Track window size
  useEffect(() => {
    const onResize = () => setStageSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Load auth + canvas + assets + draft
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const me = await api.me();
        if (!active) return;
        setUser(me);
        const [snapshot, assetList, imgCfg, runsList, memInfo] = await Promise.all([
          api.getCanvas(canvasId),
          api.listAssets(),
          api.getImageConfig().catch(() => null),
          api.listAgentRuns(canvasId).catch(() => [] as AgentRun[]),
          api.getCanvasMemory(canvasId).catch(() => null),
        ]);
        if (!active) return;

        setCanvasName(snapshot.name);
        setTitleInput(snapshot.name);
        setRevision(snapshot.revision);
        loadedRevisionRef.current = snapshot.revision;
        setAssets(assetList);
        if (imgCfg) setImageConfig(imgCfg);
        setPastRuns(runsList);
        if (memInfo) setCanvasMemory(memInfo);
        if (runsList.length > 0 && !agentRun) {
          const latest = runsList[0];
          setAgentRun(latest);
          if (latest.proposal?.operations) {
            setToolCalls(
              latest.proposal.operations.map((op, idx) => ({
                id: `hist-${latest.id}-${idx}`,
                tool: op.tool,
                label: op.tool,
                params: op.params,
                status: latest.proposal?.applied
                  ? "applied"
                  : op.result?.asset_id
                    ? "created"
                    : "pending",
                result: op.result,
              })),
            );
          }
        }

        let initialDoc = snapshot.document;
        const draft = await loadCanvasDraft(canvasId);
        if (draft && draft.baseRevision === snapshot.revision) {
          initialDoc = draft.document;
          dirtyRef.current = true;
          setSyncState("dirty");
        }

        // Insert asset returning from /assets?canvasId=...
        const insertAssetId = searchParams.get("insertAssetId");
        const noticeMsg = searchParams.get("notice");
        if (insertAssetId) {
          const target = assetList.find((a) => a.id === insertAssetId);
          if (target) {
            const newItem: CanvasItem = {
              id: `asset-${Date.now()}`,
              type: "image",
              x: -90,
              y: -80,
              width: 210,
              height: Math.max(130, Math.round((210 * target.height) / Math.max(1, target.width))),
              title: target.name,
              asset_id: target.id,
              src: target.src,
              visible: true,
            };
            initialDoc = {
              ...initialDoc,
              items: [...initialDoc.items, newItem],
            };
            dirtyRef.current = true;
            setSyncState("dirty");
            setSelectedIds([newItem.id]);
            setRefAssetIds((prev) => (prev.includes(target.id) ? prev : [...prev, target.id]));
            notify(`已将「${target.name}」插入当前画布`);
          }
          setSearchParams({}, { replace: true });
        } else if (noticeMsg) {
          notify(noticeMsg);
          setSearchParams({}, { replace: true });
        }

        setDoc(initialDoc);
        fitView(initialDoc.items, window.innerWidth, window.innerHeight);
      } catch (err) {
        if (!active) return;
        if (err instanceof ApiError && err.status === 401) {
          navigate(`/login?returnTo=${encodeURIComponent(`/canvas/${canvasId}`)}`, { replace: true });
        } else {
          notify(err instanceof ApiError ? err.message : "无法打开画布");
        }
      }
    })();

    return () => {
      active = false;
      unsubSseRef.current?.();
    };
  }, [canvasId, fitView, navigate, notify, searchParams, setSearchParams]);

  // Helper to commit a document mutation onto undo stack and mark dirty (StrictMode-safe)
  const commitDoc = useCallback((updater: (prev: CanvasDocument) => CanvasDocument) => {
    const prev = docRef.current;
    const next = updater(prev);
    docRef.current = next;
    setUndoStack((st) => [...st.slice(-39), prev]);
    setRedoStack([]);
    setDoc(next);
    dirtyRef.current = true;
    setSyncState("dirty");
  }, []);

  // 500ms debounced IndexedDB cache + 1200ms debounced cloud PUT /canvases/{id}
  useEffect(() => {
    if (!dirtyRef.current || !user) return;
    const idbTimer = window.setTimeout(() => {
      void saveCanvasDraft({
        canvasId,
        baseRevision: loadedRevisionRef.current,
        document: doc,
        viewport,
        updatedAt: Date.now(),
      });
    }, 500);

    const cloudTimer = window.setTimeout(async () => {
      if (!dirtyRef.current) return;
      setSyncState("saving");
      try {
        const saved = await api.saveCanvas(canvasId, loadedRevisionRef.current, doc, viewport);
        loadedRevisionRef.current = saved.revision;
        setRevision(saved.revision);
        dirtyRef.current = false;
        setSyncState("synced");
        await clearCanvasDraft(canvasId);
      } catch (err) {
        setSyncState("error");
        if (err instanceof ApiError && err.status === 409) {
          notify("检测到云端画布版本更新，请刷新同步后再保存");
        }
      }
    }, 1200);

    return () => {
      window.clearTimeout(idbTimer);
      window.clearTimeout(cloudTimer);
    };
  }, [doc, viewport, canvasId, user, notify]);

  const undoRef = useRef(undoStack);
  undoRef.current = undoStack;
  const redoRef = useRef(redoStack);
  redoRef.current = redoStack;

  const handleUndo = useCallback(() => {
    const st = undoRef.current;
    if (!st.length) return;
    const previous = st[st.length - 1];
    const current = docRef.current;
    docRef.current = previous;
    setUndoStack(st.slice(0, -1));
    setRedoStack((r) => [...r, current]);
    setDoc(previous);
    dirtyRef.current = true;
    setSyncState("dirty");
  }, []);

  const handleRedo = useCallback(() => {
    const st = redoRef.current;
    if (!st.length) return;
    const nextDoc = st[st.length - 1];
    const current = docRef.current;
    docRef.current = nextDoc;
    setRedoStack(st.slice(0, -1));
    setUndoStack((u) => [...u, current]);
    setDoc(nextDoc);
    dirtyRef.current = true;
    setSyncState("dirty");
  }, []);

  const handleDeleteSelected = useCallback(() => {
    if (!selectedIds.length) return;
    const count = selectedIds.length;
    const removedAssetIds = new Set(
      doc.items.filter((i) => selectedIds.includes(i.id) && i.asset_id).map((i) => i.asset_id!),
    );
    commitDoc((prev) => ({
      ...prev,
      items: prev.items.filter((i) => !selectedIds.includes(i.id)),
    }));
    setRefAssetIds((prev) => prev.filter((id) => !removedAssetIds.has(id)));
    setSelectedIds([]);
    notify(`已删除 ${count} 个对象（Ctrl/Cmd+Z 可撤销）`);
  }, [commitDoc, doc.items, notify, selectedIds]);

  // Global PS keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.code === "Space") {
        e.preventDefault();
        setSpacePressed(true);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        handleDeleteSelected();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
      } else if (e.key.toLowerCase() === "v") {
        setTool("select");
      } else if (e.key.toLowerCase() === "h") {
        setTool("hand");
      } else if (e.key.toLowerCase() === "t") {
        setTool("text");
      } else if (e.key.toLowerCase() === "b") {
        setTool("brush");
      } else if (e.key === "Escape") {
        setSelectedIds([]);
        setParamsOpen(false);
        setExportMenuOpen(false);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpacePressed(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [handleDeleteSelected, handleRedo, handleUndo]);

  const handleAlignSelected = () => {
    if (selectedIds.length < 2) {
      notify("请先框选或按住 Shift 多选至少 2 个对象再局部对齐");
      return;
    }
    commitDoc((prev) => {
      const targets = prev.items.filter((i) => selectedIds.includes(i.id));
      if (targets.length < 2) return prev;
      const startX = Math.min(...targets.map((t) => t.x));
      const startY = Math.min(...targets.map((t) => t.y));
      const cols = Math.min(3, targets.length);
      const colW = Math.max(...targets.map((t) => t.width)) + 24;
      const rowH = Math.max(...targets.map((t) => t.height)) + 24;

      const updatedMap = new Map<string, { x: number; y: number }>();
      targets.forEach((t, idx) => {
        updatedMap.set(t.id, {
          x: Math.round(startX + (idx % cols) * colW),
          y: Math.round(startY + Math.floor(idx / cols) * rowH),
        });
      });

      return {
        ...prev,
        items: prev.items.map((it) => {
          const patch = updatedMap.get(it.id);
          return patch ? { ...it, x: patch.x, y: patch.y } : it;
        }),
      };
    });
    notify(`已就近网格对齐选中的 ${selectedIds.length} 个对象`);
  };

  const handleUploadFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    try {
      const uploaded: Asset[] = [];
      for (const file of files) {
        uploaded.push(await api.uploadAsset(file));
      }
      setAssets((prev) => [...uploaded, ...prev]);
      const centerX = Math.round((stageSize.width / 2 - viewport.x) / viewport.scale);
      const centerY = Math.round((stageSize.height / 2 - viewport.y) / viewport.scale);
      const addedItems: CanvasItem[] = uploaded.map((asset, idx) => ({
        id: `img-${Date.now()}-${idx}`,
        type: "image",
        x: centerX - 105 + idx * 36,
        y: centerY - 80 + idx * 36,
        width: 210,
        height: Math.max(120, Math.round((210 * asset.height) / Math.max(1, asset.width))),
        title: asset.name,
        asset_id: asset.id,
        src: asset.src,
        visible: true,
      }));
      commitDoc((prev) => ({ ...prev, items: [...prev.items, ...addedItems] }));
      setSelectedIds(addedItems.map((i) => i.id));
      notify(`已上传 ${uploaded.length} 张图片到画布并同步素材库`);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "上传图片失败");
    }
  };

  const handleFinishRename = async () => {
    setEditingTitle(false);
    const trimmed = titleInput.trim();
    if (!trimmed || trimmed === canvasName) return;
    try {
      const renamed = await api.renameCanvas(canvasId, trimmed);
      setCanvasName(renamed.name);
      notify(`画布已重命名为「${renamed.name}」`);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "重命名失败");
    }
  };

  const handleOpenHistory = async () => {
    setHistoryOpen(true);
    try {
      const list = await api.listCanvasVersions(canvasId, 12);
      setVersions(list);
    } catch {
      notify("加载历史版本失败");
    }
  };

  const handleRestoreVersion = async (verRev: number) => {
    try {
      // Ensure latest local changes aren't pending before restore
      let baseRev = loadedRevisionRef.current;
      if (dirtyRef.current) {
        const saved = await api.saveCanvas(canvasId, baseRev, doc, viewport);
        baseRev = saved.revision;
      }
      const restored = await api.restoreCanvasVersion(canvasId, verRev, baseRev);
      loadedRevisionRef.current = restored.revision;
      setRevision(restored.revision);
      dirtyRef.current = false;
      setSyncState("synced");
      await clearCanvasDraft(canvasId);
      setDoc(restored.document);
      setHistoryOpen(false);
      notify(`已恢复到快照 Revision #${verRev}`);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "恢复版本失败");
    }
  };

  const startRunSse = useCallback(
    (runId: string) => {
      unsubSseRef.current?.();
      setSseActive(true);
      unsubSseRef.current = subscribeRunEvents(
        runId,
        async (evt) => {
          if (evt.type === "thinking") {
            setThinkingSteps((prev) => [
              ...prev,
              {
                id: `${evt.sequence}-${prev.length}`,
                role: String(evt.data.role || "Agent"),
                title: String(evt.data.title || "思考"),
                text: String(evt.data.text || ""),
              },
            ]);
          } else if (evt.type === "tool_call") {
            const toolName = String(evt.data.tool || "tool");
            const params = (evt.data.params as Record<string, unknown>) || {};
            const status = String(evt.data.status || "pending");
            const result = evt.data.result as StreamToolCallItem["result"] | undefined;
            setToolCalls((prev) => {
              // Update matching running card if created finished
              const matchIdx = prev.findIndex(
                (c) =>
                  c.tool === toolName &&
                  c.status === "running" &&
                  JSON.stringify(c.params) === JSON.stringify(params),
              );
              const nextCard: StreamToolCallItem = {
                id: matchIdx >= 0 ? prev[matchIdx].id : `${evt.sequence}-${prev.length}`,
                tool: toolName,
                label: String(evt.data.label || toolName),
                params,
                status,
                result,
              };
              if (matchIdx >= 0) {
                const copy = [...prev];
                copy[matchIdx] = nextCard;
                return copy;
              }
              return [...prev, nextCard];
            });
          } else if (evt.type === "succeeded" || evt.type === "failed" || evt.type === "canceled") {
            setSseActive(false);
            unsubSseRef.current?.();
            try {
              const [latest, runsList, memInfo] = await Promise.all([
                api.getAgentRun(runId),
                api.listAgentRuns(canvasId).catch(() => [] as AgentRun[]),
                api.getCanvasMemory(canvasId).catch(() => null),
              ]);
              setAgentRun(latest);
              if (runsList.length) setPastRuns(runsList);
              if (memInfo) setCanvasMemory(memInfo);
            } catch {
              // ignore fetch fail
            }
          }
        },
        () => {
          setSseActive(false);
        },
      );
    },
    [canvasId],
  );

  const handleSubmitBottomDock = async () => {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt || submitting) {
      if (!cleanPrompt) notify("请输入创作或生图描述");
      return;
    }

    setSubmitting(true);
    setParamsOpen(false);
    try {
      if (dockMode === "image") {
        const res = await api.generateImage({
          prompt: cleanPrompt,
          reference_asset_ids: refAssetIds,
          model: genParams.model,
          quality: genParams.quality,
          width: 1024,
          height: 1024,
          align_to_16: true,
          resolution: "auto",
          aspect_ratio: genParams.aspectRatio,
          transparent: genParams.transparent,
          input_fidelity: genParams.inputFidelity,
          count: genParams.count,
        });
        const centerX = Math.round((stageSize.width / 2 - viewport.x) / viewport.scale);
        const centerY = Math.round((stageSize.height / 2 - viewport.y) / viewport.scale);
        const newNodes: CanvasItem[] = res.images.map((asset, idx) => ({
          id: `gen-${Date.now()}-${idx}`,
          type: "image",
          x: centerX - 115 + idx * 240,
          y: centerY - 120,
          width: 230,
          height: Math.max(140, Math.round((230 * asset.height) / Math.max(1, asset.width))),
          title: asset.name,
          asset_id: asset.id,
          src: asset.src,
          visible: true,
        }));
        commitDoc((prev) => ({ ...prev, items: [...prev.items, ...newNodes] }));
        setSelectedIds(newNodes.map((n) => n.id));
        setAssets((prev) => [...res.images, ...prev]);
        setPrompt("");
        notify(`已直接生成 ${res.images.length} 张图片并落到画布`);
      } else {
        // Ensure latest canvas revision is persisted to Postgres before launching Agent run
        let baseRev = loadedRevisionRef.current;
        if (dirtyRef.current) {
          const saved = await api.saveCanvas(canvasId, baseRev, doc, viewport);
          loadedRevisionRef.current = saved.revision;
          setRevision(saved.revision);
          dirtyRef.current = false;
          setSyncState("synced");
        }
        setRightOpen(true);
        setThinkingSteps([]);
        setToolCalls([]);
        const run = await api.submitAgentGoal({
          canvas_id: canvasId,
          goal: cleanPrompt,
          reference_asset_ids: refAssetIds,
          idempotency_key: `run-${canvasId}-${Date.now()}`,
        });
        setAgentRun(run);
        setPrompt("");
        startRunSse(run.id);
      }
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "提交失败，请检查配置后重试");
    } finally {
      setSubmitting(false);
    }
  };

  const handleApplyAgentProposal = async () => {
    if (!agentRun || applying) return;
    setApplying(true);
    try {
      const updated = await api.applyProposal(agentRun.id, loadedRevisionRef.current);
      setUndoStack((st) => [...st.slice(-39), doc]);
      loadedRevisionRef.current = updated.revision;
      setRevision(updated.revision);
      dirtyRef.current = false;
      setSyncState("synced");
      await clearCanvasDraft(canvasId);
      setDoc(updated.document);
      setToolCalls((prev) => prev.map((c) => ({ ...c, status: "applied" })));
      setAgentRun((prev) =>
        prev && prev.proposal ? { ...prev, proposal: { ...prev.proposal, applied: true } } : prev,
      );
      setPastRuns((prev) =>
        prev.map((r) =>
          r.id === agentRun.id && r.proposal
            ? { ...r, proposal: { ...r.proposal, applied: true } }
            : r,
        ),
      );
      notify("已将 Agent 提案安全写入画布（支持单批精准回退或 Ctrl/Cmd+Z 撤销）");
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "应用提案失败");
    } finally {
      setApplying(false);
    }
  };

  const handleRevertAgentProposal = async () => {
    if (!agentRun || applying) return;
    setApplying(true);
    try {
      let baseRev = loadedRevisionRef.current;
      if (dirtyRef.current) {
        const saved = await api.saveCanvas(canvasId, baseRev, doc, viewport);
        baseRev = saved.revision;
        loadedRevisionRef.current = saved.revision;
      }
      const reverted = await api.revertProposal(agentRun.id, baseRev);
      setUndoStack((st) => [...st.slice(-39), doc]);
      loadedRevisionRef.current = reverted.revision;
      setRevision(reverted.revision);
      dirtyRef.current = false;
      setSyncState("synced");
      await clearCanvasDraft(canvasId);
      setDoc(reverted.document);
      setAgentRun((prev) =>
        prev && prev.proposal ? { ...prev, proposal: { ...prev.proposal, reverted: true } } : prev,
      );
      setPastRuns((prev) =>
        prev.map((r) =>
          r.id === agentRun.id && r.proposal
            ? { ...r, proposal: { ...r.proposal, reverted: true } }
            : r,
        ),
      );
      setCanvasMemory(await api.getCanvasMemory(canvasId).catch(() => null));
      notify("已精准回退该批 Agent 提案（其他手工修改已保留，并记入 Harness 避坑记忆）");
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "回退提案失败");
    } finally {
      setApplying(false);
    }
  };

  // Resolve bottom dock ref chips
  const refChipItems = useMemo(
    () =>
      refAssetIds
        .map((id) => assets.find((a) => a.id === id) || doc.items.find((i) => i.asset_id === id))
        .filter((x): x is NonNullable<typeof x> => Boolean(x)),
    [refAssetIds, assets, doc.items],
  );

  const zoomPercent = Math.round(viewport.scale * 100);
  const dotGap = Math.max(8, 24 * viewport.scale);

  return (
    <div
      className="canvas-shell"
      style={{
        backgroundSize: `${dotGap}px ${dotGap}px`,
        backgroundPosition: `${viewport.x % dotGap}px ${viewport.y % dotGap}px`,
      }}
    >
      <input
        ref={uploadInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: "none" }}
        onChange={handleUploadFiles}
      />

      {/* Konva Infinite Canvas */}
      <KonvaStageView
        items={doc.items}
        viewport={viewport}
        onChangeViewport={(next) => {
          setViewport(next);
          dirtyRef.current = true;
        }}
        selectedIds={selectedIds}
        onChangeSelectedIds={(ids, clickedItem) => {
          setSelectedIds(ids);
          if (clickedItem?.type === "image" && clickedItem.asset_id) {
            const aid = clickedItem.asset_id;
            setRefAssetIds((prev) => (prev.includes(aid) ? prev : [...prev, aid]));
          }
        }}
        tool={tool}
        spacePressed={spacePressed}
        strokeColor={strokeColor}
        brushWidth={brushWidth}
        textFont={textFont}
        textSize={textSize}
        onMoveItem={(id, x, y) => {
          commitDoc((prev) => ({
            ...prev,
            items: prev.items.map((it) => (it.id === id ? { ...it, x, y } : it)),
          }));
        }}
        onResizeItem={(id, x, y, width, height) => {
          commitDoc((prev) => ({
            ...prev,
            items: prev.items.map((it) =>
              it.id === id ? { ...it, x, y, width, height } : it,
            ),
          }));
        }}
        onCreateTextAt={(x, y) => {
          const id = `txt-${Date.now()}`;
          commitDoc((prev) => ({
            ...prev,
            items: [
              ...prev.items,
              {
                id,
                type: "text",
                x,
                y,
                width: 240,
                height: 52,
                title: "文字图层",
                content: "双击编辑文字内容",
                font_family: textFont,
                font_size: textSize,
                color: strokeColor,
                visible: true,
              },
            ],
          }));
          setSelectedIds([id]);
          setTool("select");
          return id;
        }}
        onUpdateTextContent={(id, content) => {
          if (!content.trim()) {
            commitDoc((prev) => ({
              ...prev,
              items: prev.items.filter((it) => it.id !== id),
            }));
            setSelectedIds((prev) => prev.filter((sid) => sid !== id));
            notify("文字已清空，自动移除空白文本框");
            return;
          }
          commitDoc((prev) => ({
            ...prev,
            items: prev.items.map((it) =>
              it.id === id ? { ...it, content, title: content.slice(0, 20) || "文字图层" } : it,
            ),
          }));
        }}
        onCreateBrush={(brushItem) => {
          commitDoc((prev) => ({ ...prev, items: [...prev.items, brushItem] }));
          setSelectedIds([brushItem.id]);
        }}
        stageRef={stageRef}
        contentLayerRef={contentLayerRef}
        stageSize={stageSize}
      />

      {/* Top-Center Header Capsule */}
      <header className="canvas-top-center">
        <button type="button" className="brand-logo" onClick={() => navigate("/")}>
          <span className="brand-mark">
            <BrandMarkSvg />
          </span>
          <span>FlowCanvas</span>
        </button>
        <span className="top-divider" />
        <button type="button" className="top-nav-item" onClick={() => navigate("/")}>
          画布库
        </button>
        <button
          type="button"
          className="top-nav-item"
          onClick={() => navigate(`/assets?canvasId=${encodeURIComponent(canvasId)}`)}
        >
          素材库
        </button>
        <button
          type="button"
          className="top-nav-item"
          onClick={() => navigate(`/settings/agent?canvasId=${encodeURIComponent(canvasId)}`)}
        >
          设置
        </button>
        <span className="top-divider" />

        {editingTitle ? (
          <input
            autoFocus
            className="canvas-title-input"
            value={titleInput}
            onChange={(e) => setTitleInput(e.target.value)}
            onBlur={handleFinishRename}
            onKeyDown={(e) => e.key === "Enter" && handleFinishRename()}
          />
        ) : (
          <button
            type="button"
            className="canvas-title-btn"
            title="点击重命名画布"
            onClick={() => {
              setTitleInput(canvasName);
              setEditingTitle(true);
            }}
          >
            {canvasName}
          </button>
        )}

        <span className="sync-chip">
          <span className={`sync-dot ${syncState === "dirty" || syncState === "saving" ? "dirty" : ""}`} />
          <span>
            {syncState === "saving"
              ? "同步中..."
              : syncState === "dirty"
                ? `待同步 · v${revision}`
                : syncState === "error"
                  ? "同步异常"
                  : `已同步 · v${revision}`}
          </span>
        </span>
        <span className="top-divider" />

        <div style={{ display: "inline-flex", alignItems: "center", gap: 2, fontSize: 12, color: "var(--text-secondary)" }}>
          <button
            type="button"
            className="fc-icon-btn"
            style={{ width: 26, height: 26 }}
            onClick={() =>
              setViewport((v) => ({ ...v, scale: Math.max(0.25, v.scale - 0.1) }))
            }
          >
            -
          </button>
          <button
            type="button"
            onClick={() => fitView(doc.items, stageSize.width, stageSize.height)}
            title="点击自适应全画布比例"
            style={{ minWidth: 42, fontWeight: 550 }}
          >
            {zoomPercent}%
          </button>
          <button
            type="button"
            className="fc-icon-btn"
            style={{ width: 26, height: 26 }}
            onClick={() =>
              setViewport((v) => ({ ...v, scale: Math.min(2.5, v.scale + 0.1) }))
            }
          >
            +
          </button>
        </div>

        <button type="button" className="fc-btn fc-btn-sm" onClick={handleOpenHistory}>
          版本
        </button>

        <div className="export-wrap">
          <button
            type="button"
            className="fc-btn fc-btn-sm"
            onClick={() => setExportMenuOpen((o) => !o)}
          >
            导出 ▾
          </button>
          {exportMenuOpen && (
            <div className="export-menu">
              <button
                type="button"
                className="export-opt"
                onClick={() => {
                  setExportMenuOpen(false);
                  if (!stageRef.current || !contentLayerRef.current) return;
                  try {
                    const dim = exportKonvaCanvasPng(
                      stageRef.current,
                      contentLayerRef.current,
                      doc.items,
                      canvasName,
                    );
                    notify(`已导出整张画布 2x PNG（${dim.width}×${dim.height}）`);
                  } catch (err) {
                    notify(err instanceof Error ? err.message : "导出失败");
                  }
                }}
              >
                <span>导出整张画布 (PNG)</span>
                <span style={{ color: "var(--text-muted)", fontSize: 11 }}>2x</span>
              </button>
              <button
                type="button"
                className="export-opt"
                onClick={() => {
                  setExportMenuOpen(false);
                  const chosen = doc.items.find(
                    (i) => selectedIds.includes(i.id) && i.type === "image",
                  );
                  if (!chosen) {
                    notify("请先选中一张画布图片再导出单图");
                    return;
                  }
                  exportSelectedAsset(chosen);
                  notify(`已导出选中图片「${chosen.title}」`);
                }}
              >
                <span>导出当前选中图</span>
                <span style={{ color: "var(--text-muted)", fontSize: 11 }}>原图</span>
              </button>
            </div>
          )}
        </div>

        <button
          type="button"
          className="fc-btn fc-btn-sm fc-btn-obsidian"
          onClick={() => setRightOpen((o) => !o)}
        >
          <SparkleIcon />
          <span>AI Agent</span>
        </button>
      </header>

      {/* Independent Top-Right Compact Account Pill */}
      <div className="top-right-account">
        <button
          type="button"
          className="avatar-pill"
          onClick={() => navigate("/account")}
        >
          <span className="avatar-dot">
            {user ? user.username.slice(0, 1).toUpperCase() : "F"}
          </span>
          <span>{user?.username ?? "账号"}</span>
        </button>
      </div>

      {/* Left Tool Rail + Contextual Text/Brush Subbar */}
      <LeftToolRail
        leftOpen={leftOpen}
        onToggleLeft={() => setLeftOpen((o) => !o)}
        tool={tool}
        onSelectTool={setTool}
        canUndo={undoStack.length > 0}
        canRedo={redoStack.length > 0}
        onUndo={handleUndo}
        onRedo={handleRedo}
        selectedCount={selectedIds.length}
        onAlignSelected={handleAlignSelected}
        onTriggerUpload={() => uploadInputRef.current?.click()}
        onDeleteSelected={handleDeleteSelected}
        textFont={textFont}
        onChangeTextFont={setTextFont}
        textSize={textSize}
        onChangeTextSize={setTextSize}
        brushWidth={brushWidth}
        onChangeBrushWidth={setBrushWidth}
        strokeColor={strokeColor}
        onChangeStrokeColor={setStrokeColor}
      />

      {/* Left Layers & Quick Asset Drawer */}
      <LeftLayersDrawer
        open={leftOpen}
        onClose={() => setLeftOpen(false)}
        items={doc.items}
        selectedIds={selectedIds}
        onSelectItem={(item) => {
          setSelectedIds([item.id]);
          setViewport((v) => ({
            ...v,
            x: stageSize.width / 2 - (item.x + item.width / 2) * v.scale,
            y: stageSize.height * 0.45 - (item.y + item.height / 2) * v.scale,
          }));
          if (item.type === "image" && item.asset_id) {
            const aid = item.asset_id;
            setRefAssetIds((prev) => (prev.includes(aid) ? prev : [...prev, aid]));
          }
        }}
        onToggleVisibility={(id) => {
          commitDoc((prev) => ({
            ...prev,
            items: prev.items.map((it) =>
              it.id === id ? { ...it, visible: it.visible === false } : it,
            ),
          }));
        }}
        assets={assets}
        onInsertAsset={(asset) => {
          const centerX = Math.round((stageSize.width / 2 - viewport.x) / viewport.scale);
          const centerY = Math.round((stageSize.height / 2 - viewport.y) / viewport.scale);
          const item: CanvasItem = {
            id: `asset-${Date.now()}`,
            type: "image",
            x: centerX - 100,
            y: centerY - 80,
            width: 210,
            height: Math.max(120, Math.round((210 * asset.height) / Math.max(1, asset.width))),
            title: asset.name,
            asset_id: asset.id,
            src: asset.src,
            visible: true,
          };
          commitDoc((prev) => ({ ...prev, items: [...prev.items, item] }));
          setSelectedIds([item.id]);
          setRefAssetIds((prev) => (prev.includes(asset.id) ? prev : [...prev, asset.id]));
        }}
        onTriggerUpload={() => uploadInputRef.current?.click()}
        onOpenFullAssets={() => navigate(`/assets?canvasId=${encodeURIComponent(canvasId)}`)}
      />

      {/* Right AI Agent Drawer (Harness Memory + Real SSE Thinking + Tool Calls + Revert) */}
      <RightAgentDrawer
        open={rightOpen}
        onClose={() => setRightOpen(false)}
        run={agentRun}
        pastRuns={pastRuns}
        memory={canvasMemory}
        thinkingSteps={thinkingSteps}
        toolCalls={toolCalls}
        streaming={sseActive}
        applying={applying}
        onSelectRun={(picked) => {
          setAgentRun(picked);
          setThinkingSteps([]);
          setToolCalls(
            (picked.proposal?.operations || []).map((op, idx) => ({
              id: `pick-${picked.id}-${idx}`,
              tool: op.tool,
              label: op.tool,
              params: op.params,
              status: picked.proposal?.applied
                ? "applied"
                : op.result?.asset_id
                  ? "created"
                  : "pending",
              result: op.result,
            })),
          );
        }}
        onClearMemory={async () => {
          try {
            setCanvasMemory(await api.clearCanvasMemory(canvasId));
            notify("已清空本画布的 Harness 对话与压缩记忆");
          } catch {
            notify("清空记忆失败");
          }
        }}
        onApplyProposal={handleApplyAgentProposal}
        onRevertProposal={handleRevertAgentProposal}
        onRejectProposal={async () => {
          if (!agentRun) return;
          const res = await api.rejectProposal(agentRun.id);
          setAgentRun(res);
          setCanvasMemory(await api.getCanvasMemory(canvasId).catch(() => null));
          notify("已忽略该提案并记录至避坑记忆");
        }}
        onCancelRun={async () => {
          if (!agentRun) return;
          const res = await api.cancelAgentRun(agentRun.id);
          setAgentRun(res);
          setSseActive(false);
        }}
        onRetryRun={async () => {
          if (!agentRun) return;
          setThinkingSteps([]);
          setToolCalls([]);
          const res = await api.retryAgentRun(agentRun.id);
          setAgentRun(res);
          startRunSse(res.id);
        }}
        onConfigureModel={() => navigate(`/settings/agent?canvasId=${encodeURIComponent(canvasId)}`)}
      />

      {/* Bottom-Right Collapsible Minimap */}
      <CanvasMinimap
        items={doc.items}
        viewport={viewport}
        stageWidth={stageSize.width}
        stageHeight={stageSize.height}
        onPanToWorldPoint={(wx, wy) =>
          setViewport((v) => ({
            ...v,
            x: stageSize.width / 2 - wx * v.scale,
            y: stageSize.height / 2 - wy * v.scale,
          }))
        }
      />

      {/* Bottom Floating Generation / AI Agent Dock */}
      <div className="bottom-dock-wrap">
        <div className="bottom-dock">
          {paramsOpen && (
            <DynamicImageParams
              refCount={refAssetIds.length}
              value={genParams}
              onChange={setGenParams}
              onClose={() => setParamsOpen(false)}
              configuredModelLabel={
                imageConfig?.configured ? `${imageConfig.provider}/${imageConfig.model_name}` : undefined
              }
            />
          )}

          {refChipItems.length > 0 && (
            <div className="ref-strip">
              {refChipItems.map((chip, idx) => {
                const aid = "asset_id" in chip ? chip.asset_id! : chip.id;
                const title = "name" in chip ? chip.name : chip.title;
                return (
                  <span key={`${aid}-${idx}`} className="ref-chip">
                    {chip.src && <img src={chip.src} alt="" />}
                    <span className="ref-idx">图{idx + 1}</span>
                    <span>{title}</span>
                    <button
                      type="button"
                      onClick={() => setRefAssetIds((prev) => prev.filter((id) => id !== aid))}
                      style={{ color: "var(--text-muted)" }}
                    >
                      ×
                    </button>
                  </span>
                );
              })}
              <button
                type="button"
                className="clear-refs-btn"
                onClick={() => setRefAssetIds([])}
              >
                清空参考
              </button>
            </div>
          )}

          <textarea
            className="prompt-input"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleSubmitBottomDock();
              }
            }}
            placeholder={
              dockMode === "image"
                ? "描述你想生成的画面（点选画布图片静默引用为 图1 / 图2），支持回车直出生图..."
                : "给 AI Agent 下达画布创作与生图协作指令..."
            }
          />

          <div className="dock-bottom">
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <div className="mode-toggle">
                <button
                  type="button"
                  className={`mode-pill ${dockMode === "image" ? "active" : ""}`}
                  onClick={() => setDockMode("image")}
                >
                  <ImageIcon />
                  <span>直接生图 / 改图</span>
                </button>
                <button
                  type="button"
                  className={`mode-pill ${dockMode === "agent" ? "active" : ""}`}
                  onClick={() => setDockMode("agent")}
                >
                  <SparkleIcon />
                  <span>AI Agent</span>
                </button>
              </div>

              {dockMode === "image" && (
                <button
                  type="button"
                  className="param-btn"
                  onClick={() => setParamsOpen((p) => !p)}
                >
                  <SlidersIcon />
                  <span>{summarizeGenerationRule(refAssetIds.length, genParams)}</span>
                </button>
              )}
            </div>

            <button
              type="button"
              className="send-circle"
              disabled={submitting}
              title={dockMode === "image" ? "生成图片" : "提交给 AI Agent"}
              onClick={handleSubmitBottomDock}
            >
              <SendUpIcon />
            </button>
          </div>
        </div>
      </div>

      {/* Bounded Version History Modal */}
      {historyOpen && (
        <div
          className="fc-modal-backdrop"
          onClick={(e) => e.target === e.currentTarget && setHistoryOpen(false)}
        >
          <div className="fc-modal-box">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong>云端关键版本快照（最多保留 12 条）</strong>
              <button
                type="button"
                className="fc-btn fc-btn-sm"
                onClick={async () => {
                  try {
                    const saved = await api.saveCanvas(
                      canvasId,
                      loadedRevisionRef.current,
                      doc,
                      viewport,
                    );
                    loadedRevisionRef.current = saved.revision;
                    setRevision(saved.revision);
                    dirtyRef.current = false;
                    setSyncState("synced");
                    await api.createCanvasCheckpoint(canvasId);
                    setVersions(await api.listCanvasVersions(canvasId, 12));
                    notify(`已留档当前快照 Revision #${saved.revision}`);
                  } catch {
                    notify("手动留档失败");
                  }
                }}
              >
                + 手动留档当前
              </button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: "52vh", overflowY: "auto" }}>
              {versions.map((ver) => (
                <div
                  key={ver.revision}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: "1px solid var(--border-hairline)",
                    background: ver.is_current ? "var(--surface-muted)" : "#fff",
                  }}
                >
                  <div>
                    <strong style={{ fontSize: 12.5, display: "block" }}>
                      Revision #{ver.revision} {ver.is_current ? "· 当前版本" : ""}
                    </strong>
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      {ver.object_count} 个对象 · {new Date(ver.created_at).toLocaleString()}
                    </span>
                  </div>
                  {!ver.is_current && (
                    <button
                      type="button"
                      className="fc-btn fc-btn-sm fc-btn-obsidian"
                      onClick={() => handleRestoreVersion(ver.revision)}
                    >
                      恢复此版本
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {toast && <div className="fc-toast">{toast}</div>}
    </div>
  );
}
