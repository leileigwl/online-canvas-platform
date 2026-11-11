import type { ImageModelConfig } from "@canvas/api-client";
import { useState } from "react";
import { buildSelectableImageModels } from "../../lib/image-presets";
import { CloseIcon } from "../Icons";

export type GenerationParamState = {
  model: string;
  configId?: string;
  aspectRatio: string;
  resolution?: "auto" | "1K" | "2K" | "4K";
  quality: "auto" | "low" | "medium" | "high";
  inputFidelity: "high" | "low";
  transparent: boolean;
  count: number;
};

type DynamicImageParamsProps = {
  refCount: number;
  value: GenerationParamState;
  onChange: (next: GenerationParamState) => void;
  onClose?: () => void;
  configuredModelLabel?: string;
  imageConfigs?: ImageModelConfig[];
};

export function summarizeGenerationRule(refCount: number, state: GenerationParamState): string {
  const resTag =
    state.resolution && state.resolution !== "auto" ? ` · ${state.resolution}` : "";
  if (refCount === 0) {
    return `纯文生图 · ${state.aspectRatio === "auto" ? "3:4" : state.aspectRatio}${resTag} · ${state.model}`;
  }
  if (refCount === 1) {
    return `单图编辑 · ${state.model} · ${state.aspectRatio === "auto" ? "跟随图1" : state.aspectRatio}${resTag}`;
  }
  return `多图融合(${refCount}张) · ${state.model}${resTag}`;
}

