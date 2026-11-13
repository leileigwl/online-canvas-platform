import type {
  CanvasDocument,
  CanvasItem,
  CanvasSnapshot,
  CanvasViewport,
} from "@canvas/canvas-core";

export type { CanvasDocument, CanvasItem, CanvasSnapshot, CanvasViewport };

export type User = {
  id: string;
  username: string;
  email?: string | null;
  email_verified?: boolean;
};
export type EmailCodePurpose = "register" | "reset_password" | "bind_email";
export type EmailCodeResult = {
  sent: boolean;
  expires_in_seconds: number;
  cooldown_seconds: number;
  message: string;
};
export type Project = { id: string; name: string; updated_at: string };
export type CanvasVersion = {
  revision: number;
  created_at: string;
  schema_version: number;
  object_count: number;
  is_current: boolean;
};

export type Asset = {
  id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  width: number;
  height: number;
  favorite: boolean;
  temporary: boolean;
  src: string;
  created_at: string;
};

export type ImageProviderType =
  | "openai-compatible"
  | "google-gemini"
  | "dashscope"
  | "volcengine-ark"
  | "siliconflow"
  | "mock";

export type ImageModelConfig = {
  id?: string | null;
  label: string;
  provider: ImageProviderType;
  base_url: string;
  model_name: string;
  default_options: Record<string, unknown>;
  is_default: boolean;
  configured: boolean;
};

export type ImageModelConfigInput = {
  id?: string | null;
  label?: string;
  provider: ImageProviderType;
  base_url: string;
  model_name: string;
  api_key?: string;
  default_options?: Record<string, unknown>;
  is_default?: boolean;
};

export type ImageGenerationInput = {
  config_id?: string | null;
  prompt: string;
  reference_asset_ids: string[];
  model: string;
  quality: string;
  width: number;
  height: number;
  align_to_16: boolean;
  resolution: string;
  aspect_ratio: string;
  transparent: boolean;
  input_fidelity?: "high" | "low";
  count: number;
};

export type ImageGenerationResult = { status: "succeeded"; images: Asset[] };

export type AgentTask = {
  id: string;
  role: string;
  sequence: number;
  task_key: string;
  title: string;
  depends_on: string[];
  status: string;
  output: Record<string, unknown> | null;
  error: string | null;
};

export type AgentProposalOperation = {
  tool: string;
  params: Record<string, unknown>;
  result?: {
    asset_id: string;
    src: string;
    width: number;
    height: number;
    title?: string;
  };
};

export type HarnessRunOptions = {
  use_mock_image?: boolean;
  image_engine?: "local-mflux" | "cloud-api" | "mock";
  llm_mode?: "real" | "scripted";
  loop_mode?: "autonomous" | "pipeline";
  lab_scenario?: "normal" | "collision_repair" | "memory_compaction";
  force_compact?: boolean;
  max_repair_rounds?: number;
  max_loop_steps?: number;
  compaction_threshold_pct?: number;
};

export type AutonomousStepRecord = {
  step: number;
  action: string;
  label: string;
  detail: string;
};

export type AgentSession = {
  id: string;
  canvas_id: string;
  title: string;
  compacted_summary: string;
  compacted_run_count: number;
  recent_run_count: number;
  estimated_tokens: number;
  max_context_tokens: number;
  compaction_threshold_tokens: number;
  rejected_feedback: string[];
  pinned_user_values: string[];
  chat_cleared_at: string | null;
  created_at: string;
  updated_at: string;
};

export type LayoutIssue = {
  code: string;
  object_ids: string[];
  overlap_ratio?: number;
  message: string;
  suggestion: string;
};

export type VerifierReport = {
  passed: boolean;
  issue_count: number;
  issues: LayoutIssue[];
  bounds?: { min_x: number; min_y: number; max_x: number; max_y: number } | null;
};

export type RepairRoundRecord = {
  round: number;
  verifier_passed: boolean;
  issue_count: number;
  approved: boolean;
  feedback: string;
};

