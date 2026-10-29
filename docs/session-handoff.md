# Session handoff

> 最后更新：2026-10-29

## 当前阶段

MVP 收敛为个人在线无限画布和多 Agent 创作；产品/技术文档已同步。前端 UI 技术与视觉实施计划已完成，下一步开始前端静态页面和画布壳层；尚未开始功能代码。

## 已确认范围

- 黑色点阵无限画布，唯一用户名/密码账户和基础自助管理，不收集邮箱；个人项目、画布和素材。
- 多 Agent 自主规划：Coordinator 调度 Planner、Canvas Editor、Reviewer；有依赖/并行限制、审批、失败重试和结果审阅。Image Creator 等用户提供生图/改图 API 后再接入。
- Agent 的作用是将创作目标转换为有权限边界、可审阅且可撤销的画布操作；用户只提交一次目标，由 Coordinator 自动组织专业角色。
- 账户使用唯一用户名和密码；不提供邮箱验证/找回，忘记密码恢复暂不纳入 MVP。
- 用户配置 OpenAI 兼容模型，按角色映射；API Key 服务端加密。
- 图片素材通过 MinIO 私有存储；PostgreSQL 保存业务数据、画布 JSONB/revision 和 Agent 状态；Redis + ARQ 执行长任务。
- 生图和改图接口由用户后续提供；当前只记录[接入预案](02-design/image-provider-integration.md)，不开发调用。
- **多人同时编辑同一画布暂不纳入 MVP。**项目邀请、成员角色、在线光标、Yjs/Hocuspocus 实时同步一并延期。

## 设计入口

- 产品：[PRODUCT.md](PRODUCT.md)、[PRD](01-product/PRD.md)
- 交互：[产品设计](02-design/product-design.md)、[原型目录](02-design/prototypes/README.md)
- 技术：[ARCHITECTURE.md](ARCHITECTURE.md)、[系统架构](02-design/system-architecture.md)、[ADR-0001](03-decisions/ADR-0001-monorepo-and-stack.md)
- 规格与任务：[platform-foundation](../openspec/changes/platform-foundation/README.md)
- 前端实施：[前端 UI 开发计划](02-design/frontend-ui-plan.md)

## OpenSpec 状态

- 当前 change：`platform-foundation`，schema `spec-driven`。
- 能力规格：identity-projects、canvas-editing、asset-storage、agent-orchestration。
- 当前任务清单 1/23 完成（设计文档）；其余原型、UI、账号/项目、JSONB 画布、MinIO 和多 Agent 工作待做。不包含多人实时协作。

## 下一步

1. 按前端 UI 计划建立 Web 脚手架和页面路由，先用静态 fixture 复刻项目首页、素材页、画布布局和 Agent 面板。
2. 再实现画布选取/拖放/变换以及多 Agent 状态预览；按参考图走查桌面和窄屏。
3. UI 结构稳定后按 OpenSpec tasks 实现 API、Worker 和单机部署。

## 本次验证

- `openspec validate --all --strict --no-interactive` 通过（1 个 change）；27 个 Markdown 文件的相对链接检查通过。
- 已补充多 Agent 的商品海报示例和产品价值说明，明确用户只提交一次目标、结果先审阅后写回；生图/改图 API 暂不开发，等待用户提供接口文档。
- 账号需求已改为用户名/密码；同步修改 README、PRD、产品边界、交互和原型说明、数据模型及 OpenSpec，不收集邮箱。
- README 已按 GitHub 项目介绍和 SEO/GEO 可读性重写，明确项目状态、Agent 作用、MVP、技术方案、路线图、FAQ、文档入口及求职作品集用途；MIT 许可证已添加。Git 根仅为 `online-canvas-platform`，个人备忘录已排除在提交范围外。
- 用户已确定采用 MIT；仓库根目录添加标准 MIT `LICENSE`，README 中英文内容和 FAQ 已同步更新。
- 已检查现有项目首页、无限画布、素材库和 Agent 设置原型。React + Konva 能实现画布效果；新增 React Router 7、Tailwind CSS 4、shadcn/ui、Lucide React 作为页面/UI 层方案，并通过 Context7 记录官方文档及版本核对要求。
- 新增[前端 UI 开发计划](02-design/frontend-ui-plan.md)，定义黑色点阵视觉令牌、CSS 点阵背景、页面布局、DOM/Konva 职责边界、开发顺序和截图走查点；尚未编写前端代码或锁定依赖版本。
- `AGENTS.md` 已规定涉及技术库和 API 时使用 Context7 先查当前官方文档；本轮 LangGraph 的 State/Nodes/Edges、并行、审批中断和持久化设计已按 Context7 文档记录。
- 架构图已更新为单用户画布和多 Agent 部署，不含 Hocuspocus/Yjs。
- 本轮只更新产品/技术文档，没有运行应用构建、测试或端到端流程。
