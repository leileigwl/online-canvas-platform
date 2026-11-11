import type { CanvasItem, CanvasViewport } from "@canvas/canvas-core";
import type Konva from "konva";
import { useEffect, useMemo, useRef, useState } from "react";
import { Circle, Group, Image as KonvaImage, Layer, Line, Rect, Stage, Text, Transformer } from "react-konva";
import type { CanvasToolMode } from "./LeftToolRail";

function useHtmlImage(src?: string): HTMLImageElement | null {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!src) {
      setImg(null);
      return;
    }
    let active = true;
    const el = new window.Image();
    el.crossOrigin = "anonymous";
    el.onload = () => {
      if (active) setImg(el);
    };
    el.onerror = () => {
      if (active) setImg(null);
    };
    el.src = src;
    return () => {
      active = false;
    };
  }, [src]);
  return img;
}

function ImageNode({
  item,
  draggable,
  onSelect,
  onDragStart,
  onDragMove,
  onDragEnd,
  onTransformEnd,
}: {
  item: CanvasItem;
  draggable: boolean;
  onSelect: (shiftKey: boolean) => void;
  onDragStart: (e: Konva.KonvaEventObject<DragEvent>) => void;
  onDragMove: () => void;
  onDragEnd: (x: number, y: number, e: Konva.KonvaEventObject<DragEvent>) => void;
  onTransformEnd: (w: number, h: number, x: number, y: number) => void;
}) {
  const imageObj = useHtmlImage(item.src);
  return (
    <Group
      id={item.id}
      x={item.x}
      y={item.y}
      width={item.width}
      height={item.height}
      draggable={draggable}
      onMouseDown={(e) => {
        if (!draggable) return;
        e.cancelBubble = true;
        onSelect(e.evt.shiftKey);
      }}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragEnd={(e) => onDragEnd(e.target.x(), e.target.y(), e)}
      onTransformEnd={(e) => {
        const node = e.target;
        const sx = node.scaleX();
        const sy = node.scaleY();
        node.scale({ x: 1, y: 1 });
        onTransformEnd(
          Math.max(40, Math.round(item.width * sx)),
          Math.max(40, Math.round(item.height * sy)),
          Math.round(node.x()),
          Math.round(node.y()),
        );
      }}
    >
      <Rect
        width={item.width}
        height={item.height}
        fill="#ebe8e0"
        cornerRadius={10}
        stroke="rgba(20, 20, 19, 0.1)"
        strokeWidth={1}
        shadowColor="rgba(20, 20, 19, 0.08)"
        shadowBlur={14}
        shadowOffsetY={4}
      />
      {imageObj && (
        <KonvaImage
          image={imageObj}
          width={item.width}
          height={item.height}
          cornerRadius={10}
        />
      )}
    </Group>
  );
}

type KonvaStageViewProps = {
  items: CanvasItem[];
  viewport: CanvasViewport;
  onChangeViewport: (next: CanvasViewport) => void;
  selectedIds: string[];
  onChangeSelectedIds: (ids: string[], clickedItem?: CanvasItem) => void;
  tool: CanvasToolMode;
  spacePressed: boolean;
  strokeColor: string;
  brushWidth: number;
  textFont: "sans" | "serif" | "mono";
  textSize: number;
  onMoveItem: (id: string, x: number, y: number) => void;
  onResizeItem: (id: string, x: number, y: number, width: number, height: number) => void;
  onCreateTextAt: (x: number, y: number) => string;
  onUpdateTextContent: (id: string, content: string) => void;
  onCreateBrush: (item: CanvasItem) => void;
  stageRef: React.RefObject<Konva.Stage | null>;
  contentLayerRef: React.RefObject<Konva.Layer | null>;
  stageSize: { width: number; height: number };
};

