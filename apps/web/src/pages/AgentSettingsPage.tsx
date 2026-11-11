import {
  api,
  ApiError,
  type ImageModelConfig,
  type ImageProviderType,
  type User,
} from "@canvas/api-client";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { StudioHeader } from "../components/StudioHeader";
import { IMAGE_PROVIDER_ORDER, IMAGE_PROVIDER_PRESETS } from "../lib/image-presets";

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

  // Image Configs (multi-provider profiles)
  const [imgConfigs, setImgConfigs] = useState<ImageModelConfig[]>([]);
  const [editingImgId, setEditingImgId] = useState<string | null>(null);
  const [imgLabel, setImgLabel] = useState("Nano Banana 默认");
  const [imgProvider, setImgProvider] = useState<ImageProviderType>("google-gemini");
  const [imgBaseUrl, setImgBaseUrl] = useState(
    IMAGE_PROVIDER_PRESETS["google-gemini"].baseUrl,
  );
  const [imgModel, setImgModel] = useState(
    IMAGE_PROVIDER_PRESETS["google-gemini"].defaultModel,
  );
  const [imgIsDefault, setImgIsDefault] = useState(true);
  const [imgKey, setImgKey] = useState("");
  const [imgStatus, setImgStatus] = useState<string | null>(null);

  const applyConfigToForm = (cfg: ImageModelConfig) => {
    setEditingImgId(cfg.id ?? null);
    setImgLabel(cfg.label || `${cfg.provider} · ${cfg.model_name}`);
    setImgProvider(cfg.provider);
    setImgBaseUrl(cfg.base_url);
    setImgModel(cfg.model_name);
    setImgIsDefault(cfg.is_default);
    setImgKey("");
  };

  const resetNewImgForm = (provider: ImageProviderType = "google-gemini") => {
    const preset = IMAGE_PROVIDER_PRESETS[provider];
    setEditingImgId(null);
    setImgProvider(provider);
    setImgBaseUrl(preset.baseUrl);
    setImgModel(preset.defaultModel);
    setImgLabel(preset.models[0]?.label || preset.defaultModel);
    setImgIsDefault(imgConfigs.length === 0);
    setImgKey("");
  };

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
        const [llm, imgs] = await Promise.all([api.getModelConfig(), api.listImageConfigs()]);
        if (!active) return;
        setChatConfigured(llm.configured);
        if (llm.configured) {
          setChatBaseUrl(llm.base_url);
          setChatModel(llm.model_name);
          setChatContextTokens(llm.max_context_tokens || 32768);
        }
        setImgConfigs(imgs);
        if (imgs.length > 0) {
          const def = imgs.find((c) => c.is_default) || imgs[0];
          applyConfigToForm(def);
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

            {/* Multi-Provider Image Generation Config */}
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
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <strong style={{ fontSize: 15 }}>AI 生图与改图接口（BYOK 多配置）</strong>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span
                    style={{
                      fontSize: 11,
                      padding: "2px 8px",
                      borderRadius: 99,
                      background: imgConfigs.length > 0 ? "var(--emerald-soft)" : "var(--surface-muted)",
                      color: imgConfigs.length > 0 ? "#047857" : "var(--text-muted)",
                    }}
                  >
                    {imgConfigs.length > 0 ? `已配 ${imgConfigs.length} 组` : "未配置"}
                  </span>
                  {editingImgId && (
                    <button
                      type="button"
                      className="fc-btn fc-btn-sm"
                      onClick={() => resetNewImgForm(imgProvider)}
                    >
                      + 新增配置
                    </button>
                  )}
                </div>
              </div>

              {imgConfigs.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {imgConfigs.map((cfg) => {
                    const active = editingImgId === cfg.id;
                    return (
                      <div
                        key={cfg.id || `${cfg.provider}-${cfg.model_name}`}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 8,
                          padding: "8px 10px",
                          borderRadius: 10,
                          border: active
                            ? "1.5px solid var(--sapphire)"
                            : "1px solid var(--border-hairline)",
                          background: active ? "var(--sapphire-soft)" : "var(--surface-input)",
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => applyConfigToForm(cfg)}
                          style={{
                            flex: 1,
                            textAlign: "left",
                            display: "flex",
                            flexDirection: "column",
                            gap: 2,
                            minWidth: 0,
                          }}
                        >
                          <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-primary)" }}>
                            {cfg.label || cfg.model_name}
                            {cfg.is_default ? " · 默认" : ""}
                          </span>
                          <span style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {cfg.provider} · {cfg.model_name}
                          </span>
                        </button>
                        {!cfg.is_default && cfg.id && (
                          <button
                            type="button"
                            className="fc-btn fc-btn-sm"
                            onClick={async () => {
                              try {
                                await api.updateImageConfig(cfg.id!, {
                                  label: cfg.label,
                                  provider: cfg.provider,
                                  base_url: cfg.base_url,
                                  model_name: cfg.model_name,
                                  is_default: true,
                                });
                                const list = await api.listImageConfigs();
                                setImgConfigs(list);
                                setImgStatus(`已将「${cfg.label || cfg.model_name}」设为默认生图模型`);
                              } catch (err) {
                                setImgStatus(err instanceof ApiError ? err.message : "设置默认失败");
                              }
                            }}
                          >
                            设为默认
                          </button>
                        )}
                        {cfg.id && (
                          <button
                            type="button"
                            className="fc-btn fc-btn-sm fc-btn-danger"
                            onClick={async () => {
                              try {
                                await api.deleteImageConfig(cfg.id!);
                                const list = await api.listImageConfigs();
                                setImgConfigs(list);
                                if (list.length > 0) applyConfigToForm(list[0]);
                                else resetNewImgForm("google-gemini");
                                setImgStatus("已移除该生图配置");
                              } catch (err) {
                                setImgStatus(err instanceof ApiError ? err.message : "删除失败");
                              }
                            }}
                          >
                            删除
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: 0, lineHeight: 1.55 }}>
                {IMAGE_PROVIDER_PRESETS[imgProvider].hint}
              </p>

              <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12 }}>
                <span style={{ color: "var(--text-secondary)" }}>生图协议适配器</span>
                <select
                  style={inputStyle}
                  value={imgProvider}
                  onChange={(e) => {
                    const next = e.target.value as ImageProviderType;
                    const preset = IMAGE_PROVIDER_PRESETS[next];
                    setImgProvider(next);
                    setImgBaseUrl(preset.baseUrl);
                    setImgModel(preset.defaultModel);
                    if (!editingImgId) setImgLabel(preset.models[0]?.label || preset.defaultModel);
                  }}
                >
                  {IMAGE_PROVIDER_ORDER.map((prov) => (
                    <option key={prov} value={prov}>
                      {IMAGE_PROVIDER_PRESETS[prov].title}
                    </option>
                  ))}
                </select>
              </label>

              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {IMAGE_PROVIDER_PRESETS[imgProvider].models.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={`chip-btn ${imgModel === m.id ? "active" : ""}`}
                    onClick={() => {
                      setImgModel(m.id);
                      if (!editingImgId) setImgLabel(m.label);
                    }}
                  >
                    {m.label}
                  </button>
                ))}
              </div>

              <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12 }}>
                <span style={{ color: "var(--text-secondary)" }}>配置名称标签</span>
                <input
                  style={inputStyle}
                  value={imgLabel}
                  onChange={(e) => setImgLabel(e.target.value)}
                  placeholder="例如：Google Nano Banana / 公司 OneAPI 网关"
                />
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
                <span style={{ color: "var(--text-secondary)" }}>默认生图模型名（支持任意自定义 Model ID）</span>
                <input
                  style={inputStyle}
                  value={imgModel}
                  onChange={(e) => setImgModel(e.target.value)}
                />
              </label>

              <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12 }}>
                <span style={{ color: "var(--text-secondary)" }}>
                  API Key（{editingImgId ? "留空则保留当前配置已加密密钥" : "新增配置必填"}）
                </span>
                <input
                  type="password"
                  style={inputStyle}
                  value={imgKey}
                  placeholder={
                    editingImgId
                      ? "••••••••••••••••"
                      : IMAGE_PROVIDER_PRESETS[imgProvider].keyPlaceholder
                  }
                  onChange={(e) => setImgKey(e.target.value)}
                />
              </label>

              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-secondary)" }}>
                <input
                  type="checkbox"
                  checked={imgIsDefault}
                  onChange={(e) => setImgIsDefault(e.target.checked)}
                />
                设为默认生图配置（生成时选 auto 自动优先使用此配置）
              </label>

              {imgStatus && (
                <div style={{ fontSize: 12, color: "var(--sapphire)", background: "var(--sapphire-soft)", padding: "7px 10px", borderRadius: 8 }}>
                  {imgStatus}
                </div>
              )}

              <div style={{ display: "flex", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="fc-btn"
                  onClick={async () => {
                    setImgStatus("正在测试生图接口鉴权...");
                    try {
                      const res = await api.testImageConfig({
                        id: editingImgId || undefined,
                        label: imgLabel,
                        provider: imgProvider,
                        base_url: imgBaseUrl,
                        model_name: imgModel,
                        api_key: imgKey || undefined,
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
                      const payload = {
                        label: imgLabel,
                        provider: imgProvider,
                        base_url: imgBaseUrl,
                        model_name: imgModel,
                        api_key: imgKey || undefined,
                        is_default: imgIsDefault,
                      };
                      const saved = editingImgId
                        ? await api.updateImageConfig(editingImgId, payload)
                        : await api.createImageConfig(payload);
                      const list = await api.listImageConfigs();
                      setImgConfigs(list);
                      applyConfigToForm(saved);
                      setImgStatus("生图服务配置已 Fernet 加密保存");
                    } catch (err) {
                      setImgStatus(err instanceof ApiError ? err.message : "保存失败");
                    }
                  }}
                >
                  {editingImgId ? "保存生图配置" : "添加并保存生图配置"}
                </button>
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
