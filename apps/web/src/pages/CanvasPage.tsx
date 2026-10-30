import Konva from "konva";
import {
  ArrowRight, Check, CircleHelp, Cloud, Copy,
  Eye, EyeOff, Hand, ImagePlus, Leaf, Maximize2, Minimize2, MousePointer2, MoreHorizontal, Palette, Redo2,
  Settings2, Sparkles, Square, Undo2, Upload, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, FormEvent, RefObject, SetStateAction } from "react";
import { Image as KonvaImage, Arrow as KonvaArrow, Group, Layer, Line, Rect, Stage, Text, Transformer } from "react-konva";
import type { KonvaEventObject } from "konva/lib/Node";
import { Link, useParams } from "react-router";
import { saveAssetToLibrary } from "../lib/asset-store";
import { sampleAssets, type SampleAsset } from "../lib/samples";

type CanvasItem = {
  id: string;
  type: "image" | "note" | "swatch" | "shape" | "connector" | "brush";
  x: number;
  y: number;
  width: number;
  height: number;
  src?: string;
  title: string;
  content?: string;
  color?: string;
  points?: number[];
  visible?: boolean;
};

type CanvasDraft = {
  items: CanvasItem[];
  undoStack: CanvasItem[][];
  redoStack: CanvasItem[][];
};

type AgentGoalRequest = { id: string; prompt: string };

type ImageGenerationSettings = {
  quality: string;
  width: number;
  height: number;
  alignTo16: boolean;
  resolution: string;
  ratio: string;
  transparent: boolean;
  count: number;
};

const qualityOptions = ["自动", "低", "中", "高", "极高", "最高"];
const resolutionOptions = ["1K", "2K", "4K", "自动"];
const aspectRatioOptions = ["1:1", "2:3", "3:2", "4:3", "3:4", "16:9", "9:16", "21:9", "9:21", "自动"];

const canvasDrafts = new Map<string, CanvasDraft>();
const objectPaletteColors = ["#dce6aa", "#b9e98f", "#f2ddd0", "#bdd5de", "#d8c9e9", "#f0eee5", "#d6d8d0"];
const initialItems: CanvasItem[] = [
  { id: "main", type: "image", x: -280, y: -205, width: 305, height: 260, src: "/assets/bloom.svg", title: "主视觉图 01" },
  { id: "citrus", type: "image", x: 110, y: -145, width: 195, height: 145, src: "/assets/citrus.svg", title: "柑橘参考图" },
  { id: "skin", type: "image", x: 65, y: 82, width: 235, height: 170, src: "/assets/skincare.svg", title: "护肤品参考图" },
  { id: "note", type: "note", x: -265, y: 130, width: 175, height: 112, title: "主视觉方向" },
  { id: "swatches", type: "swatch", x: 355, y: -104, width: 48, height: 158, title: "色彩参考" },
];

function readCanvasDraft(canvasId: string): CanvasDraft {
  return canvasDrafts.get(canvasId) ?? { items: initialItems, undoStack: [], redoStack: [] };
}

function writeCanvasDraft(canvasId: string, draft: CanvasDraft) {
  canvasDrafts.set(canvasId, draft);
}

const toolOptions = [
  { id: "select", label: "选择", icon: MousePointer2 },
  { id: "hand", label: "平移画布", icon: Hand },
] as const;

type ToolId = (typeof toolOptions)[number]["id"] | "text" | "image" | "shape" | "connector" | "brush";

