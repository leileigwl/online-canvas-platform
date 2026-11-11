import type { CanvasItem } from "@canvas/canvas-core";
import type Konva from "konva";

/**
 * Exports all visible canvas items cropped cleanly to their world-space bounding box (+40px ivory padding)
 * at 2x resolution, excluding any UI chrome or selection borders.
 */
export function exportKonvaCanvasPng(
  stage: Konva.Stage,
  contentLayer: Konva.Layer,
  items: CanvasItem[],
  canvasTitle: string,
): { width: number; height: number } {
  const visible = items.filter((item) => item.visible !== false);
  if (!visible.length) {
    throw new Error("当前画布没有可见内容可导出");
  }

  const pad = 40;
  const exportScale = 2;
  const minX = Math.min(...visible.map((i) => i.x)) - pad;
  const minY = Math.min(...visible.map((i) => i.y)) - pad;
  const maxX = Math.max(...visible.map((i) => i.x + i.width)) + pad;
  const maxY = Math.max(...visible.map((i) => i.y + i.height)) + pad;
  const worldW = Math.max(320, Math.round(maxX - minX));
  const worldH = Math.max(240, Math.round(maxY - minY));

  const currentScale = stage.scaleX() || 1;
  const stageX = stage.x();
  const stageY = stage.y();

  const contentCanvas = contentLayer.toCanvas({
    x: minX * currentScale + stageX,
    y: minY * currentScale + stageY,
    width: worldW * currentScale,
    height: worldH * currentScale,
    pixelRatio: exportScale / currentScale,
  });

  const composite = document.createElement("canvas");
  composite.width = worldW * exportScale;
  composite.height = worldH * exportScale;
  const ctx = composite.getContext("2d");
  if (!ctx) throw new Error("无法创建导出画布上下文");

  // Warm ivory gallery backdrop + subtle architectural dot grid
  ctx.fillStyle = "#f6f5f2";
  ctx.fillRect(0, 0, composite.width, composite.height);
  ctx.fillStyle = "rgba(20, 20, 19, 0.11)";
  for (let gx = 24; gx < composite.width; gx += 48) {
    for (let gy = 24; gy < composite.height; gy += 48) {
      ctx.beginPath();
      ctx.arc(gx, gy, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.drawImage(contentCanvas, 0, 0, composite.width, composite.height);

  const link = document.createElement("a");
  link.download = `${canvasTitle || "flowcanvas"}.png`;
  link.href = composite.toDataURL("image/png");
  link.click();

  return { width: composite.width, height: composite.height };
}

export function exportSelectedAsset(item: CanvasItem): void {
  if (!item.src) throw new Error("当前选中的对象不是可导出的图片");
  const link = document.createElement("a");
  link.download = `${item.title || "flowcanvas-image"}.png`;
  link.href = item.src;
  link.click();
}
