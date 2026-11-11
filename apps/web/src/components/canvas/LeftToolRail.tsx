import {
  AlignGridIcon,
  BrushIcon,
  HandIcon,
  LayersIcon,
  RedoIcon,
  SelectIcon,
  TextIcon,
  TrashIcon,
  UndoIcon,
  UploadIcon,
} from "../Icons";

export type CanvasToolMode = "select" | "hand" | "text" | "brush";

type LeftToolRailProps = {
  leftOpen: boolean;
  onToggleLeft: () => void;
  tool: CanvasToolMode;
  onSelectTool: (tool: CanvasToolMode) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  selectedCount: number;
  onAlignSelected: () => void;
  onTriggerUpload: () => void;
  onDeleteSelected: () => void;
  textFont: "sans" | "serif" | "mono";
  onChangeTextFont: (font: "sans" | "serif" | "mono") => void;
  textSize: number;
  onChangeTextSize: (size: number) => void;
  brushWidth: number;
  onChangeBrushWidth: (w: number) => void;
  strokeColor: string;
  onChangeStrokeColor: (color: string) => void;
};

const PALETTE = ["#141413", "#7c5b3e", "#2563eb", "#b45309"];

export function LeftToolRail(props: LeftToolRailProps) {
  const showSubbar = props.tool === "text" || props.tool === "brush";

  return (
    <>
      <div className="left-tool-rail">
        <button
          type="button"
          className={`fc-icon-btn fc-tool-btn ${props.leftOpen ? "active" : ""}`}
          data-tip="图层与素材抽屉"
          onClick={props.onToggleLeft}
        >
          <LayersIcon />
        </button>
        <div className="rail-sep" />
        <button
          type="button"
          className={`fc-icon-btn fc-tool-btn ${props.tool === "select" ? "active" : ""}`}
          data-tip="选择 / 框选 (V)"
          onClick={() => props.onSelectTool("select")}
        >
          <SelectIcon />
        </button>
        <button
          type="button"
          className={`fc-icon-btn fc-tool-btn ${props.tool === "hand" ? "active" : ""}`}
          data-tip="抓手平移画布 (H / Space)"
          onClick={() => props.onSelectTool("hand")}
        >
          <HandIcon />
        </button>
        <button
          type="button"
          className={`fc-icon-btn fc-tool-btn ${props.tool === "text" ? "active" : ""}`}
          data-tip="文字工具 · 点击画布放字 (T)"
          onClick={() => props.onSelectTool("text")}
        >
          <TextIcon />
        </button>
        <button
          type="button"
          className={`fc-icon-btn fc-tool-btn ${props.tool === "brush" ? "active" : ""}`}
          data-tip="自由画笔 (B)"
          onClick={() => props.onSelectTool("brush")}
        >
          <BrushIcon />
        </button>
        <div className="rail-sep" />
        <button
          type="button"
          className="fc-icon-btn fc-tool-btn"
          data-tip="撤销 (Ctrl/Cmd + Z)"
          disabled={!props.canUndo}
          onClick={props.onUndo}
        >
          <UndoIcon />
        </button>
        <button
          type="button"
          className="fc-icon-btn fc-tool-btn"
          data-tip="重做 (Ctrl/Cmd + Shift + Z)"
          disabled={!props.canRedo}
          onClick={props.onRedo}
        >
          <RedoIcon />
        </button>
        <div className="rail-sep" />
        <button
          type="button"
          className="fc-icon-btn fc-tool-btn"
          data-tip="局部网格对齐 (需选中 ≥2 项)"
          disabled={props.selectedCount < 2}
          onClick={props.onAlignSelected}
        >
          <AlignGridIcon />
        </button>
        <button
          type="button"
          className="fc-icon-btn fc-tool-btn"
          data-tip="上传本地图片到画布"
          onClick={props.onTriggerUpload}
        >
          <UploadIcon />
        </button>
        <button
          type="button"
          className="fc-icon-btn fc-tool-btn danger"
          data-tip="删除选中对象 (Del / Backspace)"
          disabled={props.selectedCount === 0}
          onClick={props.onDeleteSelected}
        >
          <TrashIcon />
        </button>
      </div>

      {showSubbar && (
        <div className="tool-subbar" style={{ left: props.leftOpen ? 332 : 72 }}>
          <strong style={{ fontSize: 12 }}>
            {props.tool === "text" ? "文字属性" : "画笔属性"}
          </strong>
          {props.tool === "text" ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <select
                value={props.textFont}
                onChange={(e) =>
                  props.onChangeTextFont(e.target.value as "sans" | "serif" | "mono")
                }
                style={{
                  height: 28,
                  borderRadius: 6,
                  border: "1px solid var(--border-hairline)",
                  padding: "0 6px",
                  background: "#fff",
                }}
              >
                <option value="sans">现代无衬线</option>
                <option value="serif">编辑衬线体</option>
                <option value="mono">等宽标注体</option>
              </select>
              <div style={{ display: "flex", gap: 5 }}>
                {[16, 22, 32].map((sz) => (
                  <button
                    key={sz}
                    type="button"
                    className={`chip-btn ${props.textSize === sz ? "active" : ""}`}
                    onClick={() => props.onChangeTextSize(sz)}
                  >
                    {sz}px
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 5 }}>
              {[2, 4, 8].map((w) => (
                <button
                  key={w}
                  type="button"
                  className={`chip-btn ${props.brushWidth === w ? "active" : ""}`}
                  onClick={() => props.onChangeBrushWidth(w)}
                >
                  {w}px
                </button>
              ))}
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {PALETTE.map((col) => (
              <button
                key={col}
                type="button"
                aria-label={`选择颜色 ${col}`}
                onClick={() => props.onChangeStrokeColor(col)}
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: "50%",
                  background: col,
                  border: "1.5px solid rgba(0,0,0,0.12)",
                  outline: props.strokeColor === col ? "2px solid var(--sapphire)" : "none",
                  outlineOffset: 1,
                }}
              />
            ))}
          </div>
        </div>
      )}
    </>
  );
}
