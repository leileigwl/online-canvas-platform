# Session handoff：交接清单

> 最后更新：2026-11-11

## 当前阶段

**Phase 0–5（Warm Ivory Gallery v6 原型定版、全栈前后端重写、Harness 上下文压缩多轮记忆引擎、单批提案精准回退、以及完整 Playwright + Pytest + Vite 构建验收）全部完成，可随时打包部署或用于简历与面试演示。**

## 最新修复与新增核心特性（含 Harness 架构）

1. **拖拽去回弹与空文本框自清**：
   - 修复原型中 `alignSelectedObjects` / `applyDemoProposal` 后残留 `.anim-layout` 导致拖拽结尾回弹的问题；优化 Konva `KonvaStageView` 拖拽结束时的位置取整同步与 `Transformer.forceUpdate()`。
   - 当用户删空文本框所有文字并失焦时（原型 & 真实前端均已生效），自动删除该空白文字节点，不再留下空框。
2. **整张画布 2x PNG 导出 & 原型定位说明**：
   - 真实网站通过 `contentLayer.toCanvas(...)` 在 `http/https` 同源环境下导出含图、文字、便签与画笔笔迹的 2x 包围盒 PNG（含 40px 暖象牙点阵留白、零选框与 UI 遮罩；缩小至 60% 以下亦可完整输出）。
   - 本地 `file://` 打开的纯 HTML 原型受浏览器安全策略限制无法读取同磁盘图片像素（已补全 `FileReader` data-URI 上传使本地上传图可在原型导出中渲染，正式网站已彻底去除原型左下角的视图切换条）。
3. **Thinking 可收缩且完整滚动 + Harness 上下文压缩与单批精准撤销**：
   - 修复右侧 AI Agent 抽屉 `.thinking-card` / `.tool-call-card` 缺少 `flex-shrink: 0` 导致展开内容被 Flex 挤压裁切且无法下滑的问题。
   - **参考 Cursor/Devin/Kiro Harness 记忆架构**：新增 `canvas_memories` 表（迁移 [`g1c4e7f92a10`](../apps/api/alembic/versions/g1c4e7f92a10_add_canvas_memories.py)）与 `ModelConfig.max_context_tokens` 预算配置（默认 `32,768`）；Worker 在累计未压缩轮次 ≥ 6 或上下文达到阈值 `65%` 时自动调用 `COMPACTOR_PROMPT` 将较早轮次蒸馏压缩为高密度核心记忆并保留最近 2 轮精确对话，同时通过 SSE 实时推送 `Harness Memory` 思考步骤；提供 `GET/DELETE /api/canvases/{id}/memory` 查看与清空记忆。
   - **精准单批方案/生图回退**：`POST /api/agent/runs/{id}/apply` 记录本次提案 `audit_undo`（`added_item_ids` 与 `before_items`）；点击「撤销此批方案 / 生图并记住偏好」（`POST /api/agent/runs/{id}/revert`）仅清理该批次新增元素并恢复其调整的对象（保留用户期间手动拖拽的其他元素），同时将该负面反馈写入 `CanvasMemory.rejected_feedback`，避免 Agent 下轮重复采用被否决的设计方向。

## 已执行的真实校验（2026-11-11）

- `uv run ruff check apps/api apps/worker`：**All checks passed!**
- `alembic upgrade head`（升级至最新 `g1c4e7f92a10`）：**ALEMBIC_OK**。
- `uv run pytest apps/api/tests apps/worker/tests -v`：**7 passed**（含 `POST /agent/runs/{id}/revert` 精准回退保护中间手工拖拽 + `CanvasMemory` 负反馈写入 + 6 轮对话触发 Harness 自动压缩并推送 `Harness Memory` SSE 思考事件）。
- `pnpm typecheck && pnpm build`：**0 errors**，构建 `dist/` 成功。
- **Chrome Playwright 全链路校验（最终修改后重跑）**：
  - 原型 [`flowcanvas-prototype.html`](02-design/prototypes/flowcanvas-prototype.html)：拖拽、小地图、T/B/Del/对齐、导出（`94,170 bytes`）、动态 Agent 指令与 Harness 记忆均通过，**0 错误**；
  - 真实全栈（`uvicorn` + `vite` + Chrome）：未登录门禁 -> 建空白画布跳转注册 -> 上传双图 -> 点选参考与清空 -> 文字原位编辑 & 空文本自动删框 -> 画笔/删除/撤销 -> 框选局部对齐 -> 标题内联重命名与重载持久化 -> 版本留档 -> 常态与缩小导出 Konva 2x PNG（实测 `768,089 bytes` 与 `768,197 bytes`）-> AI Agent Harness 记忆抽屉 -> 素材库 `?canvasId=` 往返 -> BYOK 设置保存与 `max_context_tokens=65536` 持久化且无密钥回显：**Console/Page errors: 0，5xx responses: 0**。
- **未在本地直接启动容器跑的项**：6 容器 `docker compose up --build` 尚未在开发机本地拉起（已校验 `compose.yaml` 与 `uv.lock`），待部署目标服务器后启动验证。
