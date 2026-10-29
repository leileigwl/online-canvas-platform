import { Check, Heart, ImagePlus, Plus, Search, Upload, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { AppHeader } from "../components/AppHeader";
import { getSavedAssets } from "../lib/asset-store";
import { sampleAssets, type SampleAsset } from "../lib/samples";

type AssetTab = "all" | "recent" | "favorite";

export function AssetsPage() {
  const [tab, setTab] = useState<AssetTab>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assets, setAssets] = useState<SampleAsset[]>(() => [...getSavedAssets(), ...sampleAssets]);
  const inputRef = useRef<HTMLInputElement>(null);
  const objectUrls = useRef<string[]>([]);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const canvasId = searchParams.get("canvas") || "spring-board";

  useEffect(() => {
    const releaseObjectUrls = () => objectUrls.current.forEach((url) => URL.revokeObjectURL(url));
    window.addEventListener("pagehide", releaseObjectUrls);
    return () => window.removeEventListener("pagehide", releaseObjectUrls);
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

  function handleUpload(files: FileList | null) {
    if (!files?.length) return;
    const additions = [...files].filter((file) => file.type.startsWith("image/")).map((file, index) => {
      const src = URL.createObjectURL(file);
      objectUrls.current.push(src);
      return { id: `local-${Date.now()}-${index}`, name: file.name, src, dimensions: "本地预览", recent: true };
    });
    setAssets((current) => [...additions, ...current]);
    setSelected((current) => new Set([...current, ...additions.map((asset) => asset.id)]));
    if (inputRef.current) inputRef.current.value = "";
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
              <button className="button button-light upload-button" onClick={() => inputRef.current?.click()}><Upload size={17} /> 上传素材</button>
              <input ref={inputRef} className="visually-hidden" type="file" accept="image/*" multiple onChange={(event) => handleUpload(event.target.files)} />
            </div>
          </div>

          <div className="asset-tabs" role="tablist" aria-label="素材筛选">
            <button className={tab === "all" ? "asset-tab active" : "asset-tab"} onClick={() => setTab("all")}>全部图片</button>
            <button className={tab === "recent" ? "asset-tab active" : "asset-tab"} onClick={() => setTab("recent")}>最近使用</button>
            <button className={tab === "favorite" ? "asset-tab active" : "asset-tab"} onClick={() => setTab("favorite")}>收藏</button>
          </div>

          <button className="dropzone" onClick={() => inputRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); handleUpload(event.dataTransfer.files); }}>
            <span className="dropzone-icon"><Upload size={23} /></span>
            <strong>拖拽文件到这里上传，或点击选择文件</strong>
            <small>支持 JPG、PNG、WebP 等图片格式 · 当前为本地预览原型</small>
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
                    <span className="asset-card-favorite"><Heart size={15} fill={asset.favorite ? "currentColor" : "none"} /></span>
                  </div>
                  </button>
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
