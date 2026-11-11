export type PendingHomeRef = {
  name: string;
  mimeType: string;
  dataUrl: string;
};

export type PendingHomeIntent =
  | {
      kind: "generate";
      prompt: string;
      aspectRatio: string;
      model: string;
      refs: PendingHomeRef[];
      createdAt: number;
    }
  | {
      kind: "blank";
      canvasName: string;
      createdAt: number;
    };

const KEY = "flowcanvas_pending_intent";

export async function fileToPendingRef(file: File): Promise<PendingHomeRef> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  return { name: file.name, mimeType: file.type || "image/png", dataUrl };
}

export async function pendingRefToFile(ref: PendingHomeRef): Promise<File> {
  const res = await fetch(ref.dataUrl);
  const blob = await res.blob();
  return new File([blob], ref.name, { type: ref.mimeType });
}

export function setPendingHomeIntent(intent: PendingHomeIntent): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(intent));
  } catch {
    // ignore storage quota overflow on oversized refs
  }
}

export function consumePendingHomeIntent(): PendingHomeIntent | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    sessionStorage.removeItem(KEY);
    return JSON.parse(raw) as PendingHomeIntent;
  } catch {
    return null;
  }
}
