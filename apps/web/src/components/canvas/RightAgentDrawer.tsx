import type { AgentRun, CanvasMemory } from "@canvas/api-client";
import { useState } from "react";
import { CloseIcon } from "../Icons";

export type StreamThinkingItem = {
  id: string;
  role: string;
  title: string;
  text: string;
};

export type StreamToolCallItem = {
  id: string;
  tool: string;
  label: string;
  params: Record<string, unknown>;
  status: string;
  result?: { asset_id?: string; src?: string; title?: string };
};

type RightAgentDrawerProps = {
  open: boolean;
  onClose: () => void;
  run: AgentRun | null;
  pastRuns: AgentRun[];
  memory: CanvasMemory | null;
  thinkingSteps: StreamThinkingItem[];
  toolCalls: StreamToolCallItem[];
  streaming: boolean;
  applying: boolean;
  onSelectRun: (run: AgentRun) => void;
  onClearMemory: () => void;
  onApplyProposal: () => void;
  onRevertProposal: () => void;
  onRejectProposal: () => void;
  onCancelRun: () => void;
  onRetryRun: () => void;
  onConfigureModel: () => void;
};

export function RightAgentDrawer({
  open,
  onClose,
  run,
  pastRuns,
  memory,
  thinkingSteps,
  toolCalls,
  streaming,
  applying,
  onSelectRun,
  onClearMemory,
  onApplyProposal,
  onRevertProposal,
  onRejectProposal,
  onCancelRun,
  onRetryRun,
  onConfigureModel,
}: RightAgentDrawerProps) {
  const [thinkingCollapsed, setThinkingCollapsed] = useState(false);
  const [memoryExpanded, setMemoryExpanded] = useState(false);
  const [expandedJsonIds, setExpandedJsonIds] = useState<string[]>([]);

  if (!open) return null;

  const toggleJson = (id: string) => {
    setExpandedJsonIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  };

  const statusText =
    run?.status === "succeeded"
      ? "已完成"
      : run?.status === "failed"
        ? "执行失败"
        : run?.status === "canceled"
          ? "已中止"
          : streaming
            ? "SSE 实时流"
            : "准备就绪";

  const canApply =
    run?.status === "succeeded" &&
    run.proposal &&
    !run.proposal.applied &&
    !run.proposal.rejected &&
    !run.proposal.reverted &&
    (run.proposal.operations?.length ?? 0) > 0;

  const canRevert =
    run?.status === "succeeded" &&
    Boolean(run.proposal?.applied) &&
    !run.proposal?.reverted;

  const memPct =
    memory && memory.max_context_tokens > 0
      ? Math.min(100, Math.round((memory.estimated_tokens / memory.compaction_threshold_tokens) * 100))
      : 0;

  return (
    <aside className="right-drawer">
      <div
        style={{
          padding: "13px 14px",
          borderBottom: "1px solid var(--border-hairline)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <strong style={{ fontSize: 13 }}>AI Agent</strong>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "2px 8px",
              borderRadius: 99,
              fontSize: 10.5,
              fontWeight: 550,
              background: run?.status === "failed" ? "var(--danger-soft)" : "var(--sapphire-soft)",
              color: run?.status === "failed" ? "var(--danger)" : "var(--sapphire)",
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: run?.status === "failed" ? "var(--danger)" : "var(--sapphire)",
              }}
            />
            {statusText}
          </span>
        </div>
        <button
          type="button"
          className="fc-icon-btn"
          style={{ width: 28, height: 28 }}
          onClick={onClose}
          title="关闭右侧面板"
        >
          <CloseIcon size={13} />
        </button>
      </div>

      {/* Harness Multi-Turn Context & Auto-Compaction Strip */}
      {memory && (
        <div
          style={{
            padding: "8px 12px",
            borderBottom: "1px solid var(--border-hairline)",
            background: "var(--surface-input)",
            fontSize: 11,
            display: "flex",
            flexDirection: "column",
            gap: 5,
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
            <button
              type="button"
              onClick={() => setMemoryExpanded((v) => !v)}
              style={{ color: "var(--text-secondary)", fontWeight: 550, textAlign: "left" }}
            >
              Harness 记忆 · 已压缩 {memory.compacted_run_count} 轮 · 近期 {memory.recent_run_count} 轮 ({memPct}% 压缩阈值) {memoryExpanded ? "▴" : "▾"}
            </button>
            <button
              type="button"
              onClick={onClearMemory}
              style={{ color: "var(--text-muted)", fontSize: 10.5 }}
            >
              清空记忆
            </button>
          </div>
          {memoryExpanded && (
            <div style={{ color: "var(--text-secondary)", lineHeight: 1.55, maxHeight: 120, overflowY: "auto" }}>
              <div>
                <b>压缩核心记忆：</b>
                {memory.compacted_summary || "暂未触发压缩，近期对话完整保留中。"}
              </div>
              {memory.rejected_feedback.length > 0 && (
                <div style={{ marginTop: 4, color: "var(--amber)" }}>
                  <b>负反馈避坑：</b>
                  {memory.rejected_feedback.slice(-2).join("；")}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: 12,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        {pastRuns.length > 1 && (
          <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 2, flexShrink: 0 }}>
            {pastRuns.slice(0, 6).map((item, idx) => (
              <button
                key={item.id}
                type="button"
                className={`chip-btn ${run?.id === item.id ? "active" : ""}`}
                style={{ whiteSpace: "nowrap", fontSize: 10.5 }}
                onClick={() => onSelectRun(item)}
              >
                #{pastRuns.length - idx} {item.goal.slice(0, 10)}
              </button>
            ))}
          </div>
        )}

        {!run ? (
          <div
            style={{
              padding: "20px 14px",
              borderRadius: 12,
              background: "var(--surface-input)",
              border: "1px solid var(--border-hairline)",
              fontSize: 12,
              lineHeight: 1.65,
              color: "var(--text-secondary)",
              flexShrink: 0,
            }}
          >
            <strong style={{ display: "block", color: "var(--text-primary)", marginBottom: 6 }}>
              LangGraph 多角色创作 · Harness 记忆引擎
            </strong>
            在底部输入栏切换到 <b>AI Agent</b> 模式并发送指令。Agent 将按当前画布持续记忆历史决策并在接近模型上下文窗口时自动蒸馏压缩核心记忆；支持引用画布图片生图、标注文字、局部对齐与单批提案精准撤销。
            <div style={{ marginTop: 10 }}>
              <button type="button" className="fc-btn fc-btn-sm" onClick={onConfigureModel}>
                检查模型、上下文窗口与生图设置
              </button>
            </div>
          </div>
        ) : (
          <>
            <div
              style={{
                padding: "10px 12px",
                borderRadius: 12,
                background: "var(--surface-muted)",
                fontSize: 12.5,
                lineHeight: 1.55,
                flexShrink: 0,
              }}
            >
              <b>当前指令：</b>
              {run.goal}
            </div>

            {thinkingSteps.length > 0 && (
              <div className="thinking-card">
                <button
                  type="button"
                  onClick={() => setThinkingCollapsed((v) => !v)}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "9px 11px",
                    fontSize: 11.5,
                    fontWeight: 600,
                    color: "var(--text-secondary)",
                  }}
                >
                  <span>思考过程 (Thinking · {thinkingSteps.length} 步)</span>
                  <span>{thinkingCollapsed ? "展开 ▸" : "收起 ▾"}</span>
                </button>
                {!thinkingCollapsed && (
                  <div
                    style={{
                      padding: "8px 11px 10px",
                      fontSize: 11.5,
                      lineHeight: 1.65,
                      color: "var(--text-secondary)",
                      borderTop: "1px solid var(--border-hairline)",
                      display: "flex",
                      flexDirection: "column",
                      gap: 7,
                    }}
                  >
                    {thinkingSteps.map((step) => (
                      <div key={step.id}>
                        <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                          [{step.role}] {step.title}：
                        </span>
                        {step.text}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {toolCalls.map((call) => {
              const showJson = expandedJsonIds.includes(call.id);
              const badgeCls =
                call.status === "created" || call.status === "applied"
                  ? "tool-status status-done"
                  : call.status === "running"
                    ? "tool-status status-running"
                    : "tool-status status-pending";
              const badgeText =
                call.status === "created"
                  ? "已出图待应用"
                  : call.status === "running"
                    ? "调用中…"
                    : call.status === "applied"
                      ? "已应用"
                      : "待预览应用";

              return (
                <div key={call.id} className="tool-call-card">
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 600 }}>{call.label}</span>
                    <span className={badgeCls}>{badgeText}</span>
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--text-secondary)", lineHeight: 1.55 }}>
                    工具名：<code>{call.tool}</code>
                  </div>
                  {call.result?.src && (
                    <img
                      src={call.result.src}
                      alt={call.result.title || "AI 生成预览"}
                      style={{
                        width: "100%",
                        maxHeight: 132,
                        objectFit: "cover",
                        borderRadius: 8,
                        border: "1px solid var(--border-hairline)",
                      }}
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => toggleJson(call.id)}
                    style={{
                      fontSize: 11,
                      color: "var(--text-muted)",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      alignSelf: "flex-start",
                    }}
                  >
                    <span>{showJson ? "收起参数详情 ▴" : "查看参数详情 ▾"}</span>
                  </button>
                  {showJson && (
                    <pre
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 10.5,
                        background: "var(--surface-muted)",
                        padding: "7px 9px",
                        borderRadius: 8,
                        color: "var(--text-secondary)",
                        overflowX: "auto",
                        margin: 0,
                      }}
                    >
                      {JSON.stringify(call.params, null, 2)}
                    </pre>
                  )}
                </div>
              );
            })}

            {run.summary && (
              <div
                style={{
                  padding: "9px 11px",
                  borderRadius: 10,
                  background: "var(--surface-input)",
                  border: "1px solid var(--border-hairline)",
                  fontSize: 12,
                  lineHeight: 1.55,
                  flexShrink: 0,
                }}
              >
                <strong style={{ display: "block", marginBottom: 3 }}>方案摘要</strong>
                {run.summary}
              </div>
            )}

            {run.error && (
              <div
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  background: "var(--danger-soft)",
                  color: "var(--danger)",
                  fontSize: 12,
                  lineHeight: 1.55,
                  flexShrink: 0,
                }}
              >
                {run.error}
              </div>
            )}

            {canApply && (
              <div
                style={{
                  padding: "11px 12px",
                  borderRadius: 12,
                  background: "var(--surface-solid)",
                  border: "1.5px solid var(--obsidian)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  flexShrink: 0,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <strong style={{ fontSize: 12 }}>
                    画布修改提案（{run.proposal?.operations.length} 项）
                  </strong>
                  <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>尚未写入画布</span>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    type="button"
                    className="fc-btn fc-btn-sm fc-btn-obsidian"
                    style={{ flex: 1 }}
                    disabled={applying}
                    onClick={onApplyProposal}
                  >
                    {applying ? "应用中..." : "应用到画布"}
                  </button>
                  <button type="button" className="fc-btn fc-btn-sm" onClick={onRejectProposal}>
                    忽略并记住
                  </button>
                </div>
              </div>
            )}

            {canRevert && (
              <div
                style={{
                  padding: "10px 12px",
                  borderRadius: 12,
                  background: "var(--surface-solid)",
                  border: "1px solid var(--border-strong)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  flexShrink: 0,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <strong style={{ fontSize: 12 }}>本批提案已应用</strong>
                  <span style={{ fontSize: 10.5, color: "var(--emerald)" }}>不影响后续手工微调</span>
                </div>
                <button
                  type="button"
                  className="fc-btn fc-btn-sm fc-btn-danger"
                  disabled={applying}
                  onClick={onRevertProposal}
                >
                  {applying ? "精准回退中..." : "撤销此批方案 / 生图并记住偏好"}
                </button>
              </div>
            )}

            {run.proposal?.reverted && (
              <div style={{ fontSize: 11.5, color: "var(--text-muted)", flexShrink: 0 }}>
                此批提案已精准回退，并已写入本画布避坑记忆。
              </div>
            )}

            {(run.status === "queued" || run.status === "running") && (
              <button
                type="button"
                className="fc-btn fc-btn-sm"
                style={{ flexShrink: 0 }}
                onClick={onCancelRun}
              >
                停止本次运行
              </button>
            )}
            {(run.status === "failed" || run.status === "canceled") && (
              <button
                type="button"
                className="fc-btn fc-btn-sm"
                style={{ flexShrink: 0 }}
                onClick={onRetryRun}
              >
                重试运行
              </button>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