export type AgentRun = {
  id: string;
  canvas_id: string;
  session_id?: string | null;
  goal: string;
  status: string;
  context_revision: number;
  model_calls_used: number;
  model_call_budget: number;
  completion_tokens_used: number;
  completion_usage_reports: number;
  completion_tokens_per_call: number;
  summary: string | null;
  harness_options?: HarnessRunOptions | null;
  proposal: {
    operations: AgentProposalOperation[];
    generated_assets?: Asset[];
    applied?: boolean;
    rejected?: boolean;
    reverted?: boolean;
    reply?: string;
    steps?: AutonomousStepRecord[];
    compaction_count?: number;
    review?: {
      approved: boolean;
      passed_verifier?: boolean;
      attempt_count?: number;
      needs_manual_review?: boolean;
      feedback?: string;
      verifier_issues?: LayoutIssue[];
    };
    verifier?: VerifierReport | null;
    repair_history?: RepairRoundRecord[];
    attempt_count?: number;
  } | null;
  error: string | null;
  tasks: AgentTask[];
  created_at: string;
  updated_at: string;
};

export type CanvasMemory = {
  compacted_summary: string;
  compacted_run_count: number;
  recent_run_count: number;
  estimated_tokens: number;
  max_context_tokens: number;
  compaction_threshold_tokens: number;
  rejected_feedback: string[];
  pinned_user_values?: string[];
};

export type HarnessInspectResult = {
  canvas_id: string;
  revision: number;
  item_count: number;
  active_model?: {
    configured: boolean;
    model_name: string;
    base_url: string;
    role_models: Record<string, string>;
    max_context_tokens: number;
  };
  canvas_brief: Array<Record<string, unknown>>;
  recent_turns?: Array<{
    id: string;
    goal: string;
    status: string;
    summary: string;
    model_calls_used: number;
    completion_tokens_used: number;
    decision: string;
  }>;
  token_breakdown: {
    system_prompts_tokens?: number;
    pinned_values_tokens?: number;
    canvas_brief_tokens: number;
    core_memory_tokens?: number;
    recent_turns_tokens?: number;
    live_run_tokens?: number;
    memory_estimated_tokens: number;
    total_estimated_tokens: number;
    compaction_threshold_tokens: number;
    max_context_tokens: number;
    utilization_pct: number;
  };
  memory: CanvasMemory;
  layout_verification: VerifierReport & { preview_items?: Array<Record<string, unknown>> };
};

export type RunStreamEvent = {
  sequence: number;
  type: string;
  data: Record<string, unknown>;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const apiBase =
  (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
    ?.VITE_API_BASE_URL ?? "/api";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers,
    credentials: "include",
  });
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const detail = body?.detail;
    const message =
      typeof detail === "string"
        ? detail
        : Array.isArray(detail) &&
            detail.length > 0 &&
            typeof detail[0] === "object" &&
            detail[0] &&
            "msg" in detail[0]
          ? String(detail[0].msg).replace(/^Value error,\s*/i, "")
          : typeof detail === "object" && detail && "message" in detail
            ? String(detail.message)
            : response.statusText;
    throw new ApiError(response.status, message, detail);
  }
  return body as T;
}

const json = (value: unknown): string => JSON.stringify(value);

