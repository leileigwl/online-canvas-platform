# FlowCanvas｜系统架构、目录结构与接口设计

> 本文档为 [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) 的工程细化说明书，记录 Monorepo 目录树、PostgreSQL 数据表、REST + SSE 接口契约、生图适配器设计与部署运维要点。

---

## 1. Monorepo 目标目录树

```text
online-canvas-platform/
├── AGENTS.md                           # 工作规则总入口（读取顺序、原型门控、交接规范）
├── README.md                           # 开源说明、本地启动与生产部署命令
├── package.json                        # pnpm + Turborepo 脚本（dev / dev:api / dev:worker / build / typecheck）
├── pyproject.toml / uv.lock            # Python 工作区与锁定依赖
├── .env.example                        # 本地开发环境变量模板
│
├── apps/
│   ├── web/                            # React 19 + TS + Vite + React Router 7 + Tailwind 4 + Konva
│   │   ├── Dockerfile                  # 构建前端静态产物并打包 Caddy 镜像
│   │   └── src/
│   │       ├── App.tsx                 # 路由配置（/, /assets, /canvas/:canvasId, /settings/agent, /login, /register, /account）
│   │       ├── pages/                  # 页面实现（严格复刻已确认 HTML 原型）
│   │       ├── components/             # 悬浮顶栏、可折叠抽屉、生图/Agent 控制面板等 DOM 组件
│   │       └── lib/                    # 本地示例数据与草稿/收藏辅助
│   │
│   ├── api/                            # FastAPI 后端（canvas-api）
│   │   ├── Dockerfile
│   │   ├── alembic/versions/           # PostgreSQL / SQLite 数据库迁移脚本
│   │   ├── tests/                      # [Phase 4 补齐] Pytest 单元与集成测试套件
│   │   └── canvas_api/
│   │       ├── main.py                 # FastAPI lifespan、CORS、健康检查 /api/health
│   │       ├── config.py               # Settings 与生产密钥/Cookie 校验
│   │       ├── models.py               # SQLAlchemy ORM（9+ 张核心业务表）
│   │       ├── schemas.py              # Pydantic v2 请求/响应契约
│   │       ├── routes.py               # REST 与 SSE 路由
│   │       ├── security.py             # 密码哈希、会话 Token、API Key 对称加密
│   │       ├── tools.py                # 受限画布工具白名单（add_note / move_object / resize_object / align_objects / add_shape）
│   │       ├── storage.py              # MinIO / S3 与本地存储适配器
│   │       ├── image_assets.py         # 生图像素校验、SHA-256 去重与临时/正式素材持久化
│   │       ├── seed_demo.py            # [Phase 2 新增] 新用户示例画布初始化 & 演示账号 CLI 种子脚本
│   │       └── providers/
│   │           ├── chat.py             # OpenAI 兼容聊天模型与 validate_public_https_url SSRF 防护
│   │           └── images.py           # 生图/改图 Provider 协议与 OpenAI 兼容 / 百炼 / 硅基流动适配器
│   │
│   └── worker/                         # ARQ + LangGraph 异步执行器（canvas-worker）
│       ├── tests/                      # [Phase 4 补齐] Worker 编排与断点续跑测试
│       └── canvas_worker/
│           ├── main.py                 # ARQ WorkerSettings、生图执行、四角色调用、孤立任务对账
│           ├── orchestration.py        # LangGraph StateGraph 编排
│           └── checkpoints.py          # PostgreSQL / SQLite LangGraph Checkpointer 封装
│
├── packages/
│   ├── canvas-core/                    # 前后端共享 CanvasItem / CanvasDocument / CanvasViewport 类型
│   └── api-client/                     # 类型化 REST 客户端 + [Phase 3 新增] SSE 事件流客户端
│
├── infra/
│   ├── compose.yaml                    # 6 服务生产编排（postgres, redis, minio, minio-init, api, worker, web）
│   ├── Caddyfile                       # Caddy SPA 回退与 /api/* SSE 无缓冲反代（flush_interval -1）
│   ├── compose.env.example             # 生产环境密钥与域名配置模板
│   ├── backup.sh / restore.sh          # PostgreSQL dump + MinIO 对象校验备份恢复脚本
│   └── minio*.Dockerfile               # 固定版本 MinIO 与 mc 客户端构建文件
│
└── docs/
    ├── PRODUCT.md / ARCHITECTURE.md / session-handoff.md
    ├── 01-product/PRD.md
    ├── 02-design/
    │   ├── system-architecture.md
    │   └── prototypes/                 # 交互式 HTML 原型与参考图
    └── 99-archive/                     # 归档旧文档、旧原型与参考截图
```

