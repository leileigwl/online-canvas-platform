# FlowCanvas｜在线 AI 无限画布与视觉创作工作台

> **AI 无限画布 + 文生图/参考图改图 + 多 Agent 协同排版全栈工作台（开源可自托管 Web 平台）**

## AI 与开发工作入口

- **首先阅读**：[`AGENTS.md`](./AGENTS.md)（工作规则总入口）
- **产品边界**：[`docs/PRODUCT.md`](./docs/PRODUCT.md)（上线范围、BYOK 模式与排除项）
- **技术约束**：[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)（6 服务拓扑、技术栈、安全红线与禁止引入清单）
- **交接清单**：[`docs/session-handoff.md`](./docs/session-handoff.md)（当前阶段、真实校验记录与下一步）

## 详细设计文档

- [详细产品需求文档（PRD）](./docs/01-product/PRD.md)
- [系统架构、目录树、表结构与接口契约](./docs/02-design/system-architecture.md)
- [前端交互原型图目录](./docs/02-design/prototypes/README.md)

## 核心特性

- **无限画布工作台**：基于 React 19 + TypeScript + Konva（独立拖拽层 `dragLayer`）的暖象牙画廊风无限空间，支持自由平移缩放、多选框选、文字 (`T`) 原位编辑、自由画笔 (`B`)、局部多选网格对齐、`Delete` 删除与撤销重做、IndexedDB 异步草稿恢复、右下角全局缩略图 Minimap 与 2x 无 UI 边框整画布 PNG 导出。
- **AI 生图与参考图改图**：支持 OpenAI（`/images/generations` & `/images/edits` 最多 16 图）、阿里百炼（`qwen-image-2.0` 1–3 图融合，自动保持末图比例）与硅基流动（`Kolors`/`Qwen-Image`）三大适配器；按 0 / 1 / 2+ 张选中参考图动态呈现参数，完成后自动转存 MinIO 私有存储并落入画布。
- **LangGraph 多角色 Agent 协作（SSE 实时流）**：Coordinator 拆解最多 3 个带依赖的子任务，Planner 制定视觉方案，独立 Canvas Editor 并发执行受限白名单工具（`add_note`、`add_text`、`move_object`、`resize_object`、`align_objects`、`add_shape`、`generate_image`、`edit_image`），通过 LangGraph `stream_mode=["updates", "custom"]` (`v2`) + SSE 向右栏实时输出 **Thinking 思考过程** 与 **工具调用卡片**，经 Reviewer 审核后由用户预览应用或整批撤销。
- **BYOK 与生产级安全隔离**：用户独立配置并 Fernet 加密保存自己的 LLM 与 AI 生图密钥（绝不回显明文），服务端强制校验 HTTPS 公网地址防止 SSRF，所有项目、画布、素材与运行记录按账户严格隔离；新注册账号自动附带入门画布，并支持通过 CLI 一键预置面试演示画廊工作区。

## 本地开发命令（`uv` + `pnpm`）

```bash
# 1. 启动基础设施（或使用完整 Compose 栈）
cp .env.example .env

# 2. 安装 Python 工作区依赖（含 pytest）并执行数据库迁移
uv sync --all-packages --extra dev
cd apps/api && ../../.venv/bin/alembic upgrade head && cd ../..

# 3. 启动 FastAPI（:8001）与 ARQ Worker
pnpm dev:api
pnpm dev:worker

# 4. 安装前端依赖并启动 Vite 开发服务（:5173）
pnpm install
pnpm dev

# 5. （可选）为面试演示账号一键预置示例图片与画廊画布
uv run python -m canvas_api.seed_demo --username demo_creator --password '<your-password>'

# 6. 质量检查、单测与构建
uv run ruff check apps/api apps/worker
uv run pytest apps/api/tests apps/worker/tests -v
pnpm typecheck
pnpm build
```

## 生产容器部署（Docker Compose + Caddy / 1Panel）

```bash
cp infra/compose.env.example .env
# 修改 .env 中的强密钥、数据库口令与公网 DOMAIN（如 canvas.210214.xyz）
docker compose --project-directory "$PWD" -f infra/compose.yaml --env-file .env up -d --build
docker compose --project-directory "$PWD" -f infra/compose.yaml --env-file .env ps
```

- 备份与恢复见 [`infra/backup.sh`](./infra/backup.sh) 与 [`infra/restore.sh`](./infra/restore.sh)。
- 若由宿主机 1Panel Nginx 终止 TLS 并反代至 Compose Caddy/Web 端口，需在 Nginx location 中关闭代理缓冲以保障 SSE 流式推送实时到达（详见 [`docs/02-design/system-architecture.md`](./docs/02-design/system-architecture.md)）。

## License

本项目采用 [MIT License](./LICENSE) 开源。