function useViewportSize(ref: RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState({ width: 900, height: 700 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

function BoardObject({ item, selected, draggable, onSelect, onChange, register }: {
  item: CanvasItem;
  selected: boolean;
  draggable: boolean;
  onSelect: (id: string) => void;
  onChange: (id: string, update: Partial<CanvasItem>) => void;
  register: (id: string, node: Konva.Group | null) => void;
}) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  useEffect(() => {
    if (item.type !== "image" || !item.src) return;
    const source = new window.Image();
    source.onload = () => setImage(source);
    source.src = item.src;
  }, [item.src, item.type]);

  return (
    <>
    <Group
      ref={(node) => register(item.id, node)}
      x={item.x}
      y={item.y}
      width={item.width}
      height={item.height}
      draggable={draggable}
      onClick={(event) => { event.cancelBubble = true; onSelect(item.id); }}
      onTap={(event) => { event.cancelBubble = true; onSelect(item.id); }}
      onDragStart={() => onSelect(item.id)}
      onDragMove={(event) => setDragOffset({ x: event.target.x() - item.x, y: event.target.y() - item.y })}
      onDragEnd={(event) => { onChange(item.id, { x: event.target.x(), y: event.target.y() }); setDragOffset({ x: 0, y: 0 }); }}
      visible={item.visible !== false}
    >
      {item.type === "image" && <>
        <Rect width={item.width} height={item.height} fill="#141916" cornerRadius={2} shadowColor="#000" shadowBlur={selected ? 0 : 17} shadowOpacity={0.35} shadowOffsetY={8} />
        {image && <KonvaImage image={image} width={item.width} height={item.height} cornerRadius={2} />}
        <Rect width={item.width} height={item.height} stroke="#ffffff20" strokeWidth={1} cornerRadius={2} />
      </>}
      {item.type === "note" && <>
        <Rect width={item.width} height={item.height} fill={item.color ?? "#dce6aa"} stroke="#f4f3df" strokeWidth={1} shadowColor="#000" shadowBlur={13} shadowOpacity={0.25} shadowOffsetY={7} />
        <Text x={15} y={14} text={item.title} fontSize={16} fill="#384738" fontFamily="Georgia, serif" />
        <Text x={15} y={43} text={item.content ?? "· 自然生长感\n· 清新但有质感\n· 柔和的晨光"} fontSize={12} lineHeight={1.55} fill="#40513f" fontFamily="Arial, sans-serif" />
      </>}
      {item.type === "swatch" && <>
        {(["#738a64", "#d9c98d", "#eee8d7", "#8199a0"] as const).map((color, index) => <Rect key={color} y={index * 38} width={item.width} height={30} cornerRadius={3} fill={color} stroke="#ffffff26" strokeWidth={1} />)}
        <Text y={item.height + 8} text="色彩参考" fontSize={11} fill="#c9cec8" />
      </>}
      {item.type === "shape" && <>
        <Rect width={item.width} height={item.height} fill={`${item.color ?? "#b9e98f"}20`} stroke={item.color ?? "#b9e98f"} strokeWidth={1} cornerRadius={8} />
        <Text x={12} y={12} text={item.title} fontSize={12} fill="#e6e9e4" />
      </>}
      {item.type === "connector" && <KonvaArrow points={[0, 0, item.width, item.height]} pointerLength={9} pointerWidth={9} fill={item.color ?? "#d6d8d0"} stroke={item.color ?? "#d6d8d0"} strokeWidth={2} />}
      {item.type === "brush" && <Line points={item.points ?? [0, 0, item.width, item.height]} stroke={item.color ?? "#dce6aa"} strokeWidth={4} lineCap="round" lineJoin="round" />}
    </Group>
    {item.type === "image" && item.visible !== false && <Group x={item.x + dragOffset.x} y={item.y + dragOffset.y + item.height + 7} listening={false}>
      <Rect width={item.width} height={28} fill="#111512" cornerRadius={3} />
      <Text x={10} y={7} text={item.title} fontSize={12} fill="#e6e9e4" fontFamily="Arial, sans-serif" />
      <Text x={item.width - 66} y={7} text={`${Math.round(item.width * 3.1)} × ${Math.round(item.height * 3.1)}`} fontSize={10} fill="#929a93" fontFamily="Arial, sans-serif" />
    </Group>}
    </>
  );
}

function CanvasStage({ items, setItems, tool, setTool, selectedIds, setSelectedIds, zoom, setZoom, brushColor, onCreate }: {
  items: CanvasItem[];
  setItems: Dispatch<SetStateAction<CanvasItem[]>>;
  tool: ToolId;
  setTool: (tool: ToolId) => void;
  selectedIds: string[];
  setSelectedIds: (ids: string[]) => void;
  zoom: number;
  setZoom: (zoom: number) => void;
  brushColor: string;
  onCreate: (item: CanvasItem) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const layerRef = useRef<Konva.Layer>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const nodesRef = useRef<Record<string, Konva.Group | null>>({});
  const size = useViewportSize(containerRef);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [spaceDown, setSpaceDown] = useState(false);
  const [brushPoints, setBrushPoints] = useState<number[] | null>(null);
  const [marquee, setMarquee] = useState<{ x: number; y: number; width: number; height: number; startX: number; startY: number } | null>(null);

  useEffect(() => {
    setPosition({ x: size.width / 2 + (size.width < 740 ? 65 : 0), y: size.height / 2 });
  }, [size.width, size.height]);

  useEffect(() => {
    const transformer = transformerRef.current;
    if (!transformer) return;
    transformer.nodes(selectedIds.map((id) => nodesRef.current[id]).filter((node): node is Konva.Group => Boolean(node)));
    transformer.getLayer()?.batchDraw();
  }, [selectedIds, items]);

  useEffect(() => {
    const down = (event: KeyboardEvent) => { if (event.code === "Space" && !["INPUT", "TEXTAREA"].includes((event.target as HTMLElement)?.tagName)) { event.preventDefault(); setSpaceDown(true); } };
    const up = (event: KeyboardEvent) => { if (event.code === "Space") setSpaceDown(false); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  const register = useCallback((id: string, node: Konva.Group | null) => { nodesRef.current[id] = node; }, []);
  const updateItem = useCallback((id: string, update: Partial<CanvasItem>) => {
    setItems((current) => current.map((item) => item.id === id ? { ...item, ...update } : item));
  }, [setItems]);

  function handleWheel(event: KonvaEventObject<WheelEvent>) {
    event.evt.preventDefault();
    const stage = stageRef.current;
    const pointer = stage?.getPointerPosition();
    if (!pointer) return;
    const oldScale = zoom;
    const direction = event.evt.deltaY > 0 ? -1 : 1;
    const nextScale = Math.min(1.85, Math.max(0.3, oldScale * (direction > 0 ? 1.08 : 0.92)));
    const mousePoint = { x: (pointer.x - position.x) / oldScale, y: (pointer.y - position.y) / oldScale };
    setZoom(nextScale);
    setPosition({ x: pointer.x - mousePoint.x * nextScale, y: pointer.y - mousePoint.y * nextScale });
  }

  const gridSize = 24 * zoom;
  const stageDraggable = tool === "hand" || spaceDown;
  return (
    <div
      ref={containerRef}
      className={`canvas-stage-host ${stageDraggable ? "canvas-is-panning" : ""} ${tool === "text" ? "canvas-is-placing-text" : ""}`}
      style={{ backgroundSize: `${gridSize}px ${gridSize}px`, backgroundPosition: `${position.x % gridSize}px ${position.y % gridSize}px` }}
    >
      <Stage
        ref={stageRef}
        width={size.width}
        height={size.height}
        x={position.x}
        y={position.y}
        scaleX={zoom}
        scaleY={zoom}
        draggable={stageDraggable}
        onDragEnd={(event) => { if (event.target === stageRef.current) setPosition({ x: event.target.x(), y: event.target.y() }); }}
        onWheel={handleWheel}
        onMouseDown={(event) => {
          if (event.target !== event.target.getStage()) return;
          const pointer = stageRef.current?.getPointerPosition();
          if (!pointer) return;
          if (spaceDown || tool === "hand") return;
          if (tool === "brush") {
            const x = (pointer.x - position.x) / zoom;
            const y = (pointer.y - position.y) / zoom;
            setSelectedIds([]);
            setBrushPoints([x, y]);
          } else if (tool === "select") {
            setSelectedIds([]);
            const x = (pointer.x - position.x) / zoom;
            const y = (pointer.y - position.y) / zoom;
            setMarquee({ x, y, width: 0, height: 0, startX: x, startY: y });
          }
        }}
        onMouseMove={() => {
          if (spaceDown || tool === "hand") {
            if (brushPoints) setBrushPoints(null);
            if (marquee) setMarquee(null);
            return;
          }
          if (marquee) {
            const pointer = stageRef.current?.getPointerPosition();
            if (!pointer) return;
            const x = (pointer.x - position.x) / zoom;
            const y = (pointer.y - position.y) / zoom;
            setMarquee((current) => current ? { ...current, x: Math.min(current.startX, x), y: Math.min(current.startY, y), width: Math.abs(x - current.startX), height: Math.abs(y - current.startY) } : current);
          }
          if (!brushPoints) return;
          const pointer = stageRef.current?.getPointerPosition();
          if (!pointer) return;
          setBrushPoints((current) => current ? [...current, (pointer.x - position.x) / zoom, (pointer.y - position.y) / zoom] : current);
        }}
        onMouseUp={() => {
          if (spaceDown || tool === "hand") {
            setBrushPoints(null);
            setMarquee(null);
            return;
          }
          if (marquee) {
            const x1 = marquee.x, y1 = marquee.y, x2 = marquee.x + marquee.width, y2 = marquee.y + marquee.height;
            const hits = items.filter((item) => item.visible !== false && item.x <= x2 && item.x + item.width >= x1 && item.y <= y2 && item.y + item.height >= y1).map((item) => item.id);
            setSelectedIds(hits);
            setMarquee(null);
          }
          if (!brushPoints || brushPoints.length < 4) { setBrushPoints(null); return; }
          const xs = brushPoints.filter((_, index) => index % 2 === 0);
          const ys = brushPoints.filter((_, index) => index % 2 === 1);
          const left = Math.min(...xs), top = Math.min(...ys);
          const points = brushPoints.map((value, index) => value - (index % 2 === 0 ? left : top));
          const id = crypto.randomUUID();
          onCreate({ id, type: "brush", x: left, y: top, width: Math.max(1, Math.max(...xs) - left), height: Math.max(1, Math.max(...ys) - top), points, color: brushColor, title: "画笔" });
          setSelectedIds([id]);
          setBrushPoints(null);
        }}
        onTouchStart={(event) => { if (event.target === event.target.getStage()) setSelectedIds([]); }}
        onClick={(event) => {
          if (event.target !== event.target.getStage() || tool === "select" || tool === "hand" || tool === "image" || tool === "brush") return;
          const pointer = stageRef.current?.getPointerPosition();
          if (!pointer) return;
          const x = (pointer.x - position.x) / zoom;
          const y = (pointer.y - position.y) / zoom;
          const id = crypto.randomUUID();
          const item: CanvasItem = tool === "text"
            ? { id, type: "note", x, y, width: 190, height: 126, title: "新建文本框", content: "" }
            : tool === "shape"
              ? { id, type: "shape", x, y, width: 150, height: 94, title: "新建区域" }
              : { id, type: "connector", x, y, width: 130, height: 65, title: "连接线" };
          onCreate(item);
          setSelectedIds([id]);
          if (tool === "text") setTool("select");
        }}
      >
        <Layer ref={layerRef}>
          <Rect x={-6000} y={-6000} width={12000} height={12000} fill="transparent" listening={false} />
          <KonvaArrow points={[-235, 82, -75, 22]} pointerLength={9} pointerWidth={9} fill="#d6d8d0" stroke="#d6d8d0" strokeWidth={1.3} tension={0.42} listening={false} />
          <KonvaArrow points={[280, 31, 365, 89]} pointerLength={8} pointerWidth={8} fill="#d6d8d0" stroke="#d6d8d0" strokeWidth={1.1} tension={0.35} listening={false} />
          <Text x={-250} y={-238} text="春日自然感" fontSize={21} fill="#eae8d9" fontFamily="Georgia, serif" listening={false} />
          <Text x={-250} y={-210} text="清透 · 植物 · 柔光" fontSize={11} fill="#aab0a5" letterSpacing={1.2} listening={false} />
          <Text x={-90} y={-120} text="色彩参考" fontSize={11} fill="#d6d9d2" listening={false} />
          {items.map((item) => <BoardObject key={item.id} item={item} selected={selectedIds.includes(item.id)} draggable={tool === "select" && !spaceDown} onSelect={(id) => setSelectedIds([id])} onChange={updateItem} register={register} />)}
          {brushPoints && <Line points={brushPoints} stroke={brushColor} strokeWidth={4} lineCap="round" lineJoin="round" listening={false} />}
          {marquee && <Rect x={marquee.x} y={marquee.y} width={marquee.width} height={marquee.height} fill="#b9e98f18" stroke="#b9e98f" strokeWidth={1} dash={[5, 4]} listening={false} />}
          <Transformer
            ref={transformerRef}
            rotateEnabled={false}
            keepRatio={false}
            anchorSize={7}
            anchorFill="#f5f7fb"
            anchorStroke="#4d8dff"
            anchorStrokeWidth={1}
            anchorCornerRadius={4}
            borderStroke="#4d8dff"
            borderStrokeWidth={1}
            onTransformEnd={() => {
              if (!selectedIds.length) return;
              const updates = selectedIds.flatMap((id) => {
                const node = nodesRef.current[id];
                if (!node) return [];
                const scaleX = node.scaleX(), scaleY = node.scaleY();
                node.scaleX(1); node.scaleY(1);
                const item = items.find((entry) => entry.id === id);
                const points = item?.type === "brush" ? item.points?.map((value, index) => value * (index % 2 === 0 ? scaleX : scaleY)) : item?.points;
                return [{ id, x: node.x(), y: node.y(), width: Math.max(item?.type === "brush" ? 1 : 40, node.width() * scaleX), height: Math.max(item?.type === "brush" ? 1 : 35, node.height() * scaleY), points }];
              });
              if (updates.length) setItems((current) => current.map((item) => { const update = updates.find((entry) => entry.id === item.id); return update ? { ...item, ...update } : item; }));
            }}
          />
        </Layer>
      </Stage>
      <div className="canvas-zoom-pill"><button onClick={() => setZoom(Math.max(0.3, zoom - 0.1))} aria-label="缩小">−</button><span>{Math.round(zoom * 100)}%</span><button onClick={() => setZoom(Math.min(1.8, zoom + 0.1))} aria-label="放大">+</button></div>
    </div>
  );
}

function AgentPanel({ open, compact, onToggleCompact, onClose, onApplyProposal, onSaveAsset, references, onRemoveReference, onClearReferences, proposalHistorySignal, submittedGoal }: {
  open: boolean;
  compact: boolean;
  onToggleCompact: () => void;
  onClose: () => void;
  onApplyProposal: (proposalId: string) => void;
  onSaveAsset: (asset: SampleAsset) => void;
  references: SampleAsset[];
  onRemoveReference: (id: string) => void;
  onClearReferences: () => void;
  proposalHistorySignal: { action: "undo" | "redo"; proposalId: string | null; revision: number };
  submittedGoal: AgentGoalRequest | null;
}) {
  const [sent, setSent] = useState("");
  const [showMenu, setShowMenu] = useState(false);
  const [proposalImageSaved, setProposalImageSaved] = useState(false);
  const [proposalReady, setProposalReady] = useState(false);
  const [proposalId, setProposalId] = useState<string>(() => crypto.randomUUID());
  const [review, setReview] = useState<"pending" | "applied" | "rejected">("pending");
  const [proposalApplied, setProposalApplied] = useState(false);
  const hasConversation = Boolean(sent.trim());

  useEffect(() => {
    if (!proposalHistorySignal.revision || proposalHistorySignal.proposalId !== proposalId) return;
    setReview(proposalHistorySignal.action === "undo" ? "pending" : "applied");
    setProposalApplied(proposalHistorySignal.action === "redo");
  }, [proposalHistorySignal, proposalId]);

  useEffect(() => {
    if (!submittedGoal) return;
    setSent(submittedGoal.prompt);
    setReview("pending");
    setProposalApplied(false);
    setProposalImageSaved(false);
    setProposalId(crypto.randomUUID());
    setProposalReady(true);
  }, [submittedGoal?.id]);

  function clearConversation() {
    setSent("");
    onClearReferences();
    setReview("pending");
    setProposalApplied(false);
    setProposalImageSaved(false);
    setProposalReady(false);
    setProposalId(crypto.randomUUID());
    setShowMenu(false);
  }

  return (
    <>
    <div className={`agent-panel-shell ${open ? "panel-open" : ""} ${compact ? "agent-panel-compact" : ""}`}>
    <aside className="editor-right-panel">
      {compact ? <div className="agent-compact-top"><span className="agent-logo"><Leaf size={16} /></span><button className="icon-button" aria-label="展开 Agent 面板" title="展开 Agent 面板" onClick={onToggleCompact}><Maximize2 size={16} /></button></div> : <>
      <div className="right-panel-top"><div className="agent-title"><span className="agent-logo"><Leaf size={16} /></span><strong>AI Agent</strong><span className="beta-tag">Beta</span></div><button className="icon-button" aria-label="缩小 Agent 面板" title="缩小 Agent 面板" onClick={onToggleCompact}><Minimize2 size={16} /></button><button className="icon-button" aria-label="Agent 设置" onClick={() => window.location.assign("/settings/agent")}><Settings2 size={17} /></button><button className="icon-button" aria-label="更多 Agent 操作" onClick={() => setShowMenu((open) => !open)}><MoreHorizontal size={17} /></button><button className="icon-button" aria-label="关闭面板" onClick={onClose}><X size={17} /></button>{showMenu && <div className="agent-header-menu"><button onClick={clearConversation}>清空本次对话</button></div>}</div>
      <div className="agent-scroll-content">
        {references.length > 0 && <section className="agent-selected-references" aria-label="已选参考图片"><div className="agent-selected-references-heading"><strong>已选图片</strong><span>{references.length}</span></div><div className="agent-selected-reference-list">{references.map((asset) => <div className="agent-selected-reference" key={asset.id}><img src={asset.src} alt={asset.name} /><span title={asset.name}>{asset.name}</span><button type="button" aria-label={`移除参考图片 ${asset.name}`} title="移除参考图片" onClick={() => onRemoveReference(asset.id)}><X size={12} /></button></div>)}</div></section>}
        {hasConversation && <div className="agent-thread">
          <div className="chat-bubble user-bubble">{sent}</div>
          <div className="chat-answer"><span className="agent-avatar"><Leaf size={14} /></span><div><strong>Coordinator 已理解你的需求</strong><p>我会结合当前画布和已选图片整理创作建议。这里展示的是前端交互演示，尚未调用真实生图或改图接口。</p></div></div>
        </div>}
        {!hasConversation && references.length === 0 && <p className="agent-empty-state">从画布点击图片即可加入参考。提交创作目标后，这里会展示 Agent 的执行过程和结果。</p>}
        {hasConversation && <section className="task-card"><div className="task-card-head"><span><Sparkles size={14} />执行计划</span><small>(3/3)</small></div><div className="task-list">
          <div className={`task-row ${hasConversation ? "task-done" : ""}`}><span className="task-state">{hasConversation ? <Check size={12} /> : "1"}</span><div><strong>解析画布内容</strong><small>{hasConversation ? "Coordinator · 提取风格、关键词和参考元素" : "等待创作目标"}</small></div></div>
          <div className={`task-row ${proposalReady ? "task-done" : hasConversation ? "task-running" : ""}`}><span className="task-state">{proposalReady ? <Check size={12} /> : hasConversation ? <i /> : "2"}</span><div><strong>生成视觉方案</strong><small>{proposalReady ? "Planner + Canvas Editor · 视觉方案已生成" : hasConversation ? "Planner + Canvas Editor · 正在生成主视觉和配色方案…" : "等待前序步骤完成"}</small></div></div>
          <div className={`task-row ${review === "applied" || review === "rejected" ? "task-done" : proposalReady ? "task-running" : ""}`}><span className="task-state">{review === "applied" || review === "rejected" ? <Check size={12} /> : proposalReady ? <i /> : "3"}</span><div><strong>输出结果</strong><small>{review === "applied" ? "Reviewer · 已接受并应用到画布" : review === "rejected" ? "Reviewer · 提案已拒绝" : proposalReady ? "Reviewer · 等待审阅画布修改" : "等待前序步骤完成"}</small></div></div>
        </div>{proposalReady && <><div className="temporary-output-card"><img src="/assets/bloom.svg" alt="交互演示图片预览" /><div><strong>交互演示预览</strong><small>{proposalImageSaved ? "已保存到资产" : "模拟结果 · 临时内容"}</small></div><button disabled={proposalImageSaved} onClick={() => { onSaveAsset({ id: `generated-${proposalId}`, name: `生成预览-${proposalId.slice(0, 6)}.svg`, src: "/assets/bloom.svg", dimensions: "1024 × 1024", recent: true }); setProposalImageSaved(true); }}>{proposalImageSaved ? "已保存" : "保存到资产"}</button></div><div className="agent-result-inline"><div><strong>画布提案</strong><span>{review === "pending" ? "新增便签「视觉层级建议」" : review === "applied" ? "提案已加入画布，可撤销" : "本次提案已拒绝"}</span></div>{review === "pending" ? <div className="agent-result-actions"><button onClick={() => setReview("rejected")}>拒绝</button><button className="accept" onClick={() => { if (!proposalApplied) { onApplyProposal(proposalId); setProposalApplied(true); } setReview("applied"); }}>应用</button></div> : review === "rejected" && <button className="agent-result-retry" onClick={() => setReview("pending")}>重新查看</button>}</div></>}</section>}
      </div>
      </>}
    </aside>
    </div>
    </>
  );
}

function ImageGenerationBar({ references, onRemoveReference, onSubmitPrompt, focusPromptRequest }: {
  references: SampleAsset[];
  onRemoveReference: (id: string) => void;
  onSubmitPrompt: (prompt: string) => void;
  focusPromptRequest: number;
}) {
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("gpt-image-2");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [settings, setSettings] = useState<ImageGenerationSettings>({
    quality: "自动", width: 1024, height: 1024, alignTo16: true, resolution: "自动", ratio: "1:1", transparent: false, count: 3,
  });
  const composerRef = useRef<HTMLFormElement>(null);
  const promptRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusPromptRequest > 0) promptRef.current?.focus();
  }, [focusPromptRequest]);

  useEffect(() => {
    if (!settingsOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Node && !composerRef.current?.contains(event.target)) setSettingsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [settingsOpen]);

  function updateDimension(key: "width" | "height", rawValue: string) {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) return;
    const bounded = Math.max(64, Math.min(4096, parsed));
    const value = settings.alignTo16 ? Math.max(64, Math.round(bounded / 16) * 16) : Math.round(bounded);
    setSettings((current) => ({ ...current, [key]: value }));
  }

  function toggleDimensionAlignment() {
    setSettings((current) => {
      const alignTo16 = !current.alignTo16;
      const align = (value: number) => alignTo16 ? Math.max(64, Math.round(value / 16) * 16) : value;
      return { ...current, alignTo16, width: align(current.width), height: align(current.height) };
    });
  }

  function chooseRatio(ratio: string) {
    setSettings((current) => {
      if (ratio === "自动") return { ...current, ratio };
      const [ratioWidth, ratioHeight] = ratio.split(":").map(Number);
      const longest = 1024;
      const width = ratioWidth >= ratioHeight ? longest : longest * ratioWidth / ratioHeight;
      const height = ratioHeight >= ratioWidth ? longest : longest * ratioHeight / ratioWidth;
      const align = (value: number) => current.alignTo16 ? Math.max(64, Math.round(value / 16) * 16) : Math.round(value);
      return { ...current, ratio, width: align(width), height: align(height) };
    });
  }

  function submitGeneration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!prompt.trim()) return;
    onSubmitPrompt(prompt.trim());
    setNotice(`已提交给 Agent · ${model} · ${settings.quality} · ${settings.width}×${settings.height} · ${settings.resolution} · ${settings.ratio} · ${settings.count} 张${references.length ? ` · ${references.length} 张参考图` : ""}${settings.transparent ? " · 透明背景" : ""}。当前仅展示本地流程，未调用生图服务。`);
    setPrompt("");
    setSettingsOpen(false);
  }

  const settingsSummary = `${settings.resolution} · ${settings.ratio} · ${settings.count} 张`;

  return (
    <form ref={composerRef} className="image-generation-dock" onSubmit={submitGeneration}>
      {notice && <div className="generation-notice" role="status"><span>{notice}</span><button type="button" aria-label="关闭提示" onClick={() => setNotice("")}><X size={13} /></button></div>}
      {settingsOpen && <section className="image-settings-popover" role="dialog" aria-label="图像设置">
        <div className="image-settings-header"><div><strong>图像设置</strong><small>调整本次生成参数</small></div><button type="button" aria-label="关闭图像设置" onClick={() => setSettingsOpen(false)}><X size={15} /></button></div>
        <div className="image-settings-group"><span className="image-settings-label">质量</span><div className="quality-options">{qualityOptions.map((quality) => <button type="button" key={quality} className={settings.quality === quality ? "selected" : ""} aria-pressed={settings.quality === quality} onClick={() => setSettings((current) => ({ ...current, quality }))}>{quality}</button>)}</div></div>
        <div className="image-settings-group"><div className="settings-label-row"><span className="image-settings-label">尺寸</span><button type="button" className={`settings-switch ${settings.alignTo16 ? "on" : ""}`} role="switch" aria-checked={settings.alignTo16} onClick={toggleDimensionAlignment}><span />16 倍数对齐</button></div><div className="dimension-fields"><label><span>W</span><input type="number" min={64} max={4096} step={settings.alignTo16 ? 16 : 1} value={settings.width} onChange={(event) => updateDimension("width", event.target.value)} /></label><span className="dimension-link">↔</span><label><span>H</span><input type="number" min={64} max={4096} step={settings.alignTo16 ? 16 : 1} value={settings.height} onChange={(event) => updateDimension("height", event.target.value)} /></label></div></div>
        <div className="image-settings-group"><span className="image-settings-label">分辨率</span><div className="resolution-options">{resolutionOptions.map((resolution) => <button type="button" key={resolution} className={settings.resolution === resolution ? "selected" : ""} aria-pressed={settings.resolution === resolution} onClick={() => setSettings((current) => ({ ...current, resolution }))}>{resolution}</button>)}</div></div>
        <div className="image-settings-group"><span className="image-settings-label">宽高比</span><div className="ratio-options">{aspectRatioOptions.map((ratio) => { const [ratioWidth, ratioHeight] = ratio === "自动" ? [1, 1] : ratio.split(":").map(Number); const previewWidth = ratio === "自动" ? 12 : Math.min(28, 22 * ratioWidth / ratioHeight); const previewHeight = ratio === "自动" ? 14 : Math.min(22, 28 * ratioHeight / ratioWidth); return <button type="button" key={ratio} className={settings.ratio === ratio ? "selected" : ""} aria-pressed={settings.ratio === ratio} onClick={() => chooseRatio(ratio)}><span className="ratio-preview">{ratio !== "自动" && <i style={{ width: `${previewWidth}px`, height: `${previewHeight}px` }} />}</span><span>{ratio}</span></button>; })}</div></div>
        <div className="image-settings-footer"><span className="image-settings-label">透明背景</span><button type="button" className={`settings-switch ${settings.transparent ? "on" : ""}`} role="switch" aria-checked={settings.transparent} onClick={() => setSettings((current) => ({ ...current, transparent: !current.transparent }))}><span />{settings.transparent ? "开启" : "关闭"}</button></div>
        <div className="image-settings-group"><span className="image-settings-label">生成张数</span><div className="count-options">{Array.from({ length: 10 }, (_, index) => index + 1).map((count) => <button type="button" key={count} className={settings.count === count ? "selected" : ""} aria-pressed={settings.count === count} onClick={() => setSettings((current) => ({ ...current, count }))}>{count}</button>)}</div></div>
      </section>}
      {references.length > 0 && <div className="generation-reference-list" aria-label="已选参考图片">{references.map((reference) => <button type="button" className="generation-reference-thumb" key={reference.id} aria-label={`移除参考图片 ${reference.name}`} title={`移除参考图片 ${reference.name}`} onClick={() => onRemoveReference(reference.id)}><img src={reference.src} alt="" /><X size={11} /></button>)}</div>}
      <input ref={promptRef} className="generation-prompt" type="text" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="描述你的创作目标或图片修改…" aria-label="Agent 创作目标输入" />
      <div className="generation-controls"><label className="generation-model"><span className="visually-hidden">生图模型</span><select value={model} onChange={(event) => setModel(event.target.value)}><option value="gpt-image-2">gpt-image-2</option><option value="flux-pro">Flux Pro</option><option value="imagen-4">Imagen 4</option></select><span aria-hidden="true">⌄</span></label><button type="button" className="generation-settings-trigger" aria-haspopup="dialog" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((open) => !open)}><Settings2 size={16} /><span>{settingsSummary}</span></button><button type="submit" className="generation-submit" aria-label="提交给 Agent" title="提交给 Agent" disabled={!prompt.trim()}><ArrowRight size={17} /></button></div>
    </form>
  );
}