export const api = {
  session: () => request<{ authenticated: boolean; user: User | null }>("/auth/session"),
  me: () => request<User>("/auth/me"),
  sendEmailCode: (email: string, purpose: EmailCodePurpose) =>
    request<EmailCodeResult>("/auth/email-code", {
      method: "POST",
      body: json({ email, purpose }),
    }),
  login: (identifier: string, password: string) =>
    request<User>("/auth/login", { method: "POST", body: json({ identifier, password }) }),
  register: (input: {
    username: string;
    email: string;
    password: string;
    verification_code: string;
  }) => request<User>("/auth/register", { method: "POST", body: json(input) }),
  resetPassword: (input: { email: string; verification_code: string; new_password: string }) =>
    request<void>("/auth/password/reset", { method: "POST", body: json(input) }),
  bindEmail: (email: string, verification_code: string) =>
    request<User>("/auth/email/bind", {
      method: "POST",
      body: json({ email, verification_code }),
    }),
  logout: () => request<void>("/auth/logout", { method: "POST" }),
  changePassword: (current_password: string, new_password: string) =>
    request<void>("/auth/password", {
      method: "PATCH",
      body: json({ current_password, new_password }),
    }),
  deleteAccount: (identifier: string, password: string) =>
    request<void>("/auth/account", { method: "DELETE", body: json({ identifier, password }) }),

  listProjects: () => request<Project[]>("/projects"),
  createProject: (name: string) =>
    request<Project>("/projects", { method: "POST", body: json({ name }) }),
  listCanvases: (projectId: string) =>
    request<CanvasSnapshot[]>(`/projects/${projectId}/canvases`),
  createCanvas: (name: string, project_id?: string) =>
    request<CanvasSnapshot>("/canvases", { method: "POST", body: json({ name, project_id }) }),
  getCanvas: (id: string) => request<CanvasSnapshot>(`/canvases/${id}`),
  renameCanvas: (id: string, name: string) =>
    request<CanvasSnapshot>(`/canvases/${id}`, { method: "PATCH", body: json({ name }) }),
  deleteCanvas: (id: string) => request<void>(`/canvases/${id}`, { method: "DELETE" }),
  saveCanvas: (
    id: string,
    base_revision: number,
    document: CanvasDocument,
    viewport: CanvasViewport,
  ) =>
    request<CanvasSnapshot>(`/canvases/${id}`, {
      method: "PUT",
      body: json({ base_revision, document, viewport }),
    }),
  saveCanvasKeepalive: (
    id: string,
    base_revision: number,
    document: CanvasDocument,
    viewport: CanvasViewport,
  ) => {
    void fetch(`${apiBase}/canvases/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: json({ base_revision, document, viewport }),
      credentials: "include",
      keepalive: true,
    }).catch(() => {});
  },
  listCanvasVersions: (id: string, limit = 12) =>
    request<CanvasVersion[]>(`/canvases/${id}/versions?limit=${limit}`),
  createCanvasCheckpoint: (id: string) =>
    request<CanvasVersion>(`/canvases/${id}/versions`, { method: "POST" }),
  restoreCanvasVersion: (id: string, version_revision: number, base_revision: number) =>
    request<CanvasSnapshot>(`/canvases/${id}/restore`, {
      method: "POST",
      body: json({ version_revision, base_revision }),
    }),

  listAssets: (search = "") =>
    request<Asset[]>(`/assets${search ? `?search=${encodeURIComponent(search)}` : ""}`),
  uploadAsset: (file: File) => {
    const form = new FormData();
    form.set("file", file);
    return request<Asset>("/assets", { method: "POST", body: form });
  },
  saveGeneratedAsset: (id: string) => request<Asset>(`/assets/${id}/save`, { method: "POST" }),
  setFavorite: (id: string, favorite: boolean) =>
    request<Asset>(`/assets/${id}/favorite`, { method: "PATCH", body: json({ favorite }) }),

  getModelConfig: () =>
    request<{
      provider: string;
      base_url: string;
      model_name: string;
      role_models: Record<string, string>;
      max_context_tokens: number;
      configured: boolean;
    }>("/agent/model-config"),
  saveModelConfig: (input: {
    provider: "openai-compatible";
    base_url: string;
    model_name: string;
    api_key?: string;
    role_models: Record<string, string>;
    max_context_tokens?: number;
  }) =>
    request<{
      provider: string;
      base_url: string;
      model_name: string;
      role_models: Record<string, string>;
      max_context_tokens: number;
      configured: boolean;
    }>("/agent/model-config", { method: "PUT", body: json(input) }),
  testModelConfig: (input: {
    provider: "openai-compatible";
    base_url: string;
    model_name: string;
    api_key: string;
    role_models?: Record<string, string>;
  }) =>
    request<{ ok: boolean; message: string }>("/agent/model-config/test", {
      method: "POST",
      body: json(input),
    }),

  getImageConfig: () => request<ImageModelConfig>("/agent/image-config"),
  listImageConfigs: () => request<ImageModelConfig[]>("/agent/image-configs"),
  createImageConfig: (input: ImageModelConfigInput) =>
    request<ImageModelConfig>("/agent/image-configs", { method: "POST", body: json(input) }),
  updateImageConfig: (id: string, input: ImageModelConfigInput) =>
    request<ImageModelConfig>(`/agent/image-configs/${id}`, {
      method: "PUT",
      body: json(input),
    }),
  deleteImageConfig: (id: string) =>
    request<void>(`/agent/image-configs/${id}`, { method: "DELETE" }),
  saveImageConfig: (input: ImageModelConfigInput) =>
    request<ImageModelConfig>("/agent/image-config", { method: "PUT", body: json(input) }),
  testImageConfig: (input: ImageModelConfigInput) =>
    request<{ ok: boolean; message: string }>("/agent/image-config/test", {
      method: "POST",
      body: json(input),
    }),

  submitAgentGoal: (input: {
    canvas_id: string;
    session_id?: string;
    goal: string;
    reference_asset_ids: string[];
    generation_settings?: Omit<ImageGenerationInput, "prompt" | "reference_asset_ids">;
    harness_options?: HarnessRunOptions;
    idempotency_key: string;
  }) => request<AgentRun>("/agent/runs", { method: "POST", body: json(input) }),
  listAgentRuns: (canvasId: string, sessionId?: string) =>
    request<AgentRun[]>(
      `/agent/runs?canvas_id=${encodeURIComponent(canvasId)}${sessionId ? `&session_id=${encodeURIComponent(sessionId)}` : ""}`,
    ),
  listAgentSessions: (canvasId: string) =>
    request<AgentSession[]>(`/canvases/${canvasId}/agent-sessions`),
  createAgentSession: (canvasId: string, title?: string) =>
    request<AgentSession>(`/canvases/${canvasId}/agent-sessions`, {
      method: "POST",
      body: json({ title }),
    }),
  clearAgentChat: (
    sessionId: string,
    preserve_cloud_memory = true,
    llm_mode: "real" | "scripted" = "scripted",
  ) =>
    request<AgentSession>(`/agent-sessions/${sessionId}/clear-chat`, {
      method: "POST",
      body: json({ preserve_cloud_memory, llm_mode }),
    }),
  compactSessionMemory: (sessionId: string, llm_mode: "real" | "scripted" = "scripted") =>
    request<AgentSession>(`/agent-sessions/${sessionId}/memory/compact`, {
      method: "POST",
      body: json({ llm_mode }),
    }),
  resetSessionMemory: (sessionId: string) =>
    request<AgentSession>(`/agent-sessions/${sessionId}/memory`, { method: "DELETE" }),
  deleteAgentSession: (sessionId: string) =>
    request<void>(`/agent-sessions/${sessionId}`, { method: "DELETE" }),
  getAgentRun: (id: string) => request<AgentRun>(`/agent/runs/${id}`),
  cancelAgentRun: (id: string) => request<AgentRun>(`/agent/runs/${id}/cancel`, { method: "POST" }),
  retryAgentRun: (id: string) => request<AgentRun>(`/agent/runs/${id}/retry`, { method: "POST" }),
  applyProposal: (id: string, base_revision: number) =>
    request<CanvasSnapshot>(`/agent/runs/${id}/apply`, {
      method: "POST",
      body: json({ base_revision }),
    }),
  revertProposal: (id: string, base_revision: number) =>
    request<CanvasSnapshot>(`/agent/runs/${id}/revert`, {
      method: "POST",
      body: json({ base_revision }),
    }),
  rejectProposal: (id: string) => request<AgentRun>(`/agent/runs/${id}/reject`, { method: "POST" }),
  getCanvasMemory: (canvasId: string) =>
    request<CanvasMemory>(`/canvases/${canvasId}/memory`),
  clearCanvasMemory: (canvasId: string) =>
    request<CanvasMemory>(`/canvases/${canvasId}/memory`, { method: "DELETE" }),
  inspectCanvasHarness: (
    canvasId: string,
    operations: Array<Record<string, unknown>> = [],
    options?: { session_id?: string; compaction_threshold_pct?: number },
  ) =>
    request<HarnessInspectResult>(`/canvases/${canvasId}/harness/inspect`, {
      method: "POST",
      body: json({ operations, ...options }),
    }),
  compactCanvasMemory: (canvasId: string, llm_mode: "real" | "scripted" = "scripted") =>
    request<CanvasMemory>(`/canvases/${canvasId}/memory/compact`, {
      method: "POST",
      body: json({ llm_mode }),
    }),
  generateImage: (input: ImageGenerationInput) =>
    request<ImageGenerationResult>("/generations", { method: "POST", body: json(input) }),
};

export function subscribeRunEvents(
  runId: string,
  onEvent: (event: RunStreamEvent) => void,
  onError?: () => void,
  after = 0,
): () => void {
  const source = new EventSource(`${apiBase}/agent/runs/${runId}/events?after=${after}`, {
    withCredentials: true,
  });
  const eventTypes = [
    "queued",
    "running",
    "task_created",
    "task_updated",
    "thinking",
    "context",
    "verifier",
    "tool_call",
    "succeeded",
    "failed",
    "canceled",
    "applied",
    "reverted",
    "rejected",
  ];
  const handler = (type: string) => (ev: MessageEvent) => {
    try {
      const data = JSON.parse(ev.data || "{}") as Record<string, unknown>;
      const sequence = Number(ev.lastEventId || 0);
      onEvent({ sequence, type, data });
    } catch {
      // ignore malformed frame
    }
  };
  eventTypes.forEach((t) => source.addEventListener(t, handler(t)));
  source.onerror = () => {
    onError?.();
  };
  return () => {
    source.close();
  };
}
