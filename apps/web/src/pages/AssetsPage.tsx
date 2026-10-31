import { Check, Heart, ImagePlus, Plus, Search, Upload, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { AppHeader } from "../components/AppHeader";
import { getSavedAssets } from "../lib/asset-store";
import { sampleAssets, type SampleAsset } from "../lib/samples";
import { api, ApiError, type Asset } from "@canvas/api-client";

type AssetTab = "all" | "recent" | "favorite";
const localFavoriteStorageKey = "flowcanvas.fixture-favorites.v1";

function readLocalFavoriteOverrides(): Record<string, boolean> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(localFavoriteStorageKey) ?? "{}");
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
    }
  } catch {
    // Fixture data remains usable when browser storage is unavailable.
  }
  return {};
}

function withLocalFavoriteOverrides(assets: SampleAsset[]): SampleAsset[] {
  const overrides = readLocalFavoriteOverrides();
  return assets.map((asset) => Object.hasOwn(overrides, asset.id) ? { ...asset, favorite: overrides[asset.id] } : asset);
}

function toSampleAsset(asset: Asset): SampleAsset {
  return {
    id: asset.id,
    name: asset.name,
    src: asset.src,
    dimensions: `${asset.width} × ${asset.height}`,
    favorite: asset.favorite,
    recent: true,
  };
}