---

## 2. 数据库表结构（PostgreSQL 18 / Alembic 迁移管理）

| 表名 | 当前状态 | 核心字段与约束 | 用途说明 |
|---|---|---|---|
| `users` | 已实现 | `id`, `UNIQUE(username)`, `password_hash` | 账户身份与密码哈希 |
| `sessions` | 已实现 | `id`, `FK(user_id)`, `UNIQUE(token_hash)`, `expires_at` | HttpOnly 会话凭据 |
| `projects` | 已实现 | `id`, `FK(owner_id)`, `name` | 个人项目空间 |
| `canvases` | 已实现 | `id`, `FK(project_id)`, `document(JSONB)`, `viewport(JSONB)`, `revision` | 画布现状与乐观锁版本号 |
| `canvas_versions` | 已实现 | `id`, `FK(canvas_id)`, `UNIQUE(canvas_id, revision)` | 历史快照留档与一键回滚 |
| `assets` | 已实现 | `id`, `FK(owner_id)`, `object_key`, `sha256`, `width/height`, `favorite`, `temporary` | MinIO 私有图片素材库 |
| `model_configs` | 已实现 | `id`, `UNIQUE(owner_id)`, `provider`, `base_url`, `model_name`, `encrypted_api_key`, `role_models`, `max_context_tokens` | BYOK 语言模型、四角色映射与上下文窗口 |
| `image_model_configs` | **已实现** | `id`, `UNIQUE(owner_id)`, `provider`, `base_url`, `model_name`, `encrypted_api_key`, `default_options` | BYOK 生图/改图配置（`f3a8c9d21b04` 迁移） |
| `canvas_memories` | **已实现** | `id`, `UNIQUE(canvas_id)`, `compacted_summary`, `compacted_run_count`, `last_compacted_run_id`, `estimated_tokens`, `rejected_feedback` | 按画布隔离的 Harness 对话记忆与压缩核心偏好（`g1c4e7f92a10` 迁移） |
| `agent_runs` | 已实现 | `id`, `owner_id`, `canvas_id`, `goal`, `generation_settings`, `context_revision`, `model_call_budget`, `proposal`, `status` | 每次生图或协作运行的生命周期与提案（含 `audit_undo`） |
| `agent_tasks` | 已实现 | `id`, `FK(run_id)`, `task_key`, `role`, `depends_on`, `status`, `output` | 拆解子任务状态与结果持久化 |
| `run_events` | 已实现 | `id`, `FK(run_id)`, `sequence`, `event_type`, `data` | 供 SSE `/events` 消费的有序进度事件流 |
| `audit_events` | 已实现 | `id`, `actor_id`, `action`, `target_type`, `details` | 脱敏操作审计日志 |

---

## 3. REST 与 SSE 接口契约（前缀 `/api`）