export function CanvasPage() {
  const { canvasId = "spring-board" } = useParams();
  const [draft] = useState(() => readCanvasDraft(canvasId));
  const [items, setItems] = useState<CanvasItem[]>(draft.items);
  const itemsRef = useRef(items);
  const undoStack = useRef<CanvasItem[][]>(draft.undoStack);
  const redoStack = useRef<CanvasItem[][]>(draft.redoStack);
  const [tool, setTool] = useState<ToolId>("select");
  const [brushColor, setBrushColor] = useState("#dce6aa");
  const [selectedIds, setSelectedIds] = useState<string[]>(["main"]);
  const [objectPaletteOpen, setObjectPaletteOpen] = useState(false);
  const [zoom, setZoom] = useState(() => window.innerWidth < 740 ? 0.58 : 0.82);
  const [saved, setSaved] = useState(true);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentCompact, setAgentCompact] = useState(false);
  const [proposalHistorySignal, setProposalHistorySignal] = useState<{ action: "undo" | "redo"; proposalId: string | null; revision: number }>({ action: "undo", proposalId: null, revision: 0 });
  const agentProposalItemIdRef = useRef<string | null>(null);
  const [agentAssets, setAgentAssets] = useState<SampleAsset[]>([]);
  const [generationReferences, setGenerationReferences] = useState<SampleAsset[]>([]);
  const [generationFocusRequest, setGenerationFocusRequest] = useState(0);
  const [submittedGoal, setSubmittedGoal] = useState<AgentGoalRequest | null>(null);
  const imageImportInputRef = useRef<HTMLInputElement>(null);
  const agentAssetLibrary = useMemo(() => [...sampleAssets, ...agentAssets.filter((asset) => !sampleAssets.some((sample) => sample.id === asset.id))], [agentAssets]);
  const selectedChatItem = selectedIds.length === 1 ? items.find((item) => item.id === selectedIds[0] && ["image", "note"].includes(item.type)) : undefined;
  const title = canvasId === "spring-board" || canvasId === "spring" ? "春季灵感板" : "未命名画布";
  const currentTool = useMemo(() => toolOptions.find((item) => item.id === tool), [tool]);
  const canColorSelection = selectedIds.length > 0 && selectedIds.every((id) => {
    const selected = items.find((item) => item.id === id);
    return selected && ["note", "shape", "connector", "brush"].includes(selected.type);
  });
  itemsRef.current = items;

  const updateCanvasItems: Dispatch<SetStateAction<CanvasItem[]>> = (action) => {
    const previous = itemsRef.current;
    const next = typeof action === "function" ? action(previous) : action;
    if (next === previous) return;
    undoStack.current = [...undoStack.current, previous];
    redoStack.current = [];
    itemsRef.current = next;
    setItems(next);
    writeCanvasDraft(canvasId, { items: next, undoStack: undoStack.current, redoStack: redoStack.current });
    setSaved(false);
  };

  function undo() {
    const previous = undoStack.current.at(-1);
    if (!previous) return;
    const proposalId = agentProposalItemIdRef.current;
    if (proposalId && itemsRef.current.some((item) => item.id === proposalId) && !previous.some((item) => item.id === proposalId)) {
      setProposalHistorySignal((current) => ({ action: "undo", proposalId, revision: current.revision + 1 }));
    }
    undoStack.current = undoStack.current.slice(0, -1);
    redoStack.current = [...redoStack.current, itemsRef.current];
    itemsRef.current = previous;
    setItems(previous);
    writeCanvasDraft(canvasId, { items: previous, undoStack: undoStack.current, redoStack: redoStack.current });
    setSaved(false);
  }

  function redo() {
    const next = redoStack.current.at(-1);
    if (!next) return;
    const proposalId = agentProposalItemIdRef.current;
    if (proposalId && !itemsRef.current.some((item) => item.id === proposalId) && next.some((item) => item.id === proposalId)) {
      setProposalHistorySignal((current) => ({ action: "redo", proposalId, revision: current.revision + 1 }));
    }
    redoStack.current = redoStack.current.slice(0, -1);
    undoStack.current = [...undoStack.current, itemsRef.current];
    itemsRef.current = next;
    setItems(next);
    writeCanvasDraft(canvasId, { items: next, undoStack: undoStack.current, redoStack: redoStack.current });
    setSaved(false);
  }

  function addAssetToCanvas(asset: SampleAsset) {
    const item: CanvasItem = {
      id: crypto.randomUUID(), type: "image", x: -90 + (itemsRef.current.length % 4) * 28,
      y: 130 + (itemsRef.current.length % 4) * 24, width: 185, height: 145, src: asset.src, title: asset.name,
    };
    updateCanvasItems((current) => [...current, item]);
    selectCanvasItems([item.id]);
    setTool("select");
  }

  function saveAssetFromAgent(asset: SampleAsset) {
    saveAssetToLibrary(asset);
    setAgentAssets((current) => current.some((item) => item.id === asset.id) ? current : [asset, ...current]);
  }

  function submitAgentGoal(prompt: string) {
    setSubmittedGoal({ id: crypto.randomUUID(), prompt });
    setAgentOpen(true);
    setAgentCompact(false);
  }

  function removeGenerationReference(id: string) {
    setGenerationReferences((current) => current.filter((reference) => reference.id !== id));
  }

  function selectCanvasItems(ids: string[]) {
    setSelectedIds(ids);
    if (ids.length !== 1) return;
    const selectedItem = itemsRef.current.find((item) => item.id === ids[0]);
    if (selectedItem?.type !== "image" || !selectedItem.src) return;
    const savedAsset = agentAssetLibrary.find((asset) => asset.src === selectedItem.src);
    const reference: SampleAsset = savedAsset ?? {
      id: `canvas-image-${selectedItem.id}`,
      name: selectedItem.title,
      src: selectedItem.src,
      dimensions: "画布图片",
      recent: true,
    };
    setGenerationReferences((current) => current.some((item) => item.id === reference.id) || current.length >= 10 ? current : [...current, reference]);
    setGenerationFocusRequest((current) => current + 1);
  }

  async function importCanvasImages(files: File[]) {
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (!imageFiles.length) return;
    const firstIndex = itemsRef.current.length;
    const imported = await Promise.all(imageFiles.map((file, index) => new Promise<CanvasItem | null>((resolve) => {
      const src = URL.createObjectURL(file);
      const image = new window.Image();
      image.onload = () => {
        const naturalWidth = image.naturalWidth || 185;
        const naturalHeight = image.naturalHeight || 145;
        const scale = Math.min(1, 260 / naturalWidth, 210 / naturalHeight);
        resolve({
          id: crypto.randomUUID(), type: "image", x: 120 + ((firstIndex + index) % 3) * 30,
          y: 120 + ((firstIndex + index) % 3) * 28, width: Math.max(1, Math.round(naturalWidth * scale)),
          height: Math.max(1, Math.round(naturalHeight * scale)), src, title: file.name,
        });
      };
      image.onerror = () => {
        URL.revokeObjectURL(src);
        resolve(null);
      };
      image.src = src;
    })));
    const additions = imported.filter((item): item is CanvasItem => item !== null);
    if (!additions.length) return;
    updateCanvasItems((current) => [...current, ...additions]);
    setSelectedIds([additions[additions.length - 1].id]);
    setTool("select");
    const importedReferences = additions.map((item) => ({
      id: `canvas-image-${item.id}`, name: item.title, src: item.src ?? "",
      dimensions: `${item.width} × ${item.height}`, recent: true,
    }));
    setGenerationReferences((current) => [...current, ...importedReferences].slice(-10));
    setGenerationFocusRequest((current) => current + 1);
  }

  useEffect(() => {
    const raw = sessionStorage.getItem("flowcanvas.pending-assets");
    if (!raw) return;
    sessionStorage.removeItem("flowcanvas.pending-assets");
    try {
      const assets = JSON.parse(raw) as SampleAsset[];
      if (assets.length) assets.forEach(addAssetToCanvas);
    } catch {
      sessionStorage.removeItem("flowcanvas.pending-assets");
    }
  }, []);

  useEffect(() => {
    const raw = sessionStorage.getItem("flowcanvas.pending-agent-assets");
    if (!raw) return;
    sessionStorage.removeItem("flowcanvas.pending-agent-assets");
    try {
      const assets = JSON.parse(raw) as SampleAsset[];
      if (assets.length) {
        setAgentAssets(assets);
        setGenerationReferences((current) => [...current, ...assets].slice(-10));
        setAgentOpen(true);
      }
    } catch {
      sessionStorage.removeItem("flowcanvas.pending-agent-assets");
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.matches("input, textarea, [contenteditable='true']")) return;
      if ((event.key === "Delete" || event.key === "Backspace") && selectedIds.length) {
        event.preventDefault();
        updateCanvasItems((current) => current.filter((item) => !selectedIds.includes(item.id)));
        setSelectedIds([]);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedIds]);

  return (
    <div className="editor-page">
      <input
        ref={imageImportInputRef}
        className="visually-hidden"
        type="file"
        accept="image/*"
        multiple
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          void importCanvasImages(files);
        }}
      />
      <header className="editor-topbar">
        <div className="editor-brand-area"><Link className="editor-logo" to="/"><Leaf size={18} /></Link><span className="editor-wordmark">FlowCanvas</span><span className="editor-vdivider" /><Link className="breadcrumb-link" to="/">我的画布</Link><span className="breadcrumb-slash">/</span><span className="canvas-title">{title}</span></div>
        <div className="editor-center-tools">
          <div className="canvas-toolbar" role="toolbar" aria-label="画布工具">
            {toolOptions.map(({ id, label, icon: Icon }) => <button key={id} className={`canvas-tool ${tool === id ? "active" : ""}`} title={label} aria-label={label} onClick={() => setTool(id)}><Icon size={18} /></button>)}
            <button type="button" className="canvas-tool" aria-label="导入图片到画布并添加为生图参考" title="导入图片" onClick={() => imageImportInputRef.current?.click()}><Upload size={17} /></button>
            <span className="toolbar-divider" />
            <button className="canvas-tool" aria-label="撤销" title="撤销" onClick={undo} disabled={!undoStack.current.length}><Undo2 size={17} /></button><button className="canvas-tool" aria-label="重做" title="重做" onClick={redo} disabled={!redoStack.current.length}><Redo2 size={17} /></button>
          </div>
          <button className="save-status" onClick={() => setSaved(true)} title="画布暂存在当前浏览器会话，不会上传到服务器"><Cloud size={16} /><span>{saved ? "会话草稿" : "草稿已更新"}</span><small>未同步到云端</small></button>
        </div>
        <div className="editor-top-actions"><button className="agent-toggle" onClick={() => setAgentOpen((open) => !open)}><span />Agent</button><Link to="/account" className="avatar avatar-small">林</Link></div>
      </header>
      <div className={`editor-workspace ${agentCompact ? "agent-compact" : ""}`}>
        <aside className="editor-left-panel">
          <div className="left-nav-tabs"><button className="left-nav-active"><Square size={17} />画布</button><Link to={`/assets?canvas=${encodeURIComponent(canvasId)}`}><ImagePlus size={17} />素材</Link></div>
          <div className="layer-section"><div className="panel-section-heading"><span>图层</span></div><label className="layer-search"><SearchIcon /><input placeholder="搜索图层…" /></label>
            <div className="canvas-layer-list">{items.map((item) => <div className={`canvas-layer-row ${selectedIds.includes(item.id) ? "selected" : ""}`} key={item.id}><button className="layer-select" onClick={() => selectCanvasItems([item.id])}><span className="layer-chevron">›</span>{item.type === "image" ? <img src={item.src} alt="" /> : <span className="layer-color-chip">{item.type === "note" ? "▧" : "◧"}</span>}<span className="layer-name">{item.title}</span></button><button className="layer-visibility" aria-label={`${item.visible === false ? "显示" : "隐藏"} ${item.title}`} onClick={() => { if (item.visible !== false) setSelectedIds((current) => current.filter((id) => id !== item.id)); updateCanvasItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, visible: entry.visible === false } : entry)); }}>{item.visible === false ? <EyeOff size={14} /> : <Eye size={14} />}</button></div>)}</div>
          </div>
          <div className="left-panel-bottom"><Link to="/settings/agent"><Settings2 size={17} />设置</Link><button><CircleHelp size={17} />帮助</button></div>
        </aside>
        <main className="editor-canvas-area">
          <CanvasStage items={items} setItems={updateCanvasItems} tool={tool} setTool={setTool} selectedIds={selectedIds} setSelectedIds={selectCanvasItems} zoom={zoom} setZoom={setZoom} brushColor={brushColor} onCreate={(item) => updateCanvasItems((current) => [...current, item])} />
          <button className="mobile-agent-trigger" onClick={() => setAgentOpen((open) => !open)}><Sparkles size={15} />Agent</button>
          {tool === "brush" && <div className="brush-palette" role="group" aria-label="画笔颜色">{["#dce6aa", "#b9e98f", "#f0eee5", "#d79373", "#93a9bd"].map((color) => <button key={color} className={brushColor === color ? "brush-color active" : "brush-color"} style={{ backgroundColor: color }} aria-label={`画笔颜色 ${color}`} aria-pressed={brushColor === color} onClick={() => setBrushColor(color)} />)}</div>}
          {selectedIds.length > 0 && <div className="selection-inspector">
            <span>选中对象</span><strong>{selectedChatItem?.title ?? (selectedIds.length === 1 ? items.find((item) => item.id === selectedIds[0])?.title : `${selectedIds.length} 个对象`)}</strong>
            {canColorSelection && <div className="object-color-control"><button aria-label="对象配色" title="对象配色" aria-expanded={objectPaletteOpen} onClick={() => setObjectPaletteOpen((open) => !open)}><Palette size={14} /></button>{objectPaletteOpen && <div className="object-color-menu" role="group" aria-label="对象配色"><span>填充颜色</span>{objectPaletteColors.map((color) => { const selectedColor = selectedIds.every((id) => { const item = items.find((entry) => entry.id === id); const currentColor = item?.color ?? (item?.type === "shape" ? "#b9e98f" : item?.type === "connector" ? "#d6d8d0" : "#dce6aa"); return currentColor === color; }); return <button key={color} className="object-color-swatch" style={{ backgroundColor: color }} aria-label={`设置颜色 ${color}`} aria-pressed={selectedColor} onClick={() => { updateCanvasItems((current) => current.map((item) => selectedIds.includes(item.id) ? { ...item, color } : item)); setObjectPaletteOpen(false); }} />; })}</div>}</div>}
            <span className="inspector-divider" /><button aria-label="复制对象" onClick={() => { const copies = itemsRef.current.filter((item) => selectedIds.includes(item.id)).map((item) => ({ ...item, id: crypto.randomUUID(), x: item.x + 24, y: item.y + 24, title: `${item.title} 副本` })); updateCanvasItems((current) => [...current, ...copies]); setSelectedIds(copies.map((item) => item.id)); }}><Copy size={14} /></button><button aria-label="删除对象" onClick={() => { updateCanvasItems((current) => current.filter((item) => !selectedIds.includes(item.id))); setSelectedIds([]); }}><X size={15} /></button>
          </div>}
          <ImageGenerationBar references={generationReferences} onRemoveReference={removeGenerationReference} onSubmitPrompt={submitAgentGoal} focusPromptRequest={generationFocusRequest} />
          <div className="canvas-help-hint"><span>空格 + 拖动</span> 平移画布 <span className="hint-dot">·</span> <span>滚轮</span> 缩放</div>
        </main>
        <AgentPanel open={agentOpen} compact={agentCompact} onToggleCompact={() => setAgentCompact((value) => !value)} onClose={() => setAgentOpen(false)} references={generationReferences} onRemoveReference={removeGenerationReference} onClearReferences={() => setGenerationReferences([])} submittedGoal={submittedGoal} proposalHistorySignal={proposalHistorySignal} onSaveAsset={saveAssetFromAgent} onApplyProposal={(id) => { agentProposalItemIdRef.current = id; updateCanvasItems((current) => [...current, { id, type: "note", x: 330, y: 135, width: 190, height: 130, title: "视觉层级建议", content: "· 主图作为视觉焦点\n· 采用自然绿与暖米色\n· 保持留白和轻盈感" }]); }} />
      </div>
      <div className="editor-toast"><span className="toast-dot" />{currentTool?.label}工具已选中 <button onClick={() => setSaved(true)}>保存演示状态</button></div>
    </div>
  );
}

function SearchIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>;
}