export function KonvaStageView({
  items,
  viewport,
  onChangeViewport,
  selectedIds,
  onChangeSelectedIds,
  tool,
  spacePressed,
  strokeColor,
  brushWidth,
  textFont,
  textSize,
  onMoveItem,
  onResizeItem,
  onCreateTextAt,
  onUpdateTextContent,
  onCreateBrush,
  stageRef,
  contentLayerRef,
  stageSize,
}: KonvaStageViewProps) {
  const dragLayerRef = useRef<Konva.Layer | null>(null);
  const trRef = useRef<Konva.Transformer | null>(null);

  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const marqueeStart = useRef<{ x: number; y: number } | null>(null);

  const [brushPreview, setBrushPreview] = useState<number[] | null>(null);
  const brushPointsRef = useRef<number[]>([]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");

  const visibleItems = useMemo(() => items.filter((i) => i.visible !== false), [items]);
  const isHand = tool === "hand" || spacePressed;
  const canDragItems = tool === "select" && !spacePressed;

  // Bind Transformer cleanly to currently selected nodes in contentLayer
  useEffect(() => {
    const tr = trRef.current;
    const layer = contentLayerRef.current;
    if (!tr || !layer) return;
    if (!canDragItems || selectedIds.length === 0) {
      tr.nodes([]);
      tr.getLayer()?.batchDraw();
      return;
    }
    const nodes = selectedIds
      .map((id) => layer.findOne(`#${id}`))
      .filter((n): n is Konva.Node => Boolean(n));
    tr.nodes(nodes);
    tr.getLayer()?.batchDraw();
  }, [selectedIds, visibleItems, canDragItems, contentLayerRef]);

  const toWorld = (pointer: { x: number; y: number }) => ({
    x: (pointer.x - viewport.x) / viewport.scale,
    y: (pointer.y - viewport.y) / viewport.scale,
  });

  const handleStageMouseDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
    if (isHand || tool === "text") return;
    const stage = stageRef.current;
    const pointer = stage?.getPointerPosition();
    if (!stage || !pointer) return;
    const worldPt = toWorld(pointer);

    if (tool === "brush") {
      const start = [worldPt.x, worldPt.y];
      brushPointsRef.current = start;
      setBrushPreview(start);
      return;
    }

    // Marquee start only when clicking empty stage area
    if (e.target === stage) {
      onChangeSelectedIds([]);
      marqueeStart.current = worldPt;
      setMarquee({ x: worldPt.x, y: worldPt.y, w: 0, h: 0 });
    }
  };

  const handleStageClick = () => {
    if (isHand || tool !== "text") return;
    const stage = stageRef.current;
    const pointer = stage?.getPointerPosition();
    if (!stage || !pointer) return;
    const worldPt = toWorld(pointer);
    const createdId = onCreateTextAt(Math.round(worldPt.x), Math.round(worldPt.y));
    setEditingId(createdId);
    setEditingText("双击编辑文字内容");
  };

  const handleStageMouseMove = () => {
    const stage = stageRef.current;
    const pointer = stage?.getPointerPosition();
    if (!pointer) return;
    const worldPt = toWorld(pointer);

    if (brushPreview && tool === "brush") {
      brushPointsRef.current = [...brushPointsRef.current, worldPt.x, worldPt.y];
      setBrushPreview(brushPointsRef.current);
      return;
    }

    if (marqueeStart.current) {
      const sx = marqueeStart.current.x;
      const sy = marqueeStart.current.y;
      setMarquee({
        x: Math.min(sx, worldPt.x),
        y: Math.min(sy, worldPt.y),
        w: Math.abs(worldPt.x - sx),
        h: Math.abs(worldPt.y - sy),
      });
    }
  };

  const handleStageMouseUp = () => {
    if (brushPreview && tool === "brush") {
      const pts = brushPointsRef.current;
      setBrushPreview(null);
      brushPointsRef.current = [];
      if (pts.length >= 4) {
        const xs = pts.filter((_, i) => i % 2 === 0);
        const ys = pts.filter((_, i) => i % 2 === 1);
        const minX = Math.min(...xs);
        const minY = Math.min(...ys);
        const maxX = Math.max(...xs);
        const maxY = Math.max(...ys);
        const localPts = pts.map((v, idx) =>
          Math.round(idx % 2 === 0 ? v - minX : v - minY),
        );
        onCreateBrush({
          id: `brush-${Date.now()}`,
          type: "brush",
          x: Math.round(minX),
          y: Math.round(minY),
          width: Math.max(24, Math.round(maxX - minX)),
          height: Math.max(24, Math.round(maxY - minY)),
          title: "画笔涂鸦",
          points: localPts,
          color: strokeColor,
          stroke_width: brushWidth,
          visible: true,
        });
      }
      return;
    }

    if (marqueeStart.current && marquee) {
      if (marquee.w > 6 || marquee.h > 6) {
        const x1 = marquee.x;
        const y1 = marquee.y;
        const x2 = marquee.x + marquee.w;
        const y2 = marquee.y + marquee.h;
        const matched = visibleItems
          .filter(
            (it) => it.x <= x2 && it.x + it.width >= x1 && it.y <= y2 && it.y + it.height >= y1,
          )
          .map((it) => it.id);
        onChangeSelectedIds(matched);
      }
      marqueeStart.current = null;
      setMarquee(null);
    }
  };

  const handleWheel = (e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const stage = stageRef.current;
    const pointer = stage?.getPointerPosition();
    if (!stage || !pointer) return;
    const oldScale = viewport.scale;
    const factor = e.evt.deltaY > 0 ? 0.92 : 1.08;
    const nextScale = Math.max(0.25, Math.min(2.6, oldScale * factor));
    const worldX = (pointer.x - viewport.x) / oldScale;
    const worldY = (pointer.y - viewport.y) / oldScale;
    onChangeViewport({
      scale: nextScale,
      x: pointer.x - worldX * nextScale,
      y: pointer.y - worldY * nextScale,
    });
  };

  const syncTransformer = () => {
    if (trRef.current) {
      trRef.current.forceUpdate();
      trRef.current.getLayer()?.batchDraw();
    }
  };

  const moveToDragLayer = (e: Konva.KonvaEventObject<DragEvent>) => {
    if (dragLayerRef.current) {
      e.target.moveTo(dragLayerRef.current);
    }
  };

  const settleToMainLayer = (
    id: string,
    x: number,
    y: number,
    e: Konva.KonvaEventObject<DragEvent>,
    snapDirectPosition = true,
  ) => {
    const sx = Math.round(x);
    const sy = Math.round(y);
    if (snapDirectPosition) {
      e.target.position({ x: sx, y: sy });
    }
    if (contentLayerRef.current) {
      e.target.moveTo(contentLayerRef.current);
    }
    syncTransformer();
    onMoveItem(id, sx, sy);
  };

  const selectSingleOrToggle = (item: CanvasItem, shiftKey: boolean) => {
    if (shiftKey) {
      const exists = selectedIds.includes(item.id);
      const next = exists ? selectedIds.filter((i) => i !== item.id) : [...selectedIds, item.id];
      onChangeSelectedIds(next, exists ? undefined : item);
    } else {
      onChangeSelectedIds([item.id], item);
    }
  };

  const editingItem = editingId ? items.find((i) => i.id === editingId) : null;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        cursor: isHand
          ? "grab"
          : tool === "text"
            ? "text"
            : tool === "brush"
              ? "crosshair"
              : "default",
      }}
    >
      <Stage
        ref={stageRef}
        width={stageSize.width}
        height={stageSize.height}
        x={viewport.x}
        y={viewport.y}
        scaleX={viewport.scale}
        scaleY={viewport.scale}
        draggable={isHand}
        onDragEnd={(e) => {
          if (e.target === stageRef.current) {
            onChangeViewport({ ...viewport, x: e.target.x(), y: e.target.y() });
          }
        }}
        onWheel={handleWheel}
        onMouseDown={handleStageMouseDown}
        onClick={handleStageClick}
        onMouseMove={handleStageMouseMove}
        onMouseUp={handleStageMouseUp}
      >
        <Layer ref={contentLayerRef}>
          {visibleItems.map((item) => {
            if (item.type === "image") {
              return (
                <ImageNode
                  key={item.id}
                  item={item}
                  draggable={canDragItems}
                  onSelect={(shift) => selectSingleOrToggle(item, shift)}
                  onDragStart={moveToDragLayer}
                  onDragMove={syncTransformer}
                  onDragEnd={(x, y, e) => settleToMainLayer(item.id, x, y, e)}
                  onTransformEnd={(w, h, x, y) => onResizeItem(item.id, x, y, w, h)}
                />
              );
            }

            if (item.type === "note") {
              return (
                <Group
                  key={item.id}
                  id={item.id}
                  x={item.x}
                  y={item.y}
                  width={item.width}
                  height={item.height}
                  draggable={canDragItems}
                  onMouseDown={(e) => {
                    if (!canDragItems) return;
                    e.cancelBubble = true;
                    selectSingleOrToggle(item, e.evt.shiftKey);
                  }}
                  onDblClick={() => {
                    setEditingId(item.id);
                    setEditingText(item.content || "");
                  }}
                  onDragStart={moveToDragLayer}
                  onDragMove={syncTransformer}
                  onDragEnd={(e) => settleToMainLayer(item.id, e.target.x(), e.target.y(), e)}
                >
                  <Rect
                    width={item.width}
                    height={item.height}
                    fill="#fdfcf9"
                    cornerRadius={10}
                    stroke="rgba(20, 20, 19, 0.16)"
                    strokeWidth={1}
                    shadowColor="rgba(20, 20, 19, 0.08)"
                    shadowBlur={14}
                    shadowOffsetY={4}
                  />
                  <Rect width={item.width} height={3} fill="#141413" cornerRadius={[10, 10, 0, 0]} />
                  <Text
                    x={16}
                    y={16}
                    width={Math.max(40, item.width - 32)}
                    text={item.title || "EDITORIAL NOTE"}
                    fontFamily="Georgia, serif"
                    fontSize={15}
                    fontStyle="bold"
                    fill="#141413"
                  />
                  <Text
                    x={16}
                    y={42}
                    width={Math.max(40, item.width - 32)}
                    height={Math.max(20, item.height - 54)}
                    text={item.content || ""}
                    fontFamily="Inter, PingFang SC, sans-serif"
                    fontSize={12}
                    lineHeight={1.55}
                    fill="#5c5b57"
                  />
                </Group>
              );
            }

            if (item.type === "text") {
              const ff =
                (item.font_family ?? textFont) === "serif"
                  ? "Georgia, Noto Serif SC, serif"
                  : (item.font_family ?? textFont) === "mono"
                    ? "Menlo, monospace"
                    : "Inter, PingFang SC, sans-serif";
              return (
                <Text
                  key={item.id}
                  id={item.id}
                  x={item.x}
                  y={item.y}
                  width={item.width}
                  text={item.content || "文字图层"}
                  fontFamily={ff}
                  fontSize={item.font_size || textSize}
                  fontStyle="bold"
                  fill={item.color || "#141413"}
                  lineHeight={1.4}
                  draggable={canDragItems}
                  onMouseDown={(e) => {
                    if (!canDragItems && tool !== "text") return;
                    e.cancelBubble = true;
                    selectSingleOrToggle(item, e.evt.shiftKey);
                  }}
                  onDblClick={() => {
                    setEditingId(item.id);
                    setEditingText(item.content || "");
                  }}
                  onDragStart={moveToDragLayer}
                  onDragMove={syncTransformer}
                  onDragEnd={(e) => settleToMainLayer(item.id, e.target.x(), e.target.y(), e)}
                />
              );
            }

            if (item.type === "brush") {
              return (
                <Line
                  key={item.id}
                  id={item.id}
                  x={item.x}
                  y={item.y}
                  points={item.points || []}
                  stroke={item.color || "#141413"}
                  strokeWidth={item.stroke_width || 4}
                  lineCap="round"
                  lineJoin="round"
                  hitStrokeWidth={14}
                  draggable={canDragItems}
                  onMouseDown={(e) => {
                    if (!canDragItems) return;
                    e.cancelBubble = true;
                    selectSingleOrToggle(item, e.evt.shiftKey);
                  }}
                  onDragStart={moveToDragLayer}
                  onDragMove={syncTransformer}
                  onDragEnd={(e) => settleToMainLayer(item.id, e.target.x(), e.target.y(), e)}
                />
              );
            }

            // shape / swatch fallback
            if (item.shape_kind === "circle") {
              return (
                <Circle
                  key={item.id}
                  id={item.id}
                  x={item.x + item.width / 2}
                  y={item.y + item.height / 2}
                  radius={Math.min(item.width, item.height) / 2}
                  fill={item.color || "#ebe8e0"}
                  stroke="rgba(20,20,19,0.22)"
                  strokeWidth={1.5}
                  draggable={canDragItems}
                  onMouseDown={(e) => {
                    if (!canDragItems) return;
                    e.cancelBubble = true;
                    selectSingleOrToggle(item, e.evt.shiftKey);
                  }}
                  onDragStart={moveToDragLayer}
                  onDragMove={syncTransformer}
                  onDragEnd={(e) =>
                    settleToMainLayer(
                      item.id,
                      e.target.x() - item.width / 2,
                      e.target.y() - item.height / 2,
                      e,
                      false,
                    )
                  }
                />
              );
            }

            return (
              <Rect
                key={item.id}
                id={item.id}
                x={item.x}
                y={item.y}
                width={item.width}
                height={item.height}
                fill={item.shape_kind === "frame" ? "transparent" : item.color || "#ebe8e0"}
                stroke="rgba(20, 20, 19, 0.28)"
                strokeWidth={1.5}
                dash={item.shape_kind === "frame" ? [6, 4] : undefined}
                cornerRadius={10}
                draggable={canDragItems}
                onMouseDown={(e) => {
                  if (!canDragItems) return;
                  e.cancelBubble = true;
                  selectSingleOrToggle(item, e.evt.shiftKey);
                }}
                onDragStart={moveToDragLayer}
                onDragMove={syncTransformer}
                onDragEnd={(e) => settleToMainLayer(item.id, e.target.x(), e.target.y(), e)}
              />
            );
          })}
        </Layer>

        {/* Dedicated fast drag layer (no React state mutations per frame!) */}
        <Layer ref={dragLayerRef} />

        {/* Non-export UI overlay layer: selection Transformer, marquee box & live brush */}
        <Layer>
          <Transformer
            ref={trRef}
            borderStroke="#2563eb"
            borderStrokeWidth={2}
            anchorStroke="#2563eb"
            anchorFill="#ffffff"
            anchorSize={8}
            anchorCornerRadius={2}
            rotateEnabled={false}
            enabledAnchors={["top-left", "top-right", "bottom-left", "bottom-right"]}
          />
          {marquee && (
            <Rect
              x={marquee.x}
              y={marquee.y}
              width={marquee.w}
              height={marquee.h}
              stroke="#2563eb"
              strokeWidth={1.5 / viewport.scale}
              fill="rgba(37, 99, 235, 0.08)"
              listening={false}
            />
          )}
          {brushPreview && (
            <Line
              points={brushPreview}
              stroke={strokeColor}
              strokeWidth={brushWidth}
              lineCap="round"
              lineJoin="round"
              listening={false}
            />
          )}
        </Layer>
      </Stage>

      {editingItem && (
        <textarea
          autoFocus
          data-inline-editor="true"
          value={editingText}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setEditingText(e.target.value)}
          onBlur={() => {
            onUpdateTextContent(editingItem.id, editingText);
            setEditingId(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setEditingId(null);
          }}
          style={{
            position: "fixed",
            left: editingItem.x * viewport.scale + viewport.x,
            top: editingItem.y * viewport.scale + viewport.y,
            width: Math.max(180, editingItem.width * viewport.scale),
            height: Math.max(54, editingItem.height * viewport.scale),
            zIndex: 80,
            background: "#ffffff",
            border: "2px solid var(--sapphire)",
            borderRadius: 8,
            padding: 8,
            fontSize: Math.max(13, (editingItem.font_size || 16) * viewport.scale),
            boxShadow: "var(--shadow-float)",
            outline: 0,
            resize: "both",
          }}
        />
      )}
    </div>
  );
}
