# AGENTS.md：工作规则入口

本文件是 Codex 在仓库内工作的入口，负责说明先读什么、需求变化写到哪里、何时需要和用户确认，以及结束时如何交接。产品范围以 [`docs/PRODUCT.md`](docs/PRODUCT.md) 为准，技术边界以 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 为准。

## 每轮开始前

1. 阅读 `docs/session-handoff.md`，了解当前阶段、已完成事项和下一步。
2. 阅读 `docs/PRODUCT.md` 与 `docs/ARCHITECTURE.md`；涉及细节时再打开它们链接的模块文档和 OpenSpec。
3. 检查用户本轮的新指示。新指示优先于旧交接记录；如有冲突，更新对应事实来源。

## 需求和设计变化

- 产品范围、用户、MVP 包含/排除项变化：更新 `docs/PRODUCT.md`、`docs/01-product/PRD.md`、相关 OpenSpec specs 和原型说明。
- 技术栈、数据流、部署、存储或安全约束变化：更新 `docs/ARCHITECTURE.md`、`docs/02-design/system-architecture.md`，必要时更新 ADR 与 OpenSpec design/specs。
- 原型和参考图按用途分别放在 `docs/02-design/prototypes/` 与 `docs/99-archive/references/`；过时材料归档，不静默覆盖或删除。
- 入口文档只概括现状并链接到详细模块；避免在多个文件维护同一份完整规范。

## 外部技术文档与 API 调研

- 涉及框架、库、SDK、CLI、云服务或 API 的选型、配置和用法时，优先通过 Context7 获取当前文档；先调用 `resolve-library-id` 获取准确 library ID，再用 `query_docs` 按当前语言/版本查询具体主题。
- 记录查阅日期、版本/接口版本、官方来源链接和会影响本项目的结论；不要把训练记忆或旧代码示例当作当前 API 依据。
- 用户将提供的第三方接口，以用户提供的接口文档/示例为事实来源；若文档未说明鉴权、请求/响应、异步任务、费用或失败语义，先列出缺项，不猜测接口。
- 不向文档查询服务发送 API Key、密码、私人项目数据或敏感请求内容。

## 什么时候问用户

- 只有在答案会改变产品范围、用户数据/费用、安全边界、对外服务或不可逆行为时，才暂停并询问。
- 其他排版、归档、链接和文档拆分按本文件与当前上下文直接处理。

## 每轮结束时

- 更新 `docs/session-handoff.md`：日期、当前阶段、做了什么、验证结果、未决项和下一步。
- 如果改动 OpenSpec 文档，运行 `openspec validate --all --no-interactive`。
- 不把静态检查说成完整产品流程验证；未执行的检查明确标记为未执行。

## OpenSpec 工作流

- 本仓库已经初始化 OpenSpec，根目录是 `openspec/`；Artifacts 默认中文，结构标题和 MUST/WHEN/THEN 保持英文。
- 在 Codex 里可以用 `$openspec` 选择工作流，也可以在打开本仓库时直接调用：
  - `$openspec-explore`：讨论和调查。
  - `$openspec-propose`：新建完整变更计划。
  - `$openspec-update-change`：修订现有计划。
  - `$openspec-apply-change`：实施选定变更。
  - `$openspec-sync-specs`：同步稳定规格。
  - `$openspec-archive-change`：归档完成的变更。
- OpenSpec CLI 命令从仓库根目录运行。`$` 后面是 skill 名；终端里的 `openspec` 是 CLI 命令。
