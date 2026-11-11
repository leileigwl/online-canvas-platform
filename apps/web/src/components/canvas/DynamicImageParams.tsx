import { CloseIcon } from "../Icons";

export type GenerationParamState = {
  model: string;
  aspectRatio: string;
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
};

export function summarizeGenerationRule(refCount: number, state: GenerationParamState): string {
  if (refCount === 0) {
    return `纯文生图 · ${state.aspectRatio === "auto" ? "3:4" : state.aspectRatio} · ${state.model}`;
  }
  if (refCount === 1) {
    return `单图编辑 · ${state.model} · ${state.aspectRatio === "auto" ? "跟随图1" : state.aspectRatio}`;
  }
  return `多图融合(${refCount}张) · ${state.model}`;
}

export function DynamicImageParams({
  refCount,
  value,
  onChange,
  onClose,
  configuredModelLabel,
}: DynamicImageParamsProps) {
  const isGptImage = value.model.startsWith("gpt-image") || value.model === "auto";
  const isSiliconFlowWarn = refCount > 1 && value.model === "Kolors";
  const ratioOptions =
    refCount === 0
      ? ["3:4", "1:1", "4:3", "16:9", "9:16"]
      : refCount === 1
        ? ["auto", "3:4", "1:1", "4:3", "16:9"]
        : ["auto", "1:1", "3:4", "4:3", "16:9"];

  const ruleText = isSiliconFlowWarn
    ? "警告：硅基流动 Kolors 单次最多支持 1 张参考图，请移除多余参考或切换阿里百炼 / OpenAI。"
    : refCount === 0
      ? "纯文生图（0 张参考）：支持指定宽高比、质量与生成张数。"
      : refCount === 1
        ? value.model === "qwen-image-2.0"
          ? "单图编辑（1 张参考）：阿里百炼 qwen-image-2.0 默认按图1原始比例输出，可手动覆盖比例。"
          : "单图编辑（1 张参考）：支持图1特征编辑、透明 PNG 与保真度控制。"
        : value.model === "qwen-image-2.0"
          ? "多图融合（最多 3 张）：按 图1 / 图2 / 图3 顺序解析，选择 auto 时保持最后一张图比例。"
          : "多图融合阵列：OpenAI /images/edits 支持多参考图阵列编辑（最多 16 张）与 input_fidelity。";

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

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <label style={{ fontSize: 12, color: "var(--text-secondary)", minWidth: 96 }}>模型路由</label>
        <select
          value={value.model}
          onChange={(e) => onChange({ ...value, model: e.target.value })}
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
            {configuredModelLabel ? `使用设置默认（${configuredModelLabel}）` : "跟随设置页默认模型 (auto)"}
          </option>
          <option value="qwen-image-2.0">qwen-image-2.0（阿里百炼 1-3 图融合）</option>
          <option value="gpt-image-1">gpt-image-1（OpenAI 多图 / 透明）</option>
          <option value="Kolors">Kolors（硅基流动 · 仅限 ≤1 张参考）</option>
        </select>
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

      {refCount > 0 && isGptImage && (
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
