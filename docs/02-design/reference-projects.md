# 参考项目：可借鉴点与边界

## Jaaz

参考源：`/Users/leileigwl/Work/Learn/new/jaaz-main`

- [画布组件](</Users/leileigwl/Work/Learn/new/jaaz-main/react/src/components/canvas/CanvasExcali.tsx>) 使用 Excalidraw，并对画布变更做约 1 秒防抖保存。
- [chat_service.py](</Users/leileigwl/Work/Learn/new/jaaz-main/server/services/chat_service.py>) 把用户消息、canvas_id、模型和工具列表交给 Agent 流程。
- [agent_service.py](</Users/leileigwl/Work/Learn/new/jaaz-main/server/services/langgraph_service/agent_service.py>) 按工具配置创建 Agent；[StreamProcessor.py](</Users/leileigwl/Work/Learn/new/jaaz-main/server/services/langgraph_service/StreamProcessor.py>) 把文本、工具调用和结果通过 WebSocket 发回前端。
- 借鉴：Agent 获取画布上下文、调用工具、流式反馈；MVP 使用受限的 Coordinator + 专业 Agent 任务图，明确依赖、并发上限和人工审批，不做开放式 Agent 循环。
- 保存链路仍采用本地 SQLite/本机文件结构；线上存储要改为数据库服务和云对象存储。

## AI 修图项目

参考源：`/Users/leileigwl/Work/Learn/new/AI 修图智能体项目教程/ai-picture-editor-main`

- [Agent graph](</Users/leileigwl/Work/Learn/new/AI 修图智能体项目教程/ai-picture-editor-main/backend/app/agent/graph.py>) 让模型根据画布摘要产生工具计划，再由服务端校验；模型输出不会直接执行。
- [Plan 校验](</Users/leileigwl/Work/Learn/new/AI 修图智能体项目教程/ai-picture-editor-main/backend/app/agent/plan.py>) 校验工具、参数、步骤依赖和计划长度；[Agent API](</Users/leileigwl/Work/Learn/new/AI 修图智能体项目教程/ai-picture-editor-main/backend/app/routers/sessions.py>) 提供确认、取消和重试。
- [AgentRun](</Users/leileigwl/Work/Learn/new/AI 修图智能体项目教程/ai-picture-editor-main/backend/app/models/agent_run.py>) 保存计划和状态，支持恢复；[ToolRun](</Users/leileigwl/Work/Learn/new/AI 修图智能体项目教程/ai-picture-editor-main/backend/app/models/tool_run.py>) 记录单个工具运行。
- [任务服务](</Users/leileigwl/Work/Learn/new/AI 修图智能体项目教程/ai-picture-editor-main/backend/app/services/tools.py>) 将长任务送进 ARQ/Redis，最终状态保存在 PostgreSQL，并通过事件推送进度。
- 借鉴：工具注册表、服务端参数/权限验证、可恢复运行记录和明确的取消/重试；当前 MVP 拆分 Planner、Canvas Editor 和 Reviewer；外部生图/改图 API 后续再加入 Image Creator。
- 当前 MVP 已按你的选择暂定 MinIO；参考项目的 MinIO 版本与当前官方发行版并不自动等价，实施前仍要核对维护状态和许可。

## 综合结论

MVP 做一组可控的创作 Agent：Coordinator 管任务图，Planner、Canvas Editor 和 Reviewer 产出计划、画布操作和检查结果；API 校验所有权和副作用，Worker 运行长任务，结果由用户审阅后写回个人画布。所有运行、子任务和结果均可追踪。图像生成与编辑接口以后由用户提供，单独接入 Image Creator。
