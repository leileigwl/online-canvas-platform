# 后端基础实现说明

> 状态：2026-10-31。记录当前可运行的 v0.1 后端实现；本机 Compose、持久存储、备份恢复和 Agent Worker 崩溃恢复已实机验证，异机备份及真实模型服务仍待配置。

## 模块对应

| 模块 | 当前实现 |
|---|---|
| `apps/api` | FastAPI 路由、SQLAlchemy 模型、Pydantic 输入校验、密码/会话安全、存储适配器、聊天与图像 Provider 接口 |
| `apps/worker` | ARQ + LangGraph 任务执行；Coordinator 拆解最多 3 项工作，Planner 逐项规划，Canvas Editor 按依赖并行，Reviewer 审阅合并提案；状态、事件和检查点持久化 |
| `packages/canvas-core` | 前后端共享的画布文档、元素和视口 TypeScript 类型 |
| `packages/api-client` | Cookie 会话、JSON/FormData、错误解析和各页面使用的 API 方法 |
| `apps/web` | 登录/注册、项目/画布、资产、Agent 配置和画布提案接入 API；Vite 将 `/api` 代理至 `localhost:8001` |
| `apps/api/alembic` | PostgreSQL/SQLite 共用的业务表、Agent 子任务、生图参数和审计事件迁移 |

本地开发默认使用 SQLite 和本地文件；`DATABASE_URL` 可切换 PostgreSQL，`ASSET_STORAGE=s3` 可启用 MinIO/S3 兼容存储。`infra/compose.yaml` 已提供 Web/Caddy、API、Worker、PostgreSQL、Redis 和 MinIO 的单机部署配置；MinIO bucket 初始化、服务端 app-scoped 私有 bucket 凭证以及 PostgreSQL/对象备份与恢复脚本已加入。本机已完成整栈构建、健康检查、素材私有读写、PostgreSQL/MinIO 持久性与备份恢复演练。

## API 边界

- 账户：`/api/auth/register`、`login`、`me`、`logout`、`password`、`DELETE /api/auth/account`。登录 Cookie 为 HttpOnly、SameSite=Lax；密码使用 PBKDF2 哈希。
- 项目/画布：`/api/projects`、`/api/canvases`、`/api/projects/{id}/canvases`。画布文档保留 `schema_version`、`viewport` 和 `revision`；保存时以 SQL 条件更新 revision，并在同一事务记录上一版快照。`GET /api/canvases/{id}/versions` 返回当前版本及最近历史摘要；`POST /api/canvases/{id}/restore` 按 base revision 恢复选定快照并递增 revision，同时留存恢复前的当前文档。
- 素材：`/api/assets` 支持上传、列表/搜索、收藏、私有内容读取和临时生成图保存。服务端检查实际文件格式、大小、像素数、素材归属；临时图不出现在素材库列表，用户显式保存后转为普通素材。
- 模型配置：`/api/agent/model-config` 回传 Provider、URL、默认模型名和角色模型 ID；API Key 使用应用密钥加密保存。留空的角色继承默认模型。连接测试要求登录，不保存也不回显输入密钥，并禁止非公网 HTTPS 地址。
- Agent：`POST /api/agent/runs` 持久化任务后入 ARQ 队列；状态可轮询，也可读 SSE 事件。画布底部唯一输入按“画布协作 / 图片生成”明确分流：不带 `generation_settings` 时创建 Coordinator 任务并由 Planner、Canvas Editor 和 Reviewer 生成画布提案；带图像参数时创建 Image Creator 任务，由 Worker 调用抽象 Provider，验证输出后保存为临时私有素材并作为结果返回。默认 Provider 返回未配置，不联网。成功任务输出写入 `agent_tasks`，Worker 重启时可恢复已落库结果；画布操作仍经白名单和 schema 校验后存为待审提案。
- 审计与限额：`audit_events` 记录注册/登录、账户变更、画布保存、素材操作、模型配置、Agent 创建/取消/重试和提案应用/拒绝。记录只保留 actor、动作、目标和必要计数/revision，不写入密码、API Key、提示词或请求正文。图片上传限制为 12 MiB、100 MP；宽高启用 16 倍数对齐时由 API 强制校验；重复参考图 ID 会被拒绝。每账户默认最多 3 个排队/运行中的 Agent，Worker 全局并发为 4，每运行最多 3 个编辑子任务。
- 模型预算：每个 AgentRun 在创建时固化模型调用额度（默认 12 次）和单次输出上限（默认 2048 token）。Worker 在每次请求前以数据库条件更新原子占用额度，失败请求同样计入；ARQ 自动重试沿用同一计数。OpenAI 兼容 API 的输出长度字段可配置为 `max_tokens` 或 `max_completion_tokens`。成功响应中的 `completion_tokens` 用量会累加，并记录报告用量的响应数；兼容服务不回报用量时只显示已占调用次数，不估算美元费用。手动创建的新重试运行有独立的新额度。
- 检查点：LangGraph 使用 SQLite saver（开发）或 PostgreSQL saver（生产），以 run UUID 作为 `thread_id`；任务阶段、提案和事件仍由业务表作为 UI/API 数据源。
- 工具白名单目前只有 `add_note` 和 `move_object`。翻转、调色、滤镜、裁切和任意代码均不在 API 中。
- 生图：`ImageGenerationProvider` 定义 `generate`/`edit` 输入输出，包含已授权参考图的字节和所有图像参数。Agent 底栏通过 `/api/agent/runs` 提交并进入 ARQ Worker 的 Image Creator 任务；另保留类型化 `POST /api/generations` 供服务端集成。默认 Provider 不发网络请求并报告“未配置”。注入 Provider 后，服务端校验输出并保存为临时私有素材；用户显式保存到素材库或加入画布。