export function DynamicImageParams({
  refCount,
  value,
  onChange,
  onClose,
  configuredModelLabel,
  imageConfigs = [],
}: DynamicImageParamsProps) {
  const selectableModels = buildSelectableImageModels(imageConfigs);
  const isListed =
    value.model === "auto" || selectableModels.some((item) => item.id === value.model);
  const [customMode, setCustomMode] = useState(!isListed);

  const lower = value.model.toLowerCase();
  const isGptImage =
    lower.startsWith("gpt-image") || lower.startsWith("chatgpt-image") || value.model === "auto";
  const supportsInputFidelity = lower.startsWith("gpt-image-1");
  const supportsResolution =
    /gemini-3|nano-banana-2|pro-image|3\.1|seedream|doubao-seedream/i.test(lower);
  const isSiliconFlowWarn = refCount > 1 && /kolors|flux|siliconflow/i.test(lower);
  const isGemini = /gemini|nano-banana/i.test(lower);
  const isQwen = /qwen-image/i.test(lower);
  const isSeedream = /seedream/i.test(lower);

  const ratioOptions =
    refCount === 0
      ? ["3:4", "1:1", "4:3", "16:9", "9:16"]
      : ["auto", "3:4", "1:1", "4:3", "16:9"];

  const ruleText = isSiliconFlowWarn
    ? "警告：硅基流动（Kolors/FLUX）单次最多支持 1 张参考图，请移除多余参考或切换 Gemini / GPT Image / 百炼。"
    : isGemini
      ? "Google Gemini / Nano Banana 原生多模态：支持文生图与最多 14 张参考图语义编辑融合。"
      : isSeedream
        ? "火山方舟即梦 Seedream：支持 1K/2K 分辨率、参考图风格迁移与透明背景通道。"
        : refCount === 0
          ? "纯文生图（0 张参考）：支持指定宽高比、清晰度与多张并发生成。"
          : refCount === 1 && isQwen
            ? "单图编辑（1 张参考）：阿里百炼 Qwen-Image 2.0 默认按图1原始比例输出，可手动覆盖比例。"
            : refCount > 1 && isQwen
              ? "多图融合（最多 3 张）：按 图1 / 图2 / 图3 顺序解析，auto 默认保留末图比例。"
              : "多图编辑：GPT Image 2.5 / 2.6 默认自动高保真融合多张参考图（最多 16 张），支持透明 PNG。";

  return (
    <div className="params-popover" onMouseDown={(e) => e.stopPropagation()}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <strong style={{ fontSize: 12.5 }}>
          {refCount === 0
            ? "生图参数（纯文生图模式）"
            : refCount === 1
              ? "生图参数（单图编辑模式）"
              : `生图参数（${refCount} 图 · 多图融合模式）`}
        </strong>
        {onClose && (
          <button type="button" className="fc-btn fc-btn-sm fc-btn-obsidian" onClick={onClose}>
            完成
          </button>
        )}
      </div>

      <div
        style={{
          padding: "7px 10px",
          borderRadius: 9,
          fontSize: 11.5,
          lineHeight: 1.5,
          background: isSiliconFlowWarn ? "var(--amber-soft)" : "var(--sapphire-soft)",
          color: isSiliconFlowWarn ? "var(--amber)" : "var(--sapphire)",
        }}
      >
        {ruleText}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <label style={{ fontSize: 12, color: "var(--text-secondary)", minWidth: 96 }}>模型路由</label>
          <select
            value={customMode ? "__custom__" : value.model}
            onChange={(e) => {
              const nextVal = e.target.value;
              if (nextVal === "__custom__") {
                setCustomMode(true);
                return;
              }
              setCustomMode(false);
              const matched = selectableModels.find((m) => m.id === nextVal);
              onChange({
                ...value,
                model: nextVal,
                configId: matched?.configId,
              });
            }}
            style={{
              flex: 1,
              height: 34,
              background: "var(--surface-input)",
              border: "1px solid var(--border-hairline)",
              borderRadius: 8,
              padding: "0 8px",
              fontSize: 12,
            }}
          >
            <option value="auto">
              {configuredModelLabel ? `使用设置默认（${configuredModelLabel}）` : "跟随设置默认模型 (auto)"}
            </option>
            {selectableModels.map((item) => (
              <option key={`${item.configId || "preset"}-${item.id}`} value={item.id}>
                {item.label}
              </option>
            ))}
            <option value="__custom__">自定义模型 ID...</option>
          </select>
        </div>

        {customMode && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <span style={{ fontSize: 11.5, color: "var(--text-muted)", minWidth: 96 }}>自定义模型名</span>
            <input
              value={value.model === "auto" ? "" : value.model}
              onChange={(e) =>
                onChange({ ...value, model: e.target.value || "auto", configId: undefined })
              }
              placeholder="如 gemini-2.5-flash-image / gpt-image-2.5-sunburst / ep-..."
              style={{
                flex: 1,
                height: 32,
                background: "#fff",
                border: "1px solid var(--border-hairline)",
                borderRadius: 8,
                padding: "0 9px",
                fontSize: 12,
                outline: 0,
              }}
            />
          </div>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <span style={{ fontSize: 12, color: "var(--text-secondary)", minWidth: 96 }}>画面比例</span>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", flex: 1 }}>
          {ratioOptions.map((ratio) => (
            <button
              key={ratio}
              type="button"
              className={`chip-btn ${value.aspectRatio === ratio ? "active" : ""}`}
              onClick={() => onChange({ ...value, aspectRatio: ratio })}
            >
              {ratio === "auto" ? (refCount <= 1 ? "跟随图1" : "跟随末图") : ratio}
            </button>
          ))}
        </div>
      </div>

      {supportsResolution && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <span style={{ fontSize: 12, color: "var(--text-secondary)", minWidth: 96 }}>输出清晰度</span>
          <div style={{ display: "flex", gap: 6, flex: 1, flexWrap: "wrap" }}>
            {(["auto", "1K", "2K", "4K"] as const).map((resOpt) => (
              <button
                key={resOpt}
                type="button"
                className={`chip-btn ${(value.resolution || "auto") === resOpt ? "active" : ""}`}
                onClick={() => onChange({ ...value, resolution: resOpt })}
              >
                {resOpt === "auto" ? "默认" : resOpt}
              </button>
            ))}
          </div>
        </div>
      )}

      {refCount > 0 && supportsInputFidelity && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <span style={{ fontSize: 12, color: "var(--text-secondary)", minWidth: 96 }}>参考图保真度</span>
          <div style={{ display: "flex", gap: 6, flex: 1 }}>
            <button
              type="button"
              className={`chip-btn ${value.inputFidelity === "high" ? "active" : ""}`}
              onClick={() => onChange({ ...value, inputFidelity: "high" })}
            >
              高保真 (high)
            </button>
            <button
              type="button"
              className={`chip-btn ${value.inputFidelity === "low" ? "active" : ""}`}
              onClick={() => onChange({ ...value, inputFidelity: "low" })}
            >
              平衡创意 (low)
            </button>
          </div>
        </div>
      )}

      {isGptImage && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <span style={{ fontSize: 12, color: "var(--text-secondary)", minWidth: 96 }}>背景通道</span>
          <div style={{ display: "flex", gap: 6, flex: 1 }}>
            <button
              type="button"
              className={`chip-btn ${!value.transparent ? "active" : ""}`}
              onClick={() => onChange({ ...value, transparent: false })}
            >
              标准背景
            </button>
            <button
              type="button"
              className={`chip-btn ${value.transparent ? "active" : ""}`}
              onClick={() => onChange({ ...value, transparent: true })}
            >
              透明 PNG
            </button>
          </div>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <span style={{ fontSize: 12, color: "var(--text-secondary)", minWidth: 96 }}>出图数量</span>
        <div style={{ display: "flex", gap: 6, flex: 1 }}>
          {[1, 2, 4].map((cnt) => (
            <button
              key={cnt}
              type="button"
              className={`chip-btn ${value.count === cnt ? "active" : ""}`}
              onClick={() => onChange({ ...value, count: cnt })}
            >
              {cnt} 张
            </button>
          ))}
        </div>
        {onClose && (
          <button
            type="button"
            className="fc-icon-btn"
            style={{ width: 26, height: 26 }}
            onClick={onClose}
            aria-label="关闭参数浮层"
          >
            <CloseIcon size={12} />
          </button>
        )}
      </div>
    </div>
  );
}