| 模块 | 路由 | 方法 | 鉴权与关键机制 |
|---|---|---|---|
| 健康检查 | `/api/health` | `GET` | 公开；检查 PostgreSQL 与 Redis 队列连通性 |
| 账户会话 | `/api/auth/{register,login,session,me,logout,password,account}` | `POST/GET/PATCH/DELETE` | 注册自动初始化入门画布；`/session` 无 401 噪音；Cookie 会话鉴权 |
| 项目画布 | `/api/projects*`, `/api/canvases*` | `GET/POST/PUT/PATCH/DELETE` | 严格 `owner_id` 隔离；`PUT` 校验 `base_revision` 防覆盖 |
| 版本快照 | `/api/canvases/{id}/versions`, `/api/canvases/{id}/restore` | `GET` / `POST` | 查询/手动留档去重快照（保留最近 12 条）并按乐观锁事务性回滚 |
| Harness 记忆 | `/api/canvases/{id}/memory` | `GET` / `DELETE` | 查询画布上下文占用/压缩摘要/负反馈，或清空重置记忆 |
| 私有素材 | `/api/assets`, `/api/assets/{id}/content`, `/favorite`, `/save` | `GET/POST/PATCH` | 12MiB/100MP 校验；禁止匿名读；支持临时生成图转正 |
| 语言模型设置 | `/api/agent/model-config`, `/test` | `GET/PUT/POST` | HTTPS 公网 SSRF 校验；支持设置 `max_context_tokens`；加密存 Key、不回显 |
| **生图模型设置** | `/api/agent/image-config`, `/test` | `GET/PUT/POST` | **已实现**：独立配置 OpenAI / DashScope / SiliconFlow 生图密钥 |
| 画布工具元数据 | `/api/agent/tools` | `GET` | 返回服务端白名单工具 JSON Schema |
| Agent 运行与 SSE | `/api/agent/runs`, `/{id}`, `/{id}/events`, `/{id}/cancel`, `/{id}/retry` | `POST/GET` | 每账户最多 3 活动运行；`/events` 输出 `text/event-stream` SSE，支持 `after` 与 `Last-Event-ID` 续传 |
| 提案审阅与回退 | `/api/agent/runs/{id}/apply`, `/{id}/revert`, `/{id}/reject` | `POST` | 校验 `base_revision` 与工具白名单；`/revert` 精准撤销单批提案并写入 Harness 负反馈记忆 |

---

## 4. AI 生图/改图与工具扩展设计（Phase 2 细节）

### 4.1 `ImageGenerationProvider` 多协议与动态多图适配（已对照 Context7 / 官方文档）
在 [`apps/api/canvas_api/providers/images.py`](../../apps/api/canvas_api/providers/images.py) 保留协议接口 `generate()` 与 `edit()`，按用户配置及**参考图数量（0 / 1 / 2+ 张）**动态转换参数：
1. **`openai-compatible` 适配器**（依据 Context7 `/openai/openai-python` 最新 `images.py` / `image_edit_params.py`）：
   - **0 张图（文生图）**：调用 `POST {base_url}/images/generations`（传 `model`, `prompt`, `size`, `quality`, `background`, `n`）。
   - **1+ 张图（单图编辑 / 多图融合）**：调用 `POST {base_url}/images/edits`（`multipart/form-data`，`image` 支持单文件或最多 **16 张**文件数组，支持 `input_fidelity` `high`/`low`、`mask` 仅作用于第 1 张、`size`、`quality`、`background`、`n`）。
2. **`dashscope`（阿里百炼 `qwen-image-2.0` / `qwen-image-2.0-pro`）适配器**：
   - 调用 `MultiModalConversation`（或对应 REST `/services/aigc/multimodal-generation/generation`）：在 `messages[].content` 按顺序传入 `[{"image": ...}, ..., {"text": prompt}]`；支持 **1–3 张**多图输入（按顺序对应图 1 / 图 2 / 图 3），`n`（`1~6`）、`size`（`512*512`~`2048*2048`）、`prompt_extend`、`negative_prompt`；多图未传 `size` 时默认按最后一张参考图宽高比输出。
3. **`siliconflow`（硅基流动）适配器**：
   - 调用 `POST {base_url}/images/generations`，映射 `image_size`、`batch_size`（`1~4`）、`negative_prompt`、`num_inference_steps`、`guidance_scale`；当附加 1 张图时传 `image` 字段，超限多图时在前端与后端明确校验提示。
