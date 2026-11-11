import { api, ApiError, type ImageProviderType, type User } from "@canvas/api-client";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { StudioHeader } from "../components/StudioHeader";

const IMAGE_PROVIDER_PRESETS: Record<
  ImageProviderType,
  { baseUrl: string; modelName: string; hint: string }
> = {
  dashscope: {
    baseUrl: "https://dashscope.aliyuncs.com/api/v1",
    modelName: "qwen-image-2.0",
    hint: "阿里百炼原生多模态生成/融合，支持 1-3 张参考图（图1/图2/图3），auto 保留末图比例。",
  },
  "openai-compatible": {
    baseUrl: "https://api.openai.com/v1",
    modelName: "gpt-image-1",
    hint: "OpenAI 官方及兼容网关，支持 /images/generations 与多达 16 张 /images/edits 透明背景编辑。",
  },
  siliconflow: {
    baseUrl: "https://api.siliconflow.cn/v1",
    modelName: "Kwai-Kolors/Kolors",
    hint: "硅基流动兼容端点，支持 0-1 张参考图生图。",
  },
};

export function AgentSettingsPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const sourceCanvasId = searchParams.get("canvasId");

  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  // LLM Config
  const [chatBaseUrl, setChatBaseUrl] = useState("https://api.deepseek.com/v1");
  const [chatModel, setChatModel] = useState("deepseek-chat");
  const [chatContextTokens, setChatContextTokens] = useState(32768);
  const [chatKey, setChatKey] = useState("");
  const [chatConfigured, setChatConfigured] = useState(false);
  const [chatStatus, setChatStatus] = useState<string | null>(null);

  // Image Config
  const [imgProvider, setImgProvider] = useState<ImageProviderType>("dashscope");
  const [imgBaseUrl, setImgBaseUrl] = useState(IMAGE_PROVIDER_PRESETS.dashscope.baseUrl);
  const [imgModel, setImgModel] = useState(IMAGE_PROVIDER_PRESETS.dashscope.modelName);
  const [imgKey, setImgKey] = useState("");
  const [imgConfigured, setImgConfigured] = useState(false);
  const [imgStatus, setImgStatus] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const sess = await api.session();
        if (!active) return;
        if (!sess.user) {
          setUser(null);
          return;
        }
        setUser(sess.user);
        const [llm, img] = await Promise.all([api.getModelConfig(), api.getImageConfig()]);
        if (!active) return;
        setChatConfigured(llm.configured);
        if (llm.configured) {
          setChatBaseUrl(llm.base_url);
          setChatModel(llm.model_name);
          setChatContextTokens(llm.max_context_tokens || 32768);
        }
        setImgConfigured(img.configured);
        if (img.configured) {
          setImgProvider(img.provider);
          setImgBaseUrl(img.base_url);
          setImgModel(img.model_name);
        }
      } catch {
        if (active) setUser(null);
      } finally {
        if (active) setAuthChecked(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const inputStyle: React.CSSProperties = {
    height: 38,
    padding: "0 12px",
    borderRadius: 10,
    background: "var(--surface-input)",
    border: "1px solid var(--border-hairline)",
    fontSize: 12.5,
    outline: 0,
  };

  return (
    <div className="dotted-gallery-bg" style={{ paddingBottom: 64 }}>
      <StudioHeader
        active="settings"
        user={user}
        returnCanvasId={sourceCanvasId}
        rightSlot={
          sourceCanvasId ? (
            <button
              type="button"
              className="fc-btn fc-btn-sm fc-btn-obsidian"
              onClick={() => navigate(`/canvas/${sourceCanvasId}`)}
            >
              ← 返回原画布
            </button>
          ) : null
        }
      />

      <main style={{ width: "min(1080px, calc(100vw - 32px))", margin: "28px auto 0" }}>
        {!authChecked ? (
          <div style={{ padding: 24, fontSize: 12.5, color: "var(--text-muted)" }}>
            正在读取配置...
          </div>
        ) : !user ? (
          <div
            style={{
              borderRadius: 20,
              background: "var(--surface-solid)",
              border: "1px solid var(--border-hairline)",
              padding: "40px 24px",
              textAlign: "center",
              boxShadow: "var(--shadow-card)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 12,
            }}
          >
            <h2 style={{ fontFamily: "var(--font-serif)", fontSize: 22, margin: 0 }}>
              BYOK 密钥设置需要登录
            </h2>
            <p style={{ fontSize: 12.5, color: "var(--text-secondary)", margin: 0 }}>
              所有 API Key 使用 Fernet 加密存储在个人账号下，服务端绝不向前端回显明文。
            </p>
            <button
              type="button"
              className="fc-btn fc-btn-obsidian"
              onClick={() => navigate("/login?returnTo=/settings/agent")}
            >
              前往登录
            </button>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: 16 }}>
            {/* LLM / Agent Config */}
            <section
              style={{
                background: "var(--surface-solid)",
                border: "1px solid var(--border-hairline)",
                borderRadius: 18,
                padding: 22,
                boxShadow: "var(--shadow-card)",
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <strong style={{ fontSize: 15 }}>对话与 Agent 推理模型（BYOK）</strong>
                <span
                  style={{
                    fontSize: 11,
                    padding: "2px 8px",
                    borderRadius: 99,
                    background: chatConfigured ? "var(--emerald-soft)" : "var(--surface-muted)",
                    color: chatConfigured ? "#047857" : "var(--text-muted)",
                  }}
                >
                  {chatConfigured ? "已配置" : "未配置"}
                </span>
              </div>
              <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: 0, lineHeight: 1.55 }}>
                驱动 Coordinator / Planner / Canvas Editor / Reviewer 四角色工作流（支持 DeepSeek、OpenAI 及兼容 HTTPS 接口）。
              </p>

              <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12 }}>
                <span style={{ color: "var(--text-secondary)" }}>HTTPS Base URL</span>
                <input
                  style={inputStyle}
                  value={chatBaseUrl}
                  onChange={(e) => setChatBaseUrl(e.target.value)}
                />
              </label>

              <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12 }}>
                <span style={{ color: "var(--text-secondary)" }}>默认模型名</span>
                <input
                  style={inputStyle}
                  value={chatModel}
                  onChange={(e) => setChatModel(e.target.value)}
                />
              </label>

              <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12 }}>
                <span style={{ color: "var(--text-secondary)" }}>
                  上下文窗口预算（Harness 达到 65% 自动压缩历史记忆）
                </span>
                <select
                  style={inputStyle}
                  value={chatContextTokens}
                  onChange={(e) => setChatContextTokens(Number(e.target.value))}
                >
                  <option value={8192}>8,192 tokens（小上下文模型）</option>
                  <option value={32768}>32,768 tokens（推荐 · DeepSeek / Qwen）</option>
                  <option value={65536}>65,536 tokens（长窗口）</option>
                  <option value={128000}>128,000 tokens（GPT-4o / 128K+）</option>
                </select>
              </label>

              <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12 }}>
                <span style={{ color: "var(--text-secondary)" }}>
                  API Key（{chatConfigured ? "留空则保留现有加密密钥" : "首次保存必填"}）
                </span>
                <input
                  type="password"
                  style={inputStyle}
                  value={chatKey}
                  placeholder={chatConfigured ? "••••••••••••••••" : "sk-..."}
                  onChange={(e) => setChatKey(e.target.value)}
                />
              </label>

              {chatStatus && (
                <div style={{ fontSize: 12, color: "var(--sapphire)", background: "var(--sapphire-soft)", padding: "7px 10px", borderRadius: 8 }}>
                  {chatStatus}
                </div>
              )}

              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <button
                  type="button"
                  className="fc-btn"
                  onClick={async () => {
                    setChatStatus("正在探测模型连通性...");
                    try {
                      const res = await api.testModelConfig({
                        provider: "openai-compatible",
                        base_url: chatBaseUrl,
                        model_name: chatModel,
                        api_key: chatKey,
                      });
                      setChatStatus(res.message);
                    } catch (err) {
                      setChatStatus(err instanceof ApiError ? err.message : "连接失败");
                    }
                  }}
                >
                  测试连接
                </button>
                <button
                  type="button"
                  className="fc-btn fc-btn-obsidian"
                  onClick={async () => {
                    try {
                      await api.saveModelConfig({
                        provider: "openai-compatible",
                        base_url: chatBaseUrl,
                        model_name: chatModel,
                        api_key: chatKey || undefined,
                        role_models: {},
                        max_context_tokens: chatContextTokens,
                      });
                      setChatConfigured(true);
                      setChatKey("");
                      setChatStatus("语言模型配置已 Fernet 加密保存");
                    } catch (err) {
                      setChatStatus(err instanceof ApiError ? err.message : "保存失败");
                    }
                  }}
                >
                  保存配置
                </button>
              </div>
            </section>

            {/* Image Generation Provider Config */}
            <section
              style={{
                background: "var(--surface-solid)",
                border: "1px solid var(--border-hairline)",
                borderRadius: 18,
                padding: 22,
                boxShadow: "var(--shadow-card)",
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <strong style={{ fontSize: 15 }}>AI 生图与改图接口（BYOK）</strong>
                <span
                  style={{
                    fontSize: 11,
                    padding: "2px 8px",
                    borderRadius: 99,
                    background: imgConfigured ? "var(--emerald-soft)" : "var(--surface-muted)",
                    color: imgConfigured ? "#047857" : "var(--text-muted)",
                  }}
                >
                  {imgConfigured ? "已配置" : "未配置"}
                </span>
              </div>
              <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: 0, lineHeight: 1.55 }}>
                {IMAGE_PROVIDER_PRESETS[imgProvider].hint}
              </p>

              <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12 }}>
                <span style={{ color: "var(--text-secondary)" }}>生图服务商适配器</span>
                <select
                  style={inputStyle}
                  value={imgProvider}
                  onChange={(e) => {
                    const next = e.target.value as ImageProviderType;
                    setImgProvider(next);
                    setImgBaseUrl(IMAGE_PROVIDER_PRESETS[next].baseUrl);
                    setImgModel(IMAGE_PROVIDER_PRESETS[next].modelName);
                  }}
                >
                  <option value="dashscope">阿里百炼 DashScope (qwen-image-2.0 · 1-3 图融合)</option>
                  <option value="openai-compatible">OpenAI Image (/generations & /edits 多图)</option>
                  <option value="siliconflow">硅基流动 SiliconFlow (Kolors / Qwen-Image)</option>
                </select>
              </label>

              <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12 }}>
                <span style={{ color: "var(--text-secondary)" }}>HTTPS 接口地址</span>
                <input
                  style={inputStyle}
                  value={imgBaseUrl}
                  onChange={(e) => setImgBaseUrl(e.target.value)}
                />
              </label>

              <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12 }}>
                <span style={{ color: "var(--text-secondary)" }}>默认生图模型名</span>
                <input
                  style={inputStyle}
                  value={imgModel}
                  onChange={(e) => setImgModel(e.target.value)}
                />
              </label>

              <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12 }}>
                <span style={{ color: "var(--text-secondary)" }}>
                  API Key（{imgConfigured ? "留空则保留现有加密密钥" : "首次保存必填"}）
                </span>
                <input
                  type="password"
                  style={inputStyle}
                  value={imgKey}
                  placeholder={imgConfigured ? "••••••••••••••••" : "sk-..."}
                  onChange={(e) => setImgKey(e.target.value)}
                />
              </label>

              {imgStatus && (
                <div style={{ fontSize: 12, color: "var(--sapphire)", background: "var(--sapphire-soft)", padding: "7px 10px", borderRadius: 8 }}>
                  {imgStatus}
                </div>
              )}

              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <button
                  type="button"
                  className="fc-btn"
                  onClick={async () => {
                    setImgStatus("正在测试生图接口鉴权...");
                    try {
                      const res = await api.testImageConfig({
                        provider: imgProvider,
                        base_url: imgBaseUrl,
                        model_name: imgModel,
                        api_key: imgKey,
                      });
                      setImgStatus(res.message);
                    } catch (err) {
                      setImgStatus(err instanceof ApiError ? err.message : "生图接口连接失败");
                    }
                  }}
                >
                  测试生图接口
                </button>
                <button
                  type="button"
                  className="fc-btn fc-btn-obsidian"
                  onClick={async () => {
                    try {
                      await api.saveImageConfig({
                        provider: imgProvider,
                        base_url: imgBaseUrl,
                        model_name: imgModel,
                        api_key: imgKey || undefined,
                      });
                      setImgConfigured(true);
                      setImgKey("");
                      setImgStatus("生图服务配置已 Fernet 加密保存");
                    } catch (err) {
                      setImgStatus(err instanceof ApiError ? err.message : "保存失败");
                    }
                  }}
                >
                  保存生图配置
                </button>
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
