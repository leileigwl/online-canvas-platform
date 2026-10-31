export type CanvasItemType = "image" | "note" | "swatch" | "shape" | "connector" | "brush";

export type CanvasItem = {
  id: string;
  type: CanvasItemType;
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  content?: string;
  color?: string;
  points?: number[];
  visible?: boolean;
  asset_id?: string;
  src?: string;
};

export type CanvasDocument = {
  schema_version: number;
  items: CanvasItem[];
};

export type CanvasViewport = { x: number; y: number; scale: number };

export type CanvasSnapshot = {
  id: string;
  project_id: string;
  name: string;
  document: CanvasDocument;
  viewport: CanvasViewport;
  schema_version: number;
  revision: number;
  updated_at: string;
};

export const emptyCanvasDocument = (): CanvasDocument => ({ schema_version: 1, items: [] });