## 开发启动

```bash
cp .env.example .env
uv sync --all-packages
uv run --package canvas-api uvicorn canvas_api.main:app --app-dir apps/api --reload --host 127.0.0.1 --port 8001
```

另开终端运行 `pnpm dev`；需要 Agent 时还要启动 Redis 和 Worker：

```bash
uv run --package canvas-worker arq canvas_worker.main.WorkerSettings
```

## 单机 Compose 与恢复

复制 `infra/compose.env.example` 到仓库根目录 `.env`，替换全部示例密钥；本地可保留 `DOMAIN=:80` 并访问 `http://localhost:8080`。部署到域名时设置 `DOMAIN` 为已解析到主机的域名、开放 80/443，并设 `APP_ENV=production`、`COOKIE_SECURE=true` 及随机 `APP_SECRET_KEY`。Caddy 对域名自动申请/续期 HTTPS 证书；Compose 等待 PostgreSQL/Redis 健康和 MinIO 私有 bucket 初始化后再启动 API/Worker。PostgreSQL 18 的持久卷挂载到 `/var/lib/postgresql`。

```bash
cp infra/compose.env.example .env
openssl rand -hex 32
docker compose --project-directory . -f infra/compose.yaml up --build -d
```

把生成值分别填入 `.env` 中的应用、PostgreSQL、Redis、MinIO root 和 S3 app 密钥。MinIO 用固定 `flowcanvas-private` bucket；初始化任务只给 API/Worker 创建限定到该 bucket 的读写删除策略，MinIO Console 和 PostgreSQL/Redis 均不映射到宿主机端口。MinIO 与 `mc` 使用固定上游源码版本构建；MinIO 发布说明要求容器部署自行从源码构建，见[官方 release](https://github.com/minio/minio/releases/tag/RELEASE.2025-10-15T17-29-55Z)。

```bash
infra/backup.sh
infra/restore.sh backups/<UTC时间目录>
```

备份包含 PostgreSQL custom dump、SHA-256 校验文件和 MinIO 对象；完成后应将目录复制到异机或独立对象存储。恢复前会校验 checksum 并要求键入 `RESTORE`，然后停止 API/Worker、恢复 PostgreSQL 与 bucket、清空专用 Redis 队列并重启服务。容器排序依赖 Compose 的 `service_healthy` 和 `service_completed_successfully` 行为（[Docker Compose 启动顺序文档](https://docs.docker.com/compose/how-tos/startup-order/)）。本机已完成恢复演练，异机目的地尚未配置。

开发配置会自动创建 SQLite 表。生产环境应设置随机 `APP_SECRET_KEY`、`APP_ENV=production`、安全 Cookie 和 `AUTO_CREATE_SCHEMA=false`，再从仓库根运行：

```bash
uv run --package canvas-api alembic -c apps/api/alembic.ini upgrade head
```

## 复用教程的实现边界

参考本地 AI 修图文字教程，只复用了有明确边界的思路：工具注册表、Pydantic 参数校验、运行/阶段持久化、队列派发和用户审阅。没有复制本地任务状态、SQLite 文件路径或进程内后台任务方式。在线状态以数据库记录为准，Redis 只派发工作；图像服务保持供应商无关的 Provider 接口。

## 当前限制

- Agent 已支持最多 3 个依赖子任务、独立 Canvas Editor 并行、按 Coordinator/Planner/Canvas Editor/Reviewer 选择模型 ID、动态任务状态持久化和每运行模型调用预算。独立子任务失败后部分成功任务可恢复；用户发起的失败重试仍会创建新运行。
- Worker/Redis 恢复已在本机实机验证：强制终止 Planner 阶段的 Worker 后，ARQ 在执行租约过期后重派同一 AgentRun；PostgreSQL LangGraph saver 恢复已完成的 Coordinator 节点，后续 Planner、Editor、Reviewer 成功完成。定时对账器只在活动运行没有 Redis 排队/执行记录时标记失败，已验证孤立、排队和执行租约三种状态。
- Compose 首次构建、Web/API 健康、MinIO 私有 bucket 权限、素材读写、PostgreSQL/MinIO 持久性及本机恢复演练均已通过。异机备份位置尚未配置或验证。
- 应用日志只记录任务 ID、异常类型与操作结果，不输出第三方异常文本或堆栈，不记录 Cookie、Authorization、请求正文或 API Key；数据库审计不记录提示词内容。生产环境仍应由反向代理配置请求速率限制，并为审计记录设置保留/清理周期。
- 取消会先持久化终态，再用 ARQ `Job.abort()` 取消排队或正在运行的 Worker 协程；Worker 的阶段写入和最终成功/失败写入都使用状态条件，避免覆盖取消结果。远端模型服务收到请求后，服务端无法保证撤回其计算。
- Worker 对同一 AgentRun 最多自动尝试 3 次，并使用同一 run UUID 恢复 LangGraph 检查点；如果进程崩溃直到 ARQ 用尽重试并移除队列记录，分钟级对账任务会把仍活动的孤立运行与任务标为失败，供用户从界面重试。
- 未配置真实聊天模型凭证。本轮 Worker 崩溃验证在进程内替换为确定性假 Provider，没有访问外部模型；真实聊天服务连通性仍需用户配置有效 BYOK 信息，真实生图仍需用户提供 Provider 接口。生产反向代理还需按部署环境设置请求速率限制，并为审计记录设置保留/清理周期。

当前锁定版本：FastAPI 0.162.0、SQLAlchemy 2.1.6、ARQ 0.28.0、LangGraph 1.2.19、langgraph-checkpoint-sqlite 3.1.3、langgraph-checkpoint-postgres 3.2.0；实际解析版本以 `uv.lock` 为准。Context7（2026-10-31，LangGraph Python 官方文档）核对了 StateGraph 节点/边、异步 checkpointer、SQLite/PostgreSQL saver 与 `thread_id` 用法。
