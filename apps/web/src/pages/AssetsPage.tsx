import { api, ApiError, type Asset, type User } from "@canvas/api-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { StudioHeader } from "../components/StudioHeader";

export function AssetsPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const sourceCanvasId = searchParams.get("canvasId");

  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [search, setSearch] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const notify = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 3000);
  };

  const refreshAssets = useCallback(async (q = "") => {
    const list = await api.listAssets(q);
    setAssets(list);
  }, []);

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
        const list = await api.listAssets("");
        if (active) setAssets(list);
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

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    try {
      for (const f of files) {
        await api.uploadAsset(f);
      }
      await refreshAssets(search);
      notify(`已上传 ${files.length} 个素材到云端私有库`);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "上传图片失败");
    }
  };

  const handleInsertAndReturn = (asset: Asset) => {
    if (sourceCanvasId) {
      navigate(`/canvas/${sourceCanvasId}?insertAssetId=${encodeURIComponent(asset.id)}`);
      return;
    }
    notify("当前尚未绑定来源画布，请从某个画布点击「素材库」进入或新建画布。");
  };

  const handleToggleFavorite = async (asset: Asset) => {
    try {
      const updated = await api.setFavorite(asset.id, !asset.favorite);
      setAssets((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
    } catch {
      notify("收藏状态更新失败");
    }
  };

  const handleKeepTemporary = async (asset: Asset) => {
    try {
      const saved = await api.saveGeneratedAsset(asset.id);
      setAssets((prev) => prev.map((a) => (a.id === saved.id ? saved : a)));
      notify("已转为永久素材");
    } catch {
      notify("保存素材失败");
    }
  };

  return (
    <div className="dotted-gallery-bg" style={{ paddingBottom: 60 }}>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: "none" }}
        onChange={handleUpload}
      />

      <StudioHeader
        active="assets"
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
            正在加载素材库...
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
              个人私有素材库需要登录
            </h2>
            <p style={{ fontSize: 12.5, color: "var(--text-secondary)", margin: 0 }}>
              所有素材加密隔离存储在当前账号名下的 MinIO 私有空间中。
            </p>
            <button
              type="button"
              className="fc-btn fc-btn-obsidian"
              onClick={() => navigate("/login?returnTo=/assets")}
            >
              前往登录
            </button>
          </div>
        ) : (
          <>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-end",
                gap: 12,
                flexWrap: "wrap",
                marginBottom: 18,
              }}
            >
              <div>
                <h1 style={{ fontFamily: "var(--font-serif)", fontSize: 26, margin: "0 0 4px" }}>
                  我的云端素材库
                </h1>
                <p style={{ fontSize: 12.5, color: "var(--text-secondary)", margin: 0 }}>
                  {sourceCanvasId
                    ? "已记录来源画布：上传或点击任意素材上的「上画布」，将自动带入刚才的画布。"
                    : "支持搜索、收藏与转存 AI 生成临时图片。"}
                </p>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  value={search}
                  onChange={(e) => {
                    const q = e.target.value;
                    setSearch(q);
                    void refreshAssets(q);
                  }}
                  placeholder="搜索素材名称..."
                  style={{
                    height: 36,
                    width: 210,
                    padding: "0 12px",
                    borderRadius: 10,
                    background: "var(--surface-solid)",
                    border: "1px solid var(--border-hairline)",
                    fontSize: 12.5,
                    outline: 0,
                  }}
                />
                <button
                  type="button"
                  className="fc-btn fc-btn-obsidian"
                  onClick={() => fileRef.current?.click()}
                >
                  + 上传本地图片
                </button>
              </div>
            </div>

            {assets.length === 0 ? (
              <div
                style={{
                  padding: 36,
                  borderRadius: 18,
                  background: "var(--surface-solid)",
                  border: "1px solid var(--border-hairline)",
                  textAlign: "center",
                  fontSize: 13,
                  color: "var(--text-secondary)",
                }}
              >
                当前还没有素材，点击右上「+ 上传本地图片」开始收藏参考图吧。
              </div>
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(225px, 1fr))",
                  gap: 14,
                }}
              >
                {assets.map((asset) => (
                  <article
                    key={asset.id}
                    style={{
                      background: "var(--surface-solid)",
                      border: "1px solid var(--border-hairline)",
                      borderRadius: 14,
                      overflow: "hidden",
                      boxShadow: "var(--shadow-card)",
                      display: "flex",
                      flexDirection: "column",
                    }}
                  >
                    <img
                      src={asset.src}
                      alt={asset.name}
                      style={{
                        width: "100%",
                        height: 174,
                        objectFit: "cover",
                        display: "block",
                        background: "var(--bg-ivory-2)",
                      }}
                    />
                    <div
                      style={{
                        padding: "10px 12px",
                        display: "flex",
                        flexDirection: "column",
                        gap: 8,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                        <strong
                          style={{
                            fontSize: 12.5,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {asset.name}
                        </strong>
                        <button
                          type="button"
                          onClick={() => handleToggleFavorite(asset)}
                          style={{
                            fontSize: 11,
                            color: asset.favorite ? "var(--sapphire)" : "var(--text-muted)",
                          }}
                        >
                          {asset.favorite ? "已收藏" : "收藏"}
                        </button>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                          {asset.width} × {asset.height}
                        </span>
                        <div style={{ display: "flex", gap: 6 }}>
                          {asset.temporary && (
                            <button
                              type="button"
                              className="fc-btn fc-btn-sm"
                              onClick={() => handleKeepTemporary(asset)}
                            >
                              转存
                            </button>
                          )}
                          <button
                            type="button"
                            className="fc-btn fc-btn-sm fc-btn-obsidian"
                            onClick={() => handleInsertAndReturn(asset)}
                          >
                            上画布
                          </button>
                        </div>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </>
        )}
      </main>

      {toast && <div className="fc-toast">{toast}</div>}
    </div>
  );
}
