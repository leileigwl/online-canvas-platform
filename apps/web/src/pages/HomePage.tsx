import {
  api,
  ApiError,
  type CanvasSnapshot,
  type ImageModelConfig,
  type User,
} from "@canvas/api-client";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { StudioHeader } from "../components/StudioHeader";
import { CloseIcon, ImageIcon } from "../components/Icons";
import { buildSelectableImageModels } from "../lib/image-presets";
import {
  fileToPendingRef,
  type PendingHomeRef,
  setPendingHomeIntent,
} from "../lib/pending-intent";

export function HomePage() {
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [canvases, setCanvases] = useState<CanvasSnapshot[]>([]);
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const [imgConfigs, setImgConfigs] = useState<ImageModelConfig[]>([]);

  const [prompt, setPrompt] = useState("");
  const [localRefs, setLocalRefs] = useState<PendingHomeRef[]>([]);
  const [aspectRatio, setAspectRatio] = useState("3:4");
  const [model, setModel] = useState("gemini-2.5-flash-image");
  const [customModelMode, setCustomModelMode] = useState(false);

  const [blankModalOpen, setBlankModalOpen] = useState(false);
  const [blankName, setBlankName] = useState("未命名创意画布");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const notify = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 3200);
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
        const [projects, imgs] = await Promise.all([
          api.listProjects(),
          api.listImageConfigs().catch(() => [] as ImageModelConfig[]),
        ]);
        if (!active) return;
        const lists = await Promise.all(projects.map((p) => api.listCanvases(p.id)));
        if (!active) return;
        setProjectId(projects[0]?.id);
        setCanvases(lists.flat());
        setImgConfigs(imgs);
        if (imgs.length > 0) {
          const def = imgs.find((c) => c.is_default) || imgs[0];
          if (def.model_name) setModel(def.model_name);
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

  const handleSelectRefs = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    const converted = await Promise.all(files.slice(0, 3).map(fileToPendingRef));
    setLocalRefs((prev) => {
      const next = [...prev, ...converted].slice(0, 3);
      if (next.length >= 1) setAspectRatio("auto");
      return next;
    });
  };

  const handleConfirmBlank = async () => {
    const name = blankName.trim() || "未命名创意画布";
    if (!user) {
      setPendingHomeIntent({ kind: "blank", canvasName: name, createdAt: Date.now() });
      navigate("/login");
      return;
    }
    setBusy(true);
    try {
      const created = await api.createCanvas(name, projectId);
      setBlankModalOpen(false);
      navigate(`/canvas/${created.id}`);
    } catch (error) {
      notify(error instanceof ApiError ? error.message : "创建画布失败");
    } finally {
      setBusy(false);
    }
  };

  const handleGenerateAndEnter = async () => {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt && localRefs.length === 0) {
      notify("请先输入创作描述或添加参考图");
      return;
    }
    if (!user) {
      setPendingHomeIntent({
        kind: "generate",
        prompt: cleanPrompt,
        aspectRatio,
        model,
        refs: localRefs,
        createdAt: Date.now(),
      });
      navigate("/login");
      return;
    }

    setBusy(true);
    try {
      const uploadedAssets = [];
      for (const ref of localRefs) {
        const res = await fetch(ref.dataUrl);
        const blob = await res.blob();
        uploadedAssets.push(await api.uploadAsset(new File([blob], ref.name, { type: ref.mimeType })));
      }
      const created = await api.createCanvas(
        (cleanPrompt || "创意灵感画布").slice(0, 24),
        projectId,
      );
      const docItems = uploadedAssets.map((asset, idx) => ({
        id: `home-ref-${Date.now()}-${idx}`,
        type: "image" as const,
        x: -280 + idx * 240,
        y: -120,
        width: 210,
        height: Math.max(140, Math.round((210 * asset.height) / Math.max(1, asset.width))),
        title: asset.name,
        asset_id: asset.id,
        src: asset.src,
        visible: true,
      }));
      let rev = created.revision;
      if (docItems.length > 0) {
        const saved = await api.saveCanvas(
          created.id,
          rev,
          { schema_version: 1, items: docItems },
          created.viewport,
        );
        rev = saved.revision;
      }

      if (cleanPrompt) {
        try {
          const gen = await api.generateImage({
            prompt: cleanPrompt,
            reference_asset_ids: uploadedAssets.map((a) => a.id),
            model,
            quality: "auto",
            width: 1024,
            height: 1024,
            align_to_16: true,
            resolution: "auto",
            aspect_ratio: aspectRatio,
            transparent: false,
            input_fidelity: "high",
            count: 1,
          });
          const genItems = gen.images.map((asset, idx) => ({
            id: `home-gen-${Date.now()}-${idx}`,
            type: "image" as const,
            x: 160 + idx * 250,
            y: -120,
            width: 230,
            height: Math.max(150, Math.round((230 * asset.height) / Math.max(1, asset.width))),
            title: asset.name,
            asset_id: asset.id,
            src: asset.src,
            visible: true,
          }));
          await api.saveCanvas(
            created.id,
            rev,
            { schema_version: 1, items: [...docItems, ...genItems] },
            created.viewport,
          );
        } catch (genErr) {
          // If user hasn't configured BYOK image key yet, still open canvas gracefully and inform user.
          const msg = genErr instanceof ApiError ? genErr.message : "请先配置生图 API Key";
          navigate(`/canvas/${created.id}?notice=${encodeURIComponent(msg)}`);
          return;
        }
      }
      navigate(`/canvas/${created.id}`);
    } catch (error) {
      notify(error instanceof ApiError ? error.message : "创建画布失败");
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteCanvas = async (e: React.MouseEvent, id: string, title: string) => {
    e.stopPropagation();
    if (!window.confirm(`确定删除画布「${title}」吗？此操作无法撤销。`)) return;
    try {
      await api.deleteCanvas(id);
      setCanvases((prev) => prev.filter((c) => c.id !== id));
      notify(`已删除画布「${title}」`);
    } catch (error) {
      notify(error instanceof ApiError ? error.message : "删除画布失败");
    }
  };

  const selectableModels = buildSelectableImageModels(imgConfigs);
  const ratioList =
    localRefs.length === 0 ? ["3:4", "1:1", "4:3", "16:9"] : ["auto", "1:1", "3:4", "16:9"];
  const modeHint =
    localRefs.length === 0
      ? "纯文生图 · 支持自定义比例"
      : localRefs.length === 1
        ? "单图编辑 · 默认跟随图1比例"
        : `多图融合 (${localRefs.length}张)`;
  const showSetupLink = authChecked && (!user || imgConfigs.length === 0);

  return (
    <div className="dotted-gallery-bg" style={{ paddingBottom: 60 }}>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: "none" }}
        onChange={handleSelectRefs}
      />

      <StudioHeader active="home" user={user} />

      <main style={{ width: "min(1080px, calc(100vw - 32px))", margin: "34px auto 0" }}>
        <section
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            textAlign: "center",
            gap: 16,
            padding: "20px 0 34px",
          }}
        >
          <span
            style={{
              padding: "4px 12px",
              borderRadius: 99,
              border: "1px solid var(--border-hairline)",
              background: "var(--surface-solid)",
              fontSize: 11.5,
              color: "var(--text-secondary)",
            }}
          >
            AI 无限画布 · 直接生图改图 · LangGraph 创意 Agent
          </span>

          <h1
            style={{
              fontFamily: "var(--font-serif)",
              fontSize: "clamp(28px, 4vw, 40px)",
              fontWeight: 700,
              letterSpacing: "-0.6px",
              lineHeight: 1.18,
              margin: 0,
            }}
          >
            从一张参考图或一句灵感开始创作
          </h1>
          <p
            style={{
              fontSize: 13.5,
              color: "var(--text-secondary)",
              maxWidth: 560,
              lineHeight: 1.65,
              margin: 0,
            }}
          >
            支持直接上传 0 / 1 / 2 张参考图并按图数动态配置比例参数进入画布，也可命名新建完全空白的无限画布。
          </p>

          <div
            style={{
              width: "min(700px, 100%)",
              background: "var(--surface-solid)",
              border: "1px solid var(--border-hairline)",
              borderRadius: 20,
              padding: "14px 16px",
              boxShadow: "var(--shadow-float)",
              display: "flex",
              flexDirection: "column",
              gap: 10,
              textAlign: "left",
            }}
          >
            {localRefs.length > 0 && (
              <div className="ref-strip">
                {localRefs.map((ref, idx) => (
                  <span key={`${ref.name}-${idx}`} className="ref-chip">
                    <img src={ref.dataUrl} alt="" />
                    <span className="ref-idx">图{idx + 1}</span>
                    <span>{ref.name}</span>
                    <button
                      type="button"
                      onClick={() =>
                        setLocalRefs((prev) => prev.filter((_, i) => i !== idx))
                      }
                      style={{ color: "var(--text-muted)" }}
                    >
                      ×
                    </button>
                  </span>
                ))}
                <button
                  type="button"
                  className="clear-refs-btn"
                  onClick={() => setLocalRefs([])}
                >
                  清空参考
                </button>
              </div>
            )}

            <textarea
              className="prompt-input"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="输入创作目标（如：把图1的香氛瓶放到图2混凝土阳光走廊中，保留暖晨斜光）..."
            />

            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="param-btn"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <ImageIcon size={13} />
                  <span>+ 添加参考图 ({localRefs.length}张)</span>
                </button>
                <select
                  className="param-btn"
                  value={aspectRatio}
                  onChange={(e) => setAspectRatio(e.target.value)}
                  style={{ outline: 0 }}
                >
                  {ratioList.map((r) => (
                    <option key={r} value={r}>
                      {r === "auto"
                        ? localRefs.length <= 1
                          ? "比例 跟随图1"
                          : "比例 跟随末图"
                        : `比例 ${r}`}
                    </option>
                  ))}
                </select>
                <select
                  className="param-btn"
                  value={customModelMode ? "__custom__" : model}
                  onChange={(e) => {
                    if (e.target.value === "__custom__") {
                      setCustomModelMode(true);
                      return;
                    }
                    setCustomModelMode(false);
                    setModel(e.target.value);
                  }}
                  style={{ outline: 0, maxWidth: 210 }}
                >
                  {selectableModels.map((item) => (
                    <option key={`${item.configId || "preset"}-${item.id}`} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                  <option value="__custom__">自定义模型 ID...</option>
                </select>
                {customModelMode && (
                  <input
                    className="param-btn"
                    style={{ width: 164, outline: 0, background: "#fff" }}
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="输入模型 ID"
                  />
                )}
                <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{modeHint}</span>
                {showSetupLink && (
                  <button
                    type="button"
                    onClick={() =>
                      navigate(user ? "/settings/agent" : "/login?returnTo=/settings/agent")
                    }
                    style={{
                      fontSize: 11.5,
                      color: "var(--text-secondary)",
                      textDecoration: "underline",
                      textUnderlineOffset: 3,
                    }}
                  >
                    去配置生图模型 →
                  </button>
                )}
              </div>

              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  className="fc-btn"
                  onClick={() => {
                    setBlankName("未命名创意画布");
                    setBlankModalOpen(true);
                  }}
                >
                  + 新建空白画布
                </button>
                <button
                  type="button"
                  className="fc-btn fc-btn-obsidian"
                  disabled={busy}
                  onClick={handleGenerateAndEnter}
                >
                  {busy ? "处理中..." : "生成并进入画布 →"}
                </button>
              </div>
            </div>
          </div>
        </section>

        <section>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 14,
            }}
          >
            <strong style={{ fontSize: 15 }}>我的画布空间</strong>
            {user && (
              <button
                type="button"
                className="fc-btn fc-btn-sm"
                onClick={() => {
                  setBlankName("未命名创意画布");
                  setBlankModalOpen(true);
                }}
              >
                + 新建空白画布
              </button>
            )}
          </div>

          {!authChecked ? (
            <div style={{ fontSize: 12.5, color: "var(--text-muted)", padding: 24 }}>
              正在检查登录状态...
            </div>
          ) : !user ? (
            <div
              style={{
                borderRadius: 20,
                background: "var(--surface-solid)",
                border: "1px solid var(--border-hairline)",
                padding: "36px 24px",
                textAlign: "center",
                boxShadow: "var(--shadow-card)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 12,
              }}
            >
              <h3 style={{ fontFamily: "var(--font-serif)", fontSize: 20, margin: 0 }}>
                登录后访问你的云端画布与私有素材库
              </h3>
              <p
                style={{
                  fontSize: 12.5,
                  color: "var(--text-secondary)",
                  maxWidth: 440,
                  lineHeight: 1.6,
                  margin: 0,
                }}
              >
                未登录状态下可在上方输入灵感与参考图；点击「新建空白画布」或「生成并进入画布」将引导登录并在完成后自动续接创建。
              </p>
              <button
                type="button"
                className="fc-btn fc-btn-obsidian"
                onClick={() => navigate("/login")}
              >
                登录 / 注册账号
              </button>
            </div>
          ) : canvases.length === 0 ? (
            <div
              style={{
                borderRadius: 16,
                background: "var(--surface-solid)",
                border: "1px solid var(--border-hairline)",
                padding: 28,
                textAlign: "center",
                fontSize: 13,
                color: "var(--text-secondary)",
              }}
            >
              还没有画布，点击右上角「+ 新建空白画布」开始第一个项目吧。
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
                gap: 14,
              }}
            >
              {canvases.map((canvas) => {
                const firstImg = canvas.document.items.find((i) => i.type === "image" && i.src);
                return (
                  <article
                    key={canvas.id}
                    onClick={() => navigate(`/canvas/${canvas.id}`)}
                    style={{
                      background: "var(--surface-solid)",
                      border: "1px solid var(--border-hairline)",
                      borderRadius: 14,
                      overflow: "hidden",
                      cursor: "pointer",
                      boxShadow: "var(--shadow-card)",
                    }}
                  >
                    {firstImg?.src ? (
                      <img
                        src={firstImg.src}
                        alt={canvas.name}
                        style={{
                          width: "100%",
                          height: 152,
                          objectFit: "cover",
                          display: "block",
                          background: "var(--bg-ivory-2)",
                        }}
                      />
                    ) : (
                      <div
                        style={{
                          width: "100%",
                          height: 152,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          background: "var(--bg-ivory-2)",
                          color: "var(--text-muted)",
                          fontSize: 12,
                        }}
                      >
                        {canvas.document.items.length > 0
                          ? `${canvas.document.items.length} 个创意元素`
                          : "空白画布"}
                      </div>
                    )}
                    <div
                      style={{
                        padding: "12px 14px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <strong
                          style={{
                            fontSize: 13.5,
                            display: "block",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {canvas.name}
                        </strong>
                        <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                          {canvas.document.items.length} 个对象 · v{canvas.revision}
                        </span>
                      </div>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button
                          type="button"
                          className="fc-btn fc-btn-sm fc-btn-danger"
                          onClick={(e) => handleDeleteCanvas(e, canvas.id, canvas.name)}
                        >
                          删除
                        </button>
                        <span className="fc-btn fc-btn-sm">进入</span>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </main>

      {blankModalOpen && (
        <div
          className="fc-modal-backdrop"
          onClick={(e) => e.target === e.currentTarget && setBlankModalOpen(false)}
        >
          <div className="fc-modal-box">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong>新建空白画布</strong>
              <button
                type="button"
                className="fc-icon-btn"
                style={{ width: 28, height: 28 }}
                onClick={() => setBlankModalOpen(false)}
              >
                <CloseIcon />
              </button>
            </div>
            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
              <span style={{ color: "var(--text-secondary)" }}>
                画布名称（进入后仍可点击顶部标题随时修改）
              </span>
              <input
                autoFocus
                value={blankName}
                onChange={(e) => setBlankName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleConfirmBlank()}
                style={{
                  height: 38,
                  padding: "0 12px",
                  borderRadius: 10,
                  border: "1px solid var(--border-hairline)",
                  background: "var(--surface-input)",
                  outline: 0,
                }}
              />
            </label>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                className="fc-btn"
                onClick={() => setBlankModalOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="fc-btn fc-btn-obsidian"
                disabled={busy}
                onClick={handleConfirmBlank}
              >
                {busy ? "创建中..." : "创建空白画布"}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="fc-toast">{toast}</div>}
    </div>
  );
}
