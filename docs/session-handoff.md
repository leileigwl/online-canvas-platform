# Session handoff：交接清单

> 最后更新：2026-11-13

## 当前阶段

**Agent 实验室多轮自主循环 + Apple Silicon 本地 Flux (`mflux-4b`) 真实生图闭环 + 生产级安全护栏与熔断重试架构 已全部开发并完成实机端到端验收。**

当前本地服务处于健康运行状态（`master` 分支，已固化本地检查点），可直接交接至下一款 AI IDE / 工具继续迭代或准备云端上线。

---

## 本轮核心交付与架构升级

1. **Apple Silicon 本地 Flux 2 Klein (4-bit) 真实生图闭环**
   - [infra/local_mflux_server.py](../infra/local_mflux_server.py)：宿主机原生 MLX GPU 桥接服务（端口 `8002`），暴露 OpenAI 兼容 `/v1/images/generations` 与 `/v1/images/edits`；内置分辨率安全钳位（最大边 `≤768px`，16:9 即 `768×432`，单张渲染 ~25–35s）、`240s` 推理超时、模型名正则白名单校验与严格本地 CORS。
   - [apps/api/canvas_api/image_assets.py](../apps/api/canvas_api/image_assets.py)：当请求模型包含 `flux` / `mflux` 时，免数据库手动配置即可自动路由至 `http://host.docker.internal:8002/v1`。
   - [apps/api/canvas_api/providers/images.py](../apps/api/canvas_api/providers/images.py)：图像适配器客户端超时提升至 `240s`。
   - [apps/worker/canvas_worker/main.py](../apps/worker/canvas_worker/main.py)：`materialize_image_op` 正确透传 `local-mflux` 模型与动态比例（16:9 / 3:4 / 1:1），生成真实图像持久化至 MinIO 并支持异常兜底。

2. **对照 `hello-agent-system-main/agentkit` 补齐的生产级 Harness 架构**
   - **安全护栏与精确 Token 估算**：新增 [apps/api/canvas_api/agent_guardrails.py](../apps/api/canvas_api/agent_guardrails.py)
     - `detect_prompt_injection` & `wrap_untrusted_text`：已接入 `_canvas_summary`，对画布便签中疑似间接注入文本自动施加随机边界 `<untrusted_data id="...">` 隔离（Spotlighting）。
     - `redact_secrets`：在 Agent 最终 `reply` 与 `summary` 输出前自动脱敏 `sk-...`、`AKIA...` 与私钥块。
     - `estimate_tokens_cjk`：中英文混合 Token 精确估算，使 85% 压缩线与实时窗口进度条更准确。
   - **三态熔断器与指数退避重试**：[apps/api/canvas_api/providers/chat.py](../apps/api/canvas_api/providers/chat.py)
     - 按网关主机隔离的 `CircuitBreaker`（`closed -> open -> half_open`）、最多 3 次全抖动指数退避重试（识别 `Retry-After`）、以及 Markdown JSON 代码块剥离容错（`_FENCE_RE`）。
   - **自主循环防卡死保护（Loop-Stuck Guard）**：[apps/worker/canvas_worker/main.py](../apps/worker/canvas_worker/main.py)
     - 连续 3 步仅执行 `think` / `inspect_canvas` 时自动注入防呆引导，促使其推进到 `design_canvas` 或 `respond`。

3. **后端安全与审计审查加固**
   - 核查所有 `/api/canvases/{id}/agent-sessions` 与 `/api/agent-sessions/{id}/*` 路由：均具备 `owner_id == user.id` 归属校验与 PostgreSQL `FOR UPDATE` 行锁防并发竞态。
   - 为 `reset_session_memory` 与 `delete_agent_session` 补齐 `_audit_event` 审计日志落库（[routes.py](../apps/api/canvas_api/routes.py)）。
   - 收紧 `local_mflux_server.py` CORS 与 CLI `--model` 参数正则校验。

---

## 本地运行环境与启动命令

1. **Docker Compose 全栈（6 容器）**：
   ```bash
   docker compose --project-directory . -f infra/compose.yaml up -d
   ```
   - 前端入口：`http://localhost:8080`（Caddy 反向代理 `/api/*` 到 FastAPI，SPA 路由回退）
   - 服务：`web`、`api`、`worker`、`postgres`、`redis`、`minio`
2. **宿主机本地 Flux 生图桥接（Apple Silicon Mac）**：
   ```bash
   /Library/Frameworks/Python.framework/Versions/3.12/bin/python3 infra/local_mflux_server.py --port 8002
   ```
   - 权重缓存位于 `~/.cache/huggingface/hub/models--RunPod--FLUX.2-klein-4B-mflux-4bit`（已完整下载）。

