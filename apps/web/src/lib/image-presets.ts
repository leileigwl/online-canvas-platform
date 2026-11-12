import type { ImageModelConfig, ImageProviderType } from "@canvas/api-client";

export type ImageProviderPreset = {
  provider: ImageProviderType;
  title: string;
  baseUrl: string;
  defaultModel: string;
  hint: string;
  keyPlaceholder: string;
  models: { id: string; label: string }[];
};

export const IMAGE_PROVIDER_PRESETS: Record<ImageProviderType, ImageProviderPreset> = {
  "google-gemini": {
    provider: "google-gemini",
    title: "Google Gemini / Nano Banana（原生 :generateContent）",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-2.5-flash-image",
    keyPlaceholder: "AIza...",
    hint: "支持 Nano Banana (gemini-2.5-flash-image)、Nano Banana 2.1 / Gemini 3.1 (2K/4K 与最多 14 张参考图融合) 及 Imagen 4。",
    models: [
      { id: "gemini-2.5-flash-image", label: "Nano Banana (gemini-2.5-flash-image)" },
      { id: "gemini-nano-banana-2.1", label: "Nano Banana 2.1 (2K/14图融合)" },
      { id: "gemini-3.1-flash-image", label: "Gemini 3.1 Flash Image" },
      { id: "gemini-3-pro-image", label: "Gemini 3 Pro Image" },
      { id: "imagen-4.0-generate-001", label: "Google Imagen 4.0" },
    ],
  },
  "openai-compatible": {
    provider: "openai-compatible",
    title: "OpenAI / 聚合网关 (OneAPI · NewAPI · OpenRouter)",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-image-2.5-sunburst",
    keyPlaceholder: "sk-...",
    hint: "支持 OpenAI GPT Image 2.5 / 2.6 / 2 / 1.5（透明 PNG 与 16 图编辑），同时兼容聚合网关通过 /chat/completions 路由 Nano Banana 等多模态生图。",
    models: [
      { id: "gpt-image-2.5-sunburst", label: "GPT Image 2.5 Sunburst" },
      { id: "gpt-image-2.5-flare", label: "GPT Image 2.5 Flare" },
      { id: "gpt-image-2.6-sunburst", label: "GPT Image 2.6 Sunburst" },
      { id: "gpt-image-2", label: "GPT Image 2" },
      { id: "gpt-image-1.5", label: "GPT Image 1.5" },
      { id: "chatgpt-image-latest", label: "ChatGPT Image Latest" },
      { id: "dall-e-3", label: "DALL-E 3" },
    ],
  },
  dashscope: {
    provider: "dashscope",
    title: "阿里百炼 DashScope (Qwen-Image / 万相)",
    baseUrl: "https://dashscope.aliyuncs.com/api/v1",
    defaultModel: "qwen-image-2.0",
    keyPlaceholder: "sk-...",
    hint: "阿里百炼原生多模态生成/融合，支持 1-3 张参考图（图1/图2/图3），auto 默认保留末图比例。",
    models: [
      { id: "qwen-image-2.0", label: "Qwen-Image 2.0 (1-3图融合)" },
      { id: "qwen-image-plus", label: "Qwen-Image Plus" },
      { id: "wan2.6-t2i", label: "通义万相 Wan 2.6" },
    ],
  },
  "volcengine-ark": {
    provider: "volcengine-ark",
    title: "火山方舟即梦 Volcengine Ark (Seedream)",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    defaultModel: "doubao-seedream-4-0-250828",
    keyPlaceholder: "...",
    hint: "支持豆包即梦 Seedream 5.0 Pro / 4.0 / 3.0，支持 1K/2K 分辨率、透明背景及参考图融合（可填推理接入点 ep- 或官方模型 ID）。",
    models: [
      { id: "doubao-seedream-5-0-pro-260628", label: "即梦 Seedream 5.0 Pro" },
      { id: "doubao-seedream-4-0-250828", label: "即梦 Seedream 4.0" },
      { id: "doubao-seedream-3-0-t2i-250415", label: "即梦 Seedream 3.0" },
    ],
  },
  siliconflow: {
    provider: "siliconflow",
    title: "硅基流动 SiliconFlow (Kolors / FLUX / Qwen)",
    baseUrl: "https://api.siliconflow.cn/v1",
    defaultModel: "Kwai-Kolors/Kolors",
    keyPlaceholder: "sk-...",
    hint: "硅基流动生图端点，支持 Kolors、Qwen-Image、FLUX.1-dev，单次最多支持 0-1 张参考图。",
    models: [
      { id: "Kwai-Kolors/Kolors", label: "可图 Kolors (≤1张参考)" },
      { id: "Qwen/Qwen-Image", label: "Qwen/Qwen-Image (SiliconFlow)" },
      { id: "black-forest-labs/FLUX.1-dev", label: "FLUX.1-dev" },
    ],
  },
  mock: {
    provider: "mock",
    title: "Mock Studio（内置测试生图接口 · 免 Key）",
    baseUrl: "https://mock.flowcanvas.local/v1",
    defaultModel: "mock-studio-v1",
    keyPlaceholder: "内置测试适配器无需密钥（留空即可）",
    hint: "保留用于 Agent 循环、排版碰撞检测与 Harness 长期记忆联调的内置生图适配器，按选定比例实时生成带 Prompt 摘要的 PNG 存入私有存储。",
    models: [
      { id: "mock-studio-v1", label: "Mock Studio v1 (快速构图测试)" },
      { id: "mock-studio-editorial", label: "Mock Studio Editorial" },
    ],
  },
};

export const IMAGE_PROVIDER_ORDER: ImageProviderType[] = [
  "google-gemini",
  "openai-compatible",
  "dashscope",
  "volcengine-ark",
  "siliconflow",
  "mock",
];

export type SelectableImageOption = {
  id: string;
  label: string;
  configId?: string;
  configured: boolean;
};

export function buildSelectableImageModels(
  configs: ImageModelConfig[],
): SelectableImageOption[] {
  const seen = new Set<string>();
  const out: SelectableImageOption[] = [];

  for (const cfg of configs) {
    if (!cfg.configured || !cfg.model_name) continue;
    const key = `${cfg.id || cfg.provider}:${cfg.model_name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: cfg.model_name,
      label: `${cfg.label || cfg.model_name}${cfg.is_default ? " · 默认已配" : " · 已配"}`,
      configId: cfg.id || undefined,
      configured: true,
    });
  }

  for (const prov of IMAGE_PROVIDER_ORDER) {
    const preset = IMAGE_PROVIDER_PRESETS[prov];
    const hasProviderCfg = configs.some((c) => c.configured && c.provider === prov);
    for (const m of preset.models) {
      if (out.some((item) => item.id === m.id)) continue;
      out.push({
        id: m.id,
        label: hasProviderCfg ? m.label : `${m.label}（预设）`,
        configured: hasProviderCfg,
      });
    }
  }
  return out;
}
