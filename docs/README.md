# Docs 导航

## 四个入口文档

- [AGENTS.md](../AGENTS.md)：Codex 工作规则、每轮阅读顺序、改需求的落点和交接要求。
- [PRODUCT.md](PRODUCT.md)：产品边界、MVP 包含/排除项和未决问题。
- [ARCHITECTURE.md](ARCHITECTURE.md)：系统结构、技术约束和安全边界。
- [session-handoff.md](session-handoff.md)：当前进度、OpenSpec 状态、未决事项和下一步；每轮有实质进展后更新。

入口文件用于快速恢复上下文，细节按模块放在下面的文档中；行为契约以 OpenSpec 为准。

## 01 产品

- [PRD](01-product/PRD.md)：用户故事、主要流程和验收口径。

## 02 设计

- [需求关系图](02-design/requirements-map.md)：需求树、依赖和数据映射。
- [产品与交互设计说明](02-design/product-design.md)：页面清单、单人画布、保存状态和 Agent 流程，用于原型重画和 UI 调试。
- [生图与改图 API 接入预案](02-design/image-provider-integration.md)：后续用户提供接口后再定协议并开发，当前仅记录接入边界。
- [系统架构图、时序图和数据关系图](02-design/system-architecture.md)
- [参考项目拆解](02-design/reference-projects.md)：Jaaz 与 AI 修图项目的可借鉴部分。
- [原型目录](02-design/prototypes/README.md)：当前视觉稿和重画说明。

## 03 决策

- [ADR-0001：Monorepo 与技术路线](03-decisions/ADR-0001-monorepo-and-stack.md)：方案与取舍。

## 04 路线图

- [产品与工程路线图](04-roadmap/roadmap.md)：阶段目标与实施边界。

## 05 计划

- [在线画布平台基线计划](05-plans/online-canvas-foundation.md)：规划过程的推进记录。

## 99 归档

- [归档索引](99-archive/README.md)：旧参考图、视觉实验稿、结构示意图和空文件占位。

## OpenSpec

- [当前 change](../openspec/changes/platform-foundation/README.md)：行为规格、设计和任务。
- [稳定规格目录](../openspec/specs/)：已同步的长期规格（当前为空，待确认后同步）。

## 文档状态

- **讨论稿**：仍在与用户对齐。
- **Proposed**：方案建议，尚未确认。
- **已确认**：用户确认并同步到 OpenSpec 的行为契约。
