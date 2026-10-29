# Proposal

## Why

用户从零规划一款线上无限画布平台，MVP 核心是个人云端画布和多个 Agent 协助创作。当前明确先不做多人同时编辑，因此规格集中于个人账户/项目、画布持久化、图片素材和可控多 Agent。

## What Changes

- 定义用户名/密码账户、个人项目、画布及 user_id 所有权行为；不收集邮箱，忘记密码恢复暂不纳入 MVP。
- 定义无限画布编辑、JSONB 自动保存、revision 冲突保护与恢复。
- 将创作 Agent 定义为 Coordinator 与专业 Agent 的自主规划、依赖委派、限额并行、审批、审阅和结果写回。
- 定义图片素材、BYOK 模型配置和个人资源隔离。
- 定义单服务器 monorepo、PostgreSQL、Redis/ARQ、MinIO 技术路线。
- 提供页面交互与技术设计，支撑原型补充和 UI 前端调试；当前不实现产品代码。

## Capabilities

### New Capabilities
- identity-projects: 用户身份、个人项目和所有权隔离。
- canvas-editing: 无限画布编辑、自动保存、revision 冲突和恢复。
- asset-storage: 私有图片上传、元数据、画布引用和授权访问。
- agent-orchestration: 多 Agent 规划、依赖委派、限额并行、审批、任务状态和结果审阅。

### Modified Capabilities

无。当前项目尚无已归档的稳定能力规格。

## Impact

- 规划中的 `apps/web`、`apps/api`、`apps/worker`、`packages/*` 和 `infra`。
- React/TypeScript、Konva、FastAPI、LangGraph、PostgreSQL、Redis/ARQ、MinIO。
- PRD、页面交互设计、技术 ADR、架构图、数据模型与阶段计划。
- 当前 change 不包含 Yjs/Hocuspocus 或多人实时编辑服务。
