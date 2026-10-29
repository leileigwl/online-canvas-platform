# platform-foundation

定义个人在线无限画布的 MVP 产品与技术基线：账户/个人项目、画布保存、图片素材和多 Agent 创作。

## 当前状态

- 需求分析、PRD、产品交互、技术 ADR 和 OpenSpec 规格已完成。
- 下一步补 Agent 原型并进行 UI 前端调试。
- 当前没有应用功能实现；tasks.md 是实施清单。
- 多人同时编辑与相关实时同步服务不在本 change 范围。
- 生图/改图接口等待用户提供，当前只记录[接入预案](../../../docs/02-design/image-provider-integration.md)，不属于本 change 的 MVP 实现任务。

## 规格能力

- `identity-projects`：账户、个人项目和所有权隔离。
- `canvas-editing`：无限画布对象、JSONB 保存/恢复、revision 冲突和撤销。
- `asset-storage`：私有图片上传、元数据、画布引用和用户所有权。
- `agent-orchestration`：Coordinator、专业 Agent、依赖/并行、审批和结果审阅。

## 相关资料

- 产品：[docs/PRODUCT.md](../../../docs/PRODUCT.md)、[PRD](../../../docs/01-product/PRD.md)、[交互设计](../../../docs/02-design/product-design.md)
- 技术：[架构](../../../docs/02-design/system-architecture.md)、[ADR-0001](../../../docs/03-decisions/ADR-0001-monorepo-and-stack.md)
- 计划：[tasks.md](tasks.md)
