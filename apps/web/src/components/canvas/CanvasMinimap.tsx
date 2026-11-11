import type { CanvasItem, CanvasViewport } from "@canvas/canvas-core";
import { useMemo, useRef, useState } from "react";
import { CloseIcon, MinimapGridIcon } from "../Icons";

type CanvasMinimapProps = {
  items: CanvasItem[];
  viewport: CanvasViewport;
  stageWidth: number;
  stageHeight: number;
  onPanToWorldPoint: (worldX: number, worldY: number) => void;
};

export function CanvasMinimap({
  items,
  viewport,
  stageWidth,
  stageHeight,
  onPanToWorldPoint,
}: CanvasMinimapProps) {
  const [collapsed, setCollapsed] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const visible = useMemo(() => items.filter((i) => i.visible !== false), [items]);
  const mapBounds = useMemo(() => {
    const viewLeft = -viewport.x / viewport.scale;
    const viewTop = -viewport.y / viewport.scale;
    const viewW = stageWidth / viewport.scale;
    const viewH = stageHeight / viewport.scale;

    const xs = [viewLeft, viewLeft + viewW, ...visible.flatMap((i) => [i.x, i.x + i.width])];
    const ys = [viewTop, viewTop + viewH, ...visible.flatMap((i) => [i.y, i.y + i.height])];
    const minX = Math.min(...xs) - 120;
    const minY = Math.min(...ys) - 120;
    const maxX = Math.max(...xs) + 120;
    const maxY = Math.max(...ys) + 120;

    const bw = 166;
    const bh = 82;
    const worldW = Math.max(400, maxX - minX);
    const worldH = Math.max(260, maxY - minY);
    const scale = Math.min((bw - 12) / worldW, (bh - 10) / worldH);
    const offX = (bw - worldW * scale) / 2;
    const offY = (bh - worldH * scale) / 2;

    return { minX, minY, scale, offX, offY, viewLeft, viewTop, viewW, viewH };
  }, [visible, viewport, stageWidth, stageHeight]);

  const panFromClientPoint = (clientX: number, clientY: number) => {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect) return;
    const wx = (clientX - rect.left - mapBounds.offX) / mapBounds.scale + mapBounds.minX;
    const wy = (clientY - rect.top - mapBounds.offY) / mapBounds.scale + mapBounds.minY;
    onPanToWorldPoint(wx, wy);
  };

  return (
    <div className={`minimap-card ${collapsed ? "collapsed" : ""}`}>
      <div
        style={{
          height: collapsed ? "100%" : 24,
          padding: collapsed ? 0 : "0 8px",
          display: "flex",
          alignItems: "center",
          justifyContent: collapsed ? "center" : "space-between",
          borderBottom: collapsed ? 0 : "1px solid var(--border-hairline)",
          fontSize: 10.5,
          color: "var(--text-secondary)",
          background: "rgba(255,255,255,0.6)",
        }}
      >
        {!collapsed && <span>全局缩略图</span>}
        <button
          type="button"
          className="fc-icon-btn"
          style={{ width: 20, height: 20 }}
          title={collapsed ? "展开全局小地图" : "收起全局小地图"}
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? <MinimapGridIcon size={13} /> : <CloseIcon size={11} />}
        </button>
      </div>

      {!collapsed && (
        <div
          ref={boxRef}
          onMouseDown={(e) => {
            e.preventDefault();
            panFromClientPoint(e.clientX, e.clientY);
            const onMove = (ev: MouseEvent) => panFromClientPoint(ev.clientX, ev.clientY);
            const onUp = () => {
              window.removeEventListener("mousemove", onMove);
              window.removeEventListener("mouseup", onUp);
            };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
          }}
          style={{
            position: "relative",
            flex: 1,
            background: "rgba(246, 245, 242, 0.72)",
            cursor: "crosshair",
            overflow: "hidden",
          }}
        >
          {visible.map((item) => (
            <div
              key={item.id}
              style={{
                position: "absolute",
                pointerEvents: "none",
                borderRadius: 2,
                left: mapBounds.offX + (item.x - mapBounds.minX) * mapBounds.scale,
                top: mapBounds.offY + (item.y - mapBounds.minY) * mapBounds.scale,
                width: Math.max(4, item.width * mapBounds.scale),
                height: Math.max(3, item.height * mapBounds.scale),
                background:
                  item.type === "image" ? "rgba(180, 140, 95, 0.42)" : "rgba(20, 20, 19, 0.16)",
                border:
                  item.type === "image"
                    ? "1px solid rgba(140, 100, 60, 0.48)"
                    : "1px solid rgba(20, 20, 19, 0.2)",
              }}
            />
          ))}
          <div
            style={{
              position: "absolute",
              pointerEvents: "none",
              border: "1.5px solid var(--sapphire)",
              background: "rgba(37, 99, 235, 0.09)",
              borderRadius: 2,
              left: mapBounds.offX + (mapBounds.viewLeft - mapBounds.minX) * mapBounds.scale,
              top: mapBounds.offY + (mapBounds.viewTop - mapBounds.minY) * mapBounds.scale,
              width: Math.max(12, mapBounds.viewW * mapBounds.scale),
              height: Math.max(8, mapBounds.viewH * mapBounds.scale),
            }}
          />
        </div>
      )}
    </div>
  );
}
