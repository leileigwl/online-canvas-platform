import type { CanvasDocument, CanvasViewport } from "@canvas/canvas-core";

export type LocalCanvasDraft = {
  canvasId: string;
  baseRevision: number;
  document: CanvasDocument;
  viewport: CanvasViewport;
  updatedAt: number;
};

const DB_NAME = "flowcanvas_drafts_v1";
const STORE_NAME = "drafts";

function openDraftDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "canvasId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

export async function loadCanvasDraft(canvasId: string): Promise<LocalCanvasDraft | null> {
  const db = await openDraftDb();
  if (!db) return null;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(canvasId);
    req.onsuccess = () => resolve((req.result as LocalCanvasDraft | undefined) ?? null);
    req.onerror = () => resolve(null);
  });
}

export async function saveCanvasDraft(draft: LocalCanvasDraft): Promise<void> {
  const db = await openDraftDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(draft);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function clearCanvasDraft(canvasId: string): Promise<void> {
  const db = await openDraftDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(canvasId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}