---

## 本轮已执行的真实校验（2026-11-13）

- `uv run ruff check apps/api apps/worker infra`：**All checks passed!**
- `uv run pytest apps/worker/tests apps/api/tests`：**34 passed**（含新增 `test_agent_guardrails.py` 6 项护栏/熔断/Token 估算单测）。
- `pnpm --filter web build`：**0 errors**（`tsc --noEmit && vite build`）。
- **Chrome 实机全链路验收（`http://localhost:8080`，账户 `leileigwl`）**：
  - 顶部导航（`Agent 实验室` / `素材库` / `模型与生图设置` / `我的画布`）切换正常，零控制台报错；
  - `Flux 生图实验室` 16:9 渲染出真实橘猫图并成功推入画布；
  - `Agent 实验室` 对话触发自主循环生成真实小猫提案图；
  - 多 Agent 会话隔离（`+ 开启全新 Agent`、切换 `#1`/`#2`）、`↻ 测试碰撞自修复`、`应用到画布` → `撤回`、`⚡ 压测 85% 压缩线`、`手动压缩`、`清屏（保留记忆）`、`重置记忆`、右侧 3 个 Tab（`/context`、`2D 排版校验`、`SSE 流`）及 `↗ 新窗口打开画布对比`（`/canvas/{id}`）全部实测通过。

---

## 下一步建议（供下一位 AI 接力开发）

1. **后端持续安全与供应链审计**：
   - 在具备 `endorctl` / `bandit` / `pip-audit` 的环境中运行完整 SAST、SCA 与依赖 CVE 扫描（遵循 `AGENTS.md` 中的 `review-security` / `cs-audit` / `endor-labs-agent-kit` 门控）。
2. **分布式熔断器与实时流式输出**：
   - 当前 `CircuitBreaker` 为进程内内存状态；多 Worker 实例部署时可将其状态迁移至 Redis。
   - 可将自主 Agent 的思考与回复改为逐 Token SSE 流式输出。
3. **上线前生产配置核对**：
   - 核查 `.env` 生产密钥强度、`COOKIE_SECURE=true`、`SMTP_ENABLED` 发信与 HTTPS 域名配置。

---

## 交接给下一位 AI 的完整 Prompt（可直接复制使用）

```text
请接手 FlowCanvas（/Users/leileigwl/Work/Learn/new/online-canvas-platform）的后续开发与上线前加固工作。

在开始任何代码修改前，请严格按顺序阅读以下文档：
1. AGENTS.md（工作规则、原型门控、Skill 使用规范与安全审计红线）
2. docs/session-handoff.md（当前系统状态、已完成的 Flux 生图/Harness 护栏架构、本地环境启动命令与已验证基线）
3. docs/ARCHITECTURE.md 与 docs/PRODUCT.md

当前基线与运行环境：
- Docker Compose 6 容器（web/api/worker/postgres/redis/minio）通过 `docker compose --project-directory . -f infra/compose.yaml up -d` 运行在 http://localhost:8080
- 宿主机 Apple Silicon MLX 生图服务运行在 http://127.0.0.1:8002（infra/local_mflux_server.py）
- 后端已补齐 agent_guardrails.py（注入检测/Spotlighting/密钥脱敏/CJK Token 估算）、providers/chat.py（三态熔断器/抖动指数退避重试）与自主循环防卡死保护，pytest 34 passed、ruff 通过、前端 Vite 构建通过。

接下来请你重点推进以下工作：
1. 【持续安全与审计审查】使用安全审查与代码审计类 Skill（如 review-security、cs-audit、endor-labs-agent-kit 等），对 apps/api、apps/worker、infra 进行深度安全审计：
   - 核查 SSRF 防护、IDOR 归属校验、BYOK 密钥加密与零回显、AuditEvent 审计覆盖率、Cookie/CORS 安全边界及 Python/Node 依赖漏洞（SCA）。
2. 【架构演进】按需将进程内 CircuitBreaker 升级为 Redis 共享状态以支持多 Worker 并发，并持续完善 Agent 实验室与无限画布协同体验。
3. 【每次改动后必须验证并提交】执行 `uv run ruff check apps/api apps/worker infra`、`uv run pytest apps/worker/tests apps/api/tests`、`pnpm --filter web build` 与真实浏览器端到端回归，更新 docs/session-handoff.md 并执行干净的本地 git commit（不要擅自 git push）。
```
