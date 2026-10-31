import { Check, CircleHelp, ExternalLink, Eye, KeyRound, Leaf, Play, Save, Server, ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api, ApiError } from "@canvas/api-client";
import { AppHeader } from "../components/AppHeader";

const agentRoles = [
  { name: "Coordinator", description: "理解目标、安排任务和汇总结果", model: "gpt-4o-mini", tone: "role-green" },
  { name: "Planner", description: "规划画面结构与创作步骤", model: "gpt-4o-mini", tone: "role-sand" },
  { name: "Canvas Editor", description: "提出允许的画布增删改操作", model: "gpt-4o-mini", tone: "role-lilac" },
  { name: "Reviewer", description: "检查层级、重叠和操作安全", model: "gpt-4o-mini", tone: "role-blue" },
];

export function AgentSettingsPage() {
  const [connected, setConnected] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [modelName, setModelName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    api.getModelConfig().then((config) => {
      setBaseUrl(config.base_url);
      setModelName(config.model_name);
      setSaved(config.configured);
    }).catch((cause) => setMessage(cause instanceof ApiError ? cause.message : "无法连接服务端。"));
  }, []);

  function modelInput(includeKey: boolean) {
    return {
      provider: "openai-compatible" as const,
      base_url: baseUrl,
      model_name: modelName,
      ...(includeKey ? { api_key: apiKey } : {}),
    };
  }

  async function testConnection() {
    setBusy(true);
    setConnected(false);
    setMessage("");
    try {
      await api.testModelConfig(modelInput(true) as { provider: "openai-compatible"; base_url: string; model_name: string; api_key: string });
      setConnected(true);
      setMessage("模型服务连接成功。");
    } catch (cause) {
      setMessage(cause instanceof ApiError ? cause.message : "连接失败，请检查模型地址和服务状态。");
    } finally {
      setBusy(false);
    }
  }

  async function saveConfig() {
    setBusy(true);
    setMessage("");
    try {
      const result = await api.saveModelConfig(modelInput(Boolean(apiKey)));
      setSaved(result.configured);
      setApiKey("");
      setMessage("模型配置已加密保存到服务端。");
    } catch (cause) {
      setMessage(cause instanceof ApiError ? cause.message : "配置保存失败，请重试。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="settings-page dotted-page">
      <AppHeader />
      <main className="agent-settings-content">
        <div className="settings-title"><span className="eyebrow">个人工作区</span><h1>Agent 设置</h1><p>接入你自己的模型服务，为专属 Agent 提供规划和编辑能力。</p></div>
        <div className="agent-settings-layout">
          <aside className="agent-settings-rail">
            <button className="settings-nav-item active"><Server size={18} />模型接入</button>
            <button className="settings-nav-item"><CircleHelp size={18} />使用说明</button>
            <div className="agent-rail-foot"><ShieldCheck size={15} />接入后由服务端加密保存模型密钥</div>
          </aside>
          <section className="agent-settings-main">
            <div className="settings-card provider-card">
              <div className="settings-card-heading"><div><h2>语言模型接口</h2><p>配置你自己的 AI 服务。模型凭证仅用于你的 Agent。</p></div><span className="provider-tag"><Sparkles size={14} /> BYOK</span></div>
              <label className="form-field"><span>服务商 / 协议</span><select className="select-field" defaultValue="openai"><option value="openai">OpenAI 兼容接口</option><option value="other">其他兼容服务</option></select><small>选择支持 OpenAI API 格式的模型服务。</small></label>
              <label className="form-field"><span>API 地址</span><input className="text-field" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" /><small>输入服务商提供的 HTTPS 地址；本机和局域网地址会被拒绝。</small></label>
              <label className="form-field"><span>API 密钥</span><span className="field-shell"><KeyRound size={17} /><input value={apiKey} onChange={(event) => setApiKey(event.target.value)} type={showKey ? "text" : "password"} placeholder={saved ? "已配置；留空表示不更换" : "粘贴你的 API 密钥"} /><button className="field-action" type="button" onClick={() => setShowKey(!showKey)} aria-label="切换密钥显示"><Eye size={17} /></button></span><small>密钥只在服务端加密保存，不会回传到页面。</small></label>
              <label className="form-field"><span>模型名称</span><input className="text-field" value={modelName} onChange={(event) => setModelName(event.target.value)} placeholder="按服务商文档填写模型 ID" /><small>按服务商文档填写模型 ID。</small></label>
              <div className="provider-actions"><button className="button button-accent" disabled={busy} onClick={testConnection}><Play size={16} />测试连接</button><button className="button button-secondary" disabled={busy} onClick={saveConfig}><Save size={16} />保存配置</button><a className="help-link" href="https://platform.openai.com/docs/overview" target="_blank" rel="noreferrer"><CircleHelp size={15} />如何获取 API 地址和模型名称 <ExternalLink size={13} /></a></div>
              <div className={`connection-state ${connected ? "connection-good" : ""}`}><span className="connection-indicator">{connected ? <Check size={16} /> : null}</span><div><strong>{connected ? "连接成功" : saved ? "已配置" : "尚未测试"}</strong><p>{message || (connected ? "测试请求已发送到模型服务。" : "保存后，Worker 会通过服务端配置调用该模型。")}</p></div><span className="connection-note">{saved ? "密钥已配置" : "密钥不会在页面中回显"}</span></div>
              {message && !connected && <p className="form-error" role="alert">{message}</p>}
              {saved && connected && <p className="form-success"><ShieldCheck size={15} />服务端已保存模型配置。</p>}
            </div>
            <div className="roles-section">
              <div className="section-heading"><div><h2>Agent 角色</h2><p>不同角色可以共用模型，也可以单独指定。</p></div><button className="button button-quiet"><Leaf size={15} />角色说明</button></div>
              <div className="role-grid">{agentRoles.map((role) => <article className="role-card" key={role.name}><span className={`role-symbol ${role.tone}`}><Sparkles size={17} /></span><div className="role-info"><strong>{role.name}</strong><p>{role.description}</p><span className="role-model">{role.model}</span></div><button className="toggle-switch on" aria-label={`启用 ${role.name}`}><i /></button></article>)}</div>
              <p className="future-agent-note">Image Creator 等待你提供生图与改图接口文档后再接入，当前不会调用外部图像 API。</p>
            </div>
          </section>
        </div>
        <p className="settings-back"><Link to="/">返回我的画布</Link></p>
      </main>
    </div>
  );
}