4. **前端动态表单契约**：参考图胶囊自动标号 `图1 / 图2 / 图3`，并根据 `0 张` / `1 张` / `2+ 张` 及当前配置的服务商动态显示/锁定对应输入参数。
5. **环境变量演示回落**：当平台处于演示模式或使用 CLI 种子演示账号时，允许读取受控环境变量中的演示凭证，但不向前端暴露凭证原文。

---

## 6. Context7 与官方文档核对基线（2026-11-11）

| 库 / 服务 | Context7 ID / 来源 | 核对结论 |
|---|---|---|
| Konva / React-Konva | `/konvajs/site` (`All_Performance_Tips.mdx`, `Batch_Draw.mdx`) | 拖动中节点移入独立 `dragLayer`，背景层设 `listening={false}`，关闭 `perfectDrawEnabled`，拖动帧内不触发 React `setState`，本地草稿改为异步 IndexedDB 防抖持久化。 |
| OpenAI Python SDK | `/openai/openai-python` (`images.py`, `image_edit_params.py`) | `images.edit` 支持单图与最多 16 张图数组、`input_fidelity`、`background`、`quality`、`size`（`multipart/form-data`）；`mask` 作用于数组首张图。 |
| LangGraph | `/websites/langchain_oss_python_langgraph` (`streaming`) | 使用 `graph.astream(..., stream_mode=["updates", "custom"], version="v2")` 配合 `get_stream_writer()` 实时发出思考摘要与结构化工具状态事件。 |
| 阿里百炼 / 硅基流动 | 官方 REST / SDK 文档（2026-11-11 联网核对） | `qwen-image-2.0` 支持 1–3 张图数组顺序编号且默认随末张图比例、`size="W*H"`、`n=1~6`；硅基流动使用 `image_size` / `batch_size` / 单图 `image`。 |

### 4.2 工具白名单扩展（[`tools.py`](../../apps/api/canvas_api/tools.py)）与创意工具
- `generate_image(prompt, aspect_ratio, resolution)`：**Agent 协同生图工具**，调用当前用户配置的生图 Provider 生成新素材并挂入画布。
- `edit_image(asset_id, prompt)`：**Agent 协同改图工具**，基于画布参考图执行 AI 编辑并产出新版本。
- `add_note(title, content, x, y, width, height)`：新增画布卡片便签（已有）。
- `move_object(object_id, x, y)`：移动既有对象（已有）。
- `resize_object(object_id, width, height)`：**新增**，安全调整图片、便签或形状宽高（限制 `[24, 4096]`）。
- `align_objects(object_ids, mode, columns, gap, start_x, start_y)`：**新增**，支持 `grid`（网格对齐）、`row`、`column`、`left`、`center`、`top` 批量坐标规整，校验所有 `object_id` 均属于当前画布。
- `add_shape(title, x, y, width, height, color)`：**新增**，添加规范化色块或容器框架。

---

## 5. 公网部署方案（Caddy 自动 HTTPS & 1Panel 反代）

1. **方案 A（推荐 · 内置 Caddy 直出 HTTPS）**：
   - 在 `.env` 中设置 `DOMAIN=canvas.210214.xyz`、`HTTP_PORT=80`、`HTTPS_PORT=443`、`COOKIE_SECURE=true`、`APP_ENV=production` 与 32 位以上随机 `APP_SECRET_KEY`。
   - 执行 `docker compose --project-directory "$PWD" -f infra/compose.yaml --env-file .env up -d --build`，Caddy 自动签发 Let's Encrypt TLS 证书并已内置 `flush_interval -1` 保障 SSE 实时推送。
2. **方案 B（挂在宿主机 1Panel Nginx 反代后方）**：
   - `.env` 保留 `DOMAIN=:80`、`HTTP_PORT=8080`（仅监听本机回环或内网端口）、`COOKIE_SECURE=true`（由外层 1Panel 终结 HTTPS）。
   - 在 1Panel 站点反向代理配置中将 `/api/agent/runs/` 或全站代理显式加上 `proxy_buffering off; proxy_cache off; proxy_read_timeout 300s;` 并透传 `X-Forwarded-Proto https` 与 `Host`，防止 Nginx 缓冲 SSE 流。
