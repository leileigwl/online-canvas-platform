# Design: 个人无限画布与多 Agent MVP

## Context

当前仓库没有运行代码和既有用户数据。MVP 按单用户编辑设计；多人同时编辑、项目成员、Yjs/Hocuspocus 和实时 Presence 不纳入本 change。实现前先由用户补 Agent 原型并进行 UI 前端调试。

## Goals / Non-Goals

**Goals:**

- 明确账户、个人项目、无限画布、图片素材与 Agent 的产品行为。
- 以 Coordinator 和专业 Agent 完成受限自主规划、委派、并行、审批和可恢复执行。
- 使用单服务器可管理的服务和中间件，保护个人资源所有权。

**Non-Goals:**

- 当前 change 不实现产品代码；实现前用户先进行原型调整和 UI 调试。
- 不支持多人同时编辑、项目共享/邀请、团队组织、在线光标、实时协作服务或离线同步。
- 不做视频/音频、公开市场、计费后台或任意用户代码插件。

## Decisions

1. **Monorepo：**pnpm workspace + Turborepo 管 TypeScript Web 和共享包；Python API/Worker 用 uv；根脚本统一开发与 Compose。
2. **Web：**React + TypeScript + Vite；画布使用 react-konva/Konva，平台定义 CanvasDocument/command schema，不绑定 Konva 序列化格式。
3. **画布保存：**PostgreSQL JSONB 存文档、schema_version、revision 和 viewport；保存携带 base_revision。旧 revision 拒绝覆盖并提示恢复，避免引入首版不需要的 CRDT 实时服务。
4. **API 与账户：**FastAPI + SQLAlchemy + Alembic 负责会话、user_id 所有权、项目、画布、素材和 Agent 运行 API。账户仅用唯一用户名和密码注册/登录，不收集邮箱或提供邮箱验证；MVP 允许登录后修改密码，不含忘记密码恢复，避免虚构尚未决定的恢复通道。
5. **多 Agent：**LangGraph Python 编排 Coordinator、Planner、Canvas Editor、Reviewer；状态图管理依赖、限额内并行和人工审批中断。图像生成/编辑专业角色等待用户提供接口后再加入。
6. **Worker：**Redis + ARQ 分发 Agent/长任务；父运行、子任务、工具终态持久化 PostgreSQL/LangGraph checkpointer；副作用使用幂等键。
7. **Agent 写回：**Agent 产出画布操作提案；用户接受后 API 重验资源所有权、权限和 base_revision，再保存为可追溯操作批次。
8. **图片：**MinIO 私有 bucket 存图片；PostgreSQL 存 asset metadata；用户素材只由所有者使用。
9. **部署：**单服务器 Compose 运行 Web、API、Worker、PostgreSQL、Redis、MinIO、Caddy；数据库和文件异机备份。

## User experience architecture

- 首页只显示“我的项目”和个人最近访问，无分享/成员面板。
- 编辑器采用黑色点阵无限画布，顶栏显示画布/保存状态，侧栏显示素材、图层和 Agent。
- Agent 面板显示 Coordinator 计划、Planner/Canvas Editor/Reviewer 任务树、依赖/并行、审批、部分失败、重试和变更预览。
- Image Creator 在当前 MVP 中为未接入能力，不展示可执行的生图/改图操作；后续按用户提供的接口文档开发。
- 原型以个人画布、保存冲突和多 Agent 工作流为主；不绘制多人 presence、对象占用或协作邀请页面。

## Security and privacy

- 所有 API 和工具按 user_id 检查项目、画布、素材和模型配置所有权。
- 密码只存安全哈希值；登录/注册实施用户名唯一性、尝试限流和安全会话。忘记密码恢复策略待 MVP 之后单独决策。
- BYOK 密钥加密存储、不回传；自定义模型地址只允许经过 SSRF 检查的 HTTPS 公网目标。
- Agent 使用工具白名单、参数 schema、幂等键、预算/并发/循环上限；收费/破坏性操作须用户确认。
- API Key 和敏感 Agent 上下文不进入日志或任务进度广播。

## Risks / Trade-offs

- [JSONB revision 不支持多人实时编辑] → MVP 明确单用户编辑；未来协作需另立需求、迁移方案和实时协议设计。
- [多 Agent 重试可能重复副作用] → 使用幂等键、子任务状态和可恢复 checkpointer。
- [多 Agent 并行增加模型费用] → 限定并发、超时、循环和预算，付费操作确认后执行。
- [单机中 PostgreSQL 与 MinIO 同时故障] → 异机备份并在部署前演练恢复。
- [Konva 不提供完整设计编辑器语义] → 对齐/多选/撤销由 canvas-core 按产品需要实现。

## Migration Plan

暂无运行代码和现有数据迁移。按 Monorepo/服务基础、账号项目、画布与素材、多 Agent、部署恢复分阶段实施；画布 revision 和素材所有权每阶段验证。

## References

- 技术选型见 `docs/03-decisions/ADR-0001-monorepo-and-stack.md`。
- 产品交互见 `docs/02-design/product-design.md`；架构和数据见 `docs/02-design/system-architecture.md`。
