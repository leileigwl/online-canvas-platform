# platform-foundation

定义个人在线无限画布的 MVP 产品与技术基线：账户/个人项目、画布保存、图片素材和多 Agent 创作。

## 当前状态

- 需求分析、PRD、产品交互、技术 ADR 和 OpenSpec 规格已完成。
- Web 已接通账户/项目/画布/素材/模型配置和 Agent 任务；底部唯一目标输入通过任务设置区分 Coordinator 画布协作与 Image Creator 图片生成。
- LangGraph 四角色流程支持最多 3 个带依赖子任务、独立 Editor 并行和角色模型 ID；取消、重试、检查点恢复及孤立运行对账已在真实 Redis/PostgreSQL/ARQ Compose 环境验证。单机 Compose 和本机备份恢复已完成，异机备份目的地仍未配置。
- 多人同时编辑与相关实时同步服务不在本 change 范围。
- 生图 Provider 协议、Image Creator Worker、参数持久化和结果校验已实现；默认不调用外部服务。真实生图/改图供应商仍等待用户提供接口文档，见[接入预案](../../../docs/02-design/image-provider-integration.md)。

## 规格能力

- `identity-projects`：账户、个人项目和所有权隔离。
- `canvas-editing`：无限画布对象、JSONB 保存/恢复、revision 冲突和撤销。
- `asset-storage`：私有图片上传、元数据、画布引用和用户所有权。
- `agent-orchestration`：Coordinator、专业 Agent、依赖/并行、审批和结果审阅。

## 相关资料

- 产品：[docs/PRODUCT.md](../../../docs/PRODUCT.md)、[PRD](../../../docs/01-product/PRD.md)、[交互设计](../../../docs/02-design/product-design.md)
- 技术：[架构](../../../docs/02-design/system-architecture.md)、[ADR-0001](../../../docs/03-decisions/ADR-0001-monorepo-and-stack.md)
- 计划：[tasks.md](tasks.md)
