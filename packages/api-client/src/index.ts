import type { CanvasSnapshot, CanvasDocument, CanvasViewport } from "@canvas/canvas-core";

export type User = { id: string; username: string };
export type Project = { id: string; name: string; updated_at: string };
export type Asset = {
  id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  width: number;
  height: number;
  favorite: boolean;
  src: string;
  created_at: string;
};
export type AgentTask = { id: string; role: string; sequence: number; status: string; output: Record<string, unknown> | null; error: string | null };
export type AgentRun = {
  id: string;
  canvas_id: string;
  goal: string;
  status: string;
  context_revision: number;
  summary: string | null;
  proposal: { operations: Array<{ tool: string; params: Record<string, unknown> }>; applied?: boolean; rejected?: boolean } | null;
  error: string | null;
  tasks: AgentTask[];
  created_at: string;
  updated_at: string;
};

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly detail?: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

const apiBase = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_API_BASE_URL ?? "/api";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await fetch(`${apiBase}${path}`, { ...init, headers, credentials: "include" });
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const detail = body?.detail;
    const message = typeof detail === "string" ? detail : typeof detail === "object" && detail && "message" in detail ? String(detail.message) : response.statusText;
    throw new ApiError(response.status, message, detail);
  }
  return body as T;
}

const json = (value: unknown): string => JSON.stringify(value);

export const api = {
  me: () => request<User>("/auth/me"),
  login: (username: string, password: string) => request<User>("/auth/login", { method: "POST", body: json({ username, password }) }),
  register: (username: string, password: string) => request<User>("/auth/register", { method: "POST", body: json({ username, password }) }),
  logout: () => request<void>("/auth/logout", { method: "POST" }),
  changePassword: (current_password: string, new_password: string) => request<void>("/auth/password", { method: "PATCH", body: json({ current_password, new_password }) }),
  deleteAccount: (username: string, password: string) => request<void>("/auth/account", { method: "DELETE", body: json({ username, password }) }),
  listProjects: () => request<Project[]>("/projects"),
  createProject: (name: string) => request<Project>("/projects", { method: "POST", body: json({ name }) }),
  listCanvases: (projectId: string) => request<CanvasSnapshot[]>(`/projects/${projectId}/canvases`),
  createCanvas: (name: string, project_id?: string) => request<CanvasSnapshot>("/canvases", { method: "POST", body: json({ name, project_id }) }),
  getCanvas: (id: string) => request<CanvasSnapshot>(`/canvases/${id}`),
  renameCanvas: (id: string, name: string) => request<CanvasSnapshot>(`/canvases/${id}`, { method: "PATCH", body: json({ name }) }),
  deleteCanvas: (id: string) => request<void>(`/canvases/${id}`, { method: "DELETE" }),
  saveCanvas: (id: string, base_revision: number, document: CanvasDocument, viewport: CanvasViewport) => request<CanvasSnapshot>(`/canvases/${id}`, { method: "PUT", body: json({ base_revision, document, viewport }) }),
  listAssets: (search = "") => request<Asset[]>(`/assets${search ? `?search=${encodeURIComponent(search)}` : ""}`),
  uploadAsset: (file: File) => { const form = new FormData(); form.set("file", file); return request<Asset>("/assets", { method: "POST", body: form }); },
  setFavorite: (id: string, favorite: boolean) => request<Asset>(`/assets/${id}/favorite`, { method: "PATCH", body: json({ favorite }) }),
  getModelConfig: () => request<{ provider: string; base_url: string; model_name: string; configured: boolean }>("/agent/model-config"),
  saveModelConfig: (input: { provider: "openai-compatible"; base_url: string; model_name: string; api_key?: string }) => request<{ provider: string; base_url: string; model_name: string; configured: boolean }>("/agent/model-config", { method: "PUT", body: json(input) }),
  testModelConfig: (input: { provider: "openai-compatible"; base_url: string; model_name: string; api_key: string }) => request<{ ok: boolean; message: string }>("/agent/model-config/test", { method: "POST", body: json(input) }),
  submitAgentGoal: (input: { canvas_id: string; goal: string; reference_asset_ids: string[]; idempotency_key: string }) => request<AgentRun>("/agent/runs", { method: "POST", body: json(input) }),
  getAgentRun: (id: string) => request<AgentRun>(`/agent/runs/${id}`),
  cancelAgentRun: (id: string) => request<AgentRun>(`/agent/runs/${id}/cancel`, { method: "POST" }),
  retryAgentRun: (id: string) => request<AgentRun>(`/agent/runs/${id}/retry`, { method: "POST" }),
  applyProposal: (id: string, base_revision: number) => request<CanvasSnapshot>(`/agent/runs/${id}/apply`, { method: "POST", body: json({ base_revision }) }),
  rejectProposal: (id: string) => request<AgentRun>(`/agent/runs/${id}/reject`, { method: "POST" }),
  generateImage: (input: Record<string, unknown>) => request<unknown>("/generations", { method: "POST", body: json(input) }),
};