export function AssetsPage() {
  const [tab, setTab] = useState<AssetTab>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assets, setAssets] = useState<SampleAsset[]>(() => withLocalFavoriteOverrides([...getSavedAssets(), ...sampleAssets]));
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [serverAssetIds, setServerAssetIds] = useState<Set<string>>(() => new Set());
  const [favoritePendingIds, setFavoritePendingIds] = useState<Set<string>>(() => new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const canvasId = searchParams.get("canvas") || "spring-board";

  useEffect(() => {
    let active = true;
    api.listAssets().then((records) => {
      if (!active) return;
      const remoteAssets = records.map(toSampleAsset);
      setServerAssetIds(new Set(records.map((asset) => asset.id)));
      setAssets(remoteAssets);
    }).catch((cause) => {
      if (!active || (cause instanceof ApiError && cause.status === 401)) return;
      setAssets([]);
      setServerAssetIds(new Set());
      setError(cause instanceof ApiError ? cause.message : "无法连接素材服务端。");
    });
    return () => { active = false; };
  }, []);

  const visibleAssets = useMemo(() => assets.filter((asset) => {
    const matchesTab = tab === "all" || (tab === "recent" ? asset.recent : asset.favorite);
    return matchesTab && asset.name.toLowerCase().includes(query.toLowerCase());
  }), [assets, query, tab]);

  function toggleSelected(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function handleUpload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setError("");
    try {
      const uploaded = await Promise.all([...files].filter((file) => file.type.startsWith("image/")).map((file) => api.uploadAsset(file)));
      const additions = uploaded.map(toSampleAsset);
      setAssets((current) => [...additions, ...current]);
      setServerAssetIds((current) => new Set([...current, ...uploaded.map((asset) => asset.id)]));
      setSelected((current) => new Set([...current, ...additions.map((asset) => asset.id)]));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "图片上传失败，请确认 API 和文件格式后重试。");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function toggleFavorite(asset: SampleAsset) {
    if (favoritePendingIds.has(asset.id)) return;
    const nextFavorite = !asset.favorite;
    setError("");
    setAssets((current) => current.map((item) => item.id === asset.id ? { ...item, favorite: nextFavorite } : item));
    if (!serverAssetIds.has(asset.id)) {
      try {
        const overrides = readLocalFavoriteOverrides();
        overrides[asset.id] = nextFavorite;
        window.localStorage.setItem(localFavoriteStorageKey, JSON.stringify(overrides));
      } catch {
        setError("浏览器无法保存演示素材的收藏状态。");
      }
      return;
    }

    setFavoritePendingIds((current) => new Set([...current, asset.id]));
    try {
      const updated = await api.setFavorite(asset.id, nextFavorite);
      const nextAsset = toSampleAsset(updated);
      setAssets((current) => current.map((item) => item.id === asset.id ? nextAsset : item));
    } catch (cause) {
      setAssets((current) => current.map((item) => item.id === asset.id ? { ...item, favorite: asset.favorite } : item));
      setError(cause instanceof ApiError ? cause.message : "收藏状态保存失败，请重试。");
    } finally {
      setFavoritePendingIds((current) => {
        const next = new Set(current);
        next.delete(asset.id);
        return next;
      });
    }
  }

  function addAssetsToCanvas(selectedAssets: SampleAsset[]) {
    if (!selectedAssets.length) return;
    sessionStorage.setItem("flowcanvas.pending-assets", JSON.stringify(selectedAssets));
    navigate(`/canvas/${encodeURIComponent(canvasId)}`);
  }

  return (
    <div className="assets-page dotted-page">
      <AppHeader active="assets" />
      <div className="assets-layout">
        <aside className="assets-rail">
          <button className={`rail-item ${tab === "all" ? "rail-item-active" : ""}`} onClick={() => setTab("all")}><ImagePlus size={18} /><span>全部图片</span><small>{assets.length}</small></button>
          <button className={`rail-item ${tab === "recent" ? "rail-item-active" : ""}`} onClick={() => setTab("recent")}><span className="rail-clock">◷</span><span>最近使用</span><small>{assets.filter((asset) => asset.recent).length}</small></button>
          <button className={`rail-item ${tab === "favorite" ? "rail-item-active" : ""}`} onClick={() => setTab("favorite")}><Heart size={18} /><span>收藏</span><small>{assets.filter((asset) => asset.favorite).length}</small></button>
          <div className="rail-bottom"><span className="tiny-dot" /> 私人素材库</div>
        </aside>

        <main className="assets-main">
          <div className="assets-title-row">
            <div><h1>我的素材</h1><span className="asset-total">{assets.length} 个图片素材</span></div>
            <div className="asset-actions-top">
              <label className="asset-search"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索素材名称、描述或标签…" /></label>
              <button className="button button-light upload-button" disabled={uploading} onClick={() => inputRef.current?.click()}><Upload size={17} />{uploading ? "正在上传…" : "上传素材"}</button>
              <input ref={inputRef} className="visually-hidden" type="file" accept="image/*" multiple onChange={(event) => handleUpload(event.target.files)} />
            </div>
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}

          <div className="asset-tabs" role="tablist" aria-label="素材筛选">
            <button className={tab === "all" ? "asset-tab active" : "asset-tab"} onClick={() => setTab("all")}>全部图片</button>
            <button className={tab === "recent" ? "asset-tab active" : "asset-tab"} onClick={() => setTab("recent")}>最近使用</button>
            <button className={tab === "favorite" ? "asset-tab active" : "asset-tab"} onClick={() => setTab("favorite")}>收藏</button>
          </div>

          <button className="dropzone" onClick={() => inputRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); handleUpload(event.dataTransfer.files); }}>
            <span className="dropzone-icon"><Upload size={23} /></span>
            <strong>拖拽文件到这里上传，或点击选择文件</strong>
            <small>支持 JPG、PNG、WebP 等图片格式 · 上传后保存至个人私有素材库</small>
          </button>

          <div className="assets-grid">
            {visibleAssets.map((asset, index) => {
              const isSelected = selected.has(asset.id);
              return (
                <article className={`asset-card ${isSelected ? "asset-card-selected" : ""}`} key={asset.id}>
                  <button className="asset-card-select" aria-label={`${isSelected ? "取消选择" : "选择"} ${asset.name}`} aria-pressed={isSelected} onClick={() => toggleSelected(asset.id)}>
                    <div className={`asset-preview asset-preview-${index % 6}`}>
                      <img src={asset.src} alt={asset.name} />
                      <span className={`asset-check ${isSelected ? "checked" : ""}`}>{isSelected && <Check size={15} />}</span>
                    </div>
                  </button>
                  <button
                    type="button"
                    className={`asset-card-favorite-button ${asset.favorite ? "is-favorite" : ""}`}
                    aria-label={`${asset.favorite ? "取消收藏" : "收藏"} ${asset.name}`}
                    aria-pressed={Boolean(asset.favorite)}
                    disabled={favoritePendingIds.has(asset.id)}
                    onClick={() => void toggleFavorite(asset)}
                  ><Heart size={15} fill={asset.favorite ? "currentColor" : "none"} /></button>
                  <button className="asset-hover-action" onClick={() => addAssetsToCanvas([asset])}><Plus size={14} />添加到画布</button>
                  <div className="asset-meta"><strong>{asset.name}</strong><span>{asset.dimensions}</span></div>
                </article>
              );
            })}
          </div>
          {visibleAssets.length === 0 && <div className="empty-assets">没有找到匹配的图片</div>}
        </main>

        {selected.size > 0 && (
          <div className="selection-bar">
            <div className="selection-thumbs">
              {[...selected].slice(0, 3).map((id) => {
                const asset = assets.find((item) => item.id === id);
                return asset ? <img key={id} src={asset.src} alt="" /> : null;
              })}
            </div>
            <div className="selection-copy"><strong>已选 {selected.size} 张</strong><span>也可以作为 Agent 的参考素材添加</span></div>
            <button className="button button-quiet" onClick={() => setSelected(new Set())}><X size={15} /> 清空选择</button>
            <button className="button button-light" onClick={() => addAssetsToCanvas(assets.filter((asset) => selected.has(asset.id)))}><Plus size={16} /> 添加到画布</button>
            <button className="button button-reference" onClick={() => { const selectedAssets = assets.filter((asset) => selected.has(asset.id)); sessionStorage.setItem("flowcanvas.pending-agent-assets", JSON.stringify(selectedAssets)); navigate(`/canvas/${encodeURIComponent(canvasId)}`); }}><ImagePlus size={16} /> 添加给 Agent</button>
          </div>
        )}
      </div>
    </div>
  );
}
