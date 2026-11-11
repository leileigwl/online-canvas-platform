import type { Asset } from "@canvas/api-client";
import type { CanvasItem } from "@canvas/canvas-core";
import { useState } from "react";
import { CloseIcon, EyeClosedIcon, EyeOpenIcon } from "../Icons";

type LeftLayersDrawerProps = {
  open: boolean;
  onClose: () => void;
  items: CanvasItem[];
  selectedIds: string[];
  onSelectItem: (item: CanvasItem) => void;
  onToggleVisibility: (id: string) => void;
  assets: Asset[];
  onInsertAsset: (asset: Asset) => void;
  onTriggerUpload: () => void;
  onOpenFullAssets: () => void;
};

export function LeftLayersDrawer(props: LeftLayersDrawerProps) {
  const [tab, setTab] = useState<"layers" | "assets">("layers");
  const [query, setQuery] = useState("");

  if (!props.open) return null;

  const filteredItems = props.items.filter((i) =>
    (i.title || i.content || i.type).toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <aside className="left-drawer">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: "1px solid var(--border-hairline)",
          padding: "10px 12px 0 14px",
        }}
      >
        <div style={{ display: "flex", gap: 14 }}>
          <button
            type="button"
            onClick={() => setTab("layers")}
            style={{
              padding: "5px 2px 10px",
              fontSize: 12,
              fontWeight: 550,
              color: tab === "layers" ? "var(--text-primary)" : "var(--text-muted)",
              borderBottom: tab === "layers" ? "2px solid var(--obsidian)" : "2px solid transparent",
            }}
          >
            图层 ({props.items.length})
          </button>
          <button
            type="button"
            onClick={() => setTab("assets")}
            style={{
              padding: "5px 2px 10px",
              fontSize: 12,
              fontWeight: 550,
              color: tab === "assets" ? "var(--text-primary)" : "var(--text-muted)",
              borderBottom: tab === "assets" ? "2px solid var(--obsidian)" : "2px solid transparent",
            }}
          >
            我的素材
          </button>
        </div>
        <button
          type="button"
          className="fc-icon-btn"
          style={{ width: 26, height: 26, marginBottom: 6 }}
          onClick={props.onClose}
          title="收起左侧面板"
        >
          <CloseIcon size={13} />
        </button>
      </div>

      {tab === "layers" ? (
        <div style={{ flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索画布对象..."
            style={{
              width: "100%",
              height: 34,
              padding: "0 11px",
              borderRadius: 10,
              background: "var(--surface-input)",
              border: "1px solid var(--border-hairline)",
              fontSize: 12,
              outline: 0,
            }}
          />
          {!filteredItems.length ? (
            <div style={{ padding: "22px 8px", textAlign: "center", fontSize: 12, color: "var(--text-muted)" }}>
              当前暂无匹配图层
            </div>
          ) : (
            filteredItems.map((item) => {
              const selected = props.selectedIds.includes(item.id);
              return (
                <div
                  key={item.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "6px 8px",
                    borderRadius: 9,
                    fontSize: 12,
                    background: selected ? "var(--sapphire-soft)" : "transparent",
                    border: selected
                      ? "1px solid rgba(37, 99, 235, 0.24)"
                      : "1px solid transparent",
                    color: selected ? "var(--sapphire)" : "var(--text-primary)",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => props.onSelectItem(item)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      minWidth: 0,
                      flex: 1,
                      textAlign: "left",
                    }}
                  >
                    <div
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: 5,
                        background: "var(--surface-muted)",
                        overflow: "hidden",
                        display: "grid",
                        placeItems: "center",
                        fontSize: 10.5,
                        fontWeight: 650,
                        flexShrink: 0,
                      }}
                    >
                      {item.src ? (
                        <img
                          src={item.src}
                          alt=""
                          style={{ width: "100%", height: "100%", objectFit: "cover" }}
                        />
                      ) : item.type === "text" ? (
                        "T"
                      ) : item.type === "brush" ? (
                        "∿"
                      ) : (
                        "▤"
                      )}
                    </div>
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {item.type === "text" ? item.content || "文字图层" : item.title || item.type}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="fc-icon-btn"
                    style={{ width: 26, height: 26 }}
                    onClick={() => props.onToggleVisibility(item.id)}
                    title={item.visible === false ? "显示图层" : "隐藏图层"}
                  >
                    {item.visible === false ? <EyeClosedIcon /> : <EyeOpenIcon />}
                  </button>
                </div>
              );
            })
          )}
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              className="fc-btn fc-btn-sm fc-btn-obsidian"
              style={{ flex: 1 }}
              onClick={props.onTriggerUpload}
            >
              + 上传图片
            </button>
            <button type="button" className="fc-btn fc-btn-sm" onClick={props.onOpenFullAssets}>
              完整库
            </button>
          </div>
          {!props.assets.length ? (
            <div style={{ padding: "18px 8px", textAlign: "center", fontSize: 12, color: "var(--text-muted)" }}>
              暂无已保存素材，可上传本地图片或保存生图结果。
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {props.assets.map((asset) => (
                <button
                  key={asset.id}
                  type="button"
                  onClick={() => props.onInsertAsset(asset)}
                  style={{
                    borderRadius: 10,
                    overflow: "hidden",
                    border: "1px solid var(--border-hairline)",
                    background: "var(--surface-solid)",
                    textAlign: "left",
                  }}
                >
                  <img
                    src={asset.src}
                    alt={asset.name}
                    style={{ width: "100%", height: 74, objectFit: "cover", display: "block" }}
                  />
                  <div
                    style={{
                      padding: "5px 7px",
                      fontSize: 10.5,
                      color: "var(--text-secondary)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    + {asset.name}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
