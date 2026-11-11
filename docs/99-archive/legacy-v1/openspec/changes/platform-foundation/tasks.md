# Tasks

## 1. 产品设计与 UI 基线

- [x] 1.1 完成 PRD、个人编辑产品交互、系统架构、数据模型与技术选型；通过跨文档范围核对和 OpenSpec 校验。
- [ ] 1.2 补齐个人项目、画布保存/冲突和多 Agent 并行/审批/结果审阅原型；通过原型清单走查。顶栏图片导入、底部目标输入/右侧真实任务树与并行分组、对话清空及保存失败/版本冲突交互已实现；全量原型清单复核仍待完成。
- [x] 1.3 按前端 UI 计划建立 React/Vite/TypeScript、React Router、Tailwind、shadcn/ui 配置、Lucide 与 react-konva 基础框架；通过路由、静态页面、桌面/窄屏参考图走查。

## 2. Monorepo 与单机基础设施

- [x] 2.1 建立 apps/web、apps/api、apps/worker、packages 与 infra；补充模块职责和根级开发说明。
- [x] 2.2 配置 pnpm/Turborepo 与 Python/uv 工作区、锁文件和 API/Worker 根命令；前端依赖安装和服务启动说明已复核。
- [x] 2.3 建立 Docker Compose、Caddy HTTPS 路由和健康检查；本机从镜像构建到整栈启动完成，Web 首页与 API 探活返回 200，database/queue 均为 ok。
- [ ] 2.4 配置 PostgreSQL、Redis、MinIO 持久卷和异机备份；本机重启持久性与 PostgreSQL/MinIO 备份恢复演练通过，异机备份目的地尚未配置或实测。

## 3. 账户与个人项目

- [x] 3.1 实现用户名/密码注册、登录/退出、改密和账户注销；集成验证覆盖注册、重复用户名、改密后会话轮换与注销。
- [x] 3.2 建立初始迁移与 user_id 所有权检查；集成验证覆盖跨用户画布/素材拒绝。
- [x] 3.3 实现个人项目/画布列表、创建、重命名和删除；集成验证覆盖项目/画布创建及项目删除。

## 4. 无限画布与云端保存

- [x] 4.1 建立 CanvasDocument/元素 schema 与 react-konva 渲染；前端基础编辑交互和共享类型已实现。
- [x] 4.2 实现 JSONB 快照、schema_version、revision、原子 base_revision 检查和 canvas_versions；集成验证覆盖保存及旧 revision 拒绝。
- [x] 4.3 自动保存接入 revision API；UUID 画布本地草稿跨刷新恢复、保存失败后手动/自动重试、revision 冲突显式选择本地/云端版本、本地撤销历史限量及云端历史版本浏览/恢复已实现。隔离 API 与浏览器联调验证历史恢复、revision 单调递增、恢复后撤销，以及模拟断网和重新联网后的自动重试。

## 5. 个人图片素材

- [x] 5.1 图片格式/像素校验、私有对象接口和素材元数据已实现；Compose MinIO 持久卷、私有 bucket 与 bucket 范围 app 凭证已实机启动；真实图片上传/读取、匿名拒绝和 MinIO 重启后的对象读取均通过。
- [x] 5.2 实现素材搜索、收藏、画布引用和 Agent 参考图；集成验证覆盖搜索、收藏、私有读取和跨用户拒绝。

## 6. 多 Agent 自主协作

- [x] 6.1 已实现模型配置加密、HTTPS/公网地址校验、登录后连接测试及按四个角色保存模型 ID；隔离 Worker 验证确认调用了各自模型。外部模型服务的真实连通性仍需用户提供有效凭证验证。
- [x] 6.2 已接入 Coordinator 最多拆 3 个带依赖子任务、Planner 逐项规划、独立 Canvas Editor 并行（上限 3）和 Reviewer 合并审阅；隔离 SQLite + 假模型验证覆盖依赖、并行、任务状态和工具白名单，前端按动态任务列表展示。
- [x] 6.3 运行状态、事件、SSE 与 SQLite/PostgreSQL checkpointer 已实现；同一 AgentRun 最多自动重试 3 次。真实 Worker 在 Planner 阶段被强制终止后，ARQ 等执行租约过期再派发同一任务；PostgreSQL 检查点使 Coordinator 无重复调用，Planner 续跑并完成 Editor/Reviewer。孤立运行定时对账验证会标记失败，仍排队或有执行租约的运行保持活动。MVP 由 Reviewer 完成后生成待审提案，AgentRun 已终态，不需要额外暂停 Worker 等用户审批。
- [x] 6.4 已实现工具 allowlist、参数/所有权/幂等校验、取消/重试及持久模型调用预算；每次运行最多 12 次模型调用、单次输出默认限制 2048 token，自动恢复共享同一额度并在面板展示报告用量。隔离 SQLite 联调用例覆盖额度耗尽、并发预留和 token usage 缺失；真实 Redis/ARQ 崩溃重派验证确认重试沿用同一 AgentRun 及模型调用计数。真实外部模型服务仍需用户凭证。
- [x] 6.5 提案预览、接受/拒绝及 revision 条件写回已实现；一次 Agent 应用作为一个撤销批次，撤销/重做自动保存整批并同步 Reviewer 状态，云端版本恢复作为刷新后的恢复入口。Playwright 假 API 联调验证应用、revision 写回、整批撤销、Reviewer 状态、整批重做和第二次保存。
- [x] 6.6 底部生成参数随 AgentRun 持久化，Worker 使用抽象 Image Creator Provider；结果先作为临时私有图片展示，用户可保存或加入画布。默认 Provider 不联网；隔离假 Provider 验证覆盖参数传递、参考图字节、结果校验和临时素材保存。

## 7. MVP 集成与可恢复性

- [x] 7.1 串联注册、个人项目、画布编辑、素材选择、多 Agent 运行和结果审阅；隔离 FastAPI/SQLite 联调及 API→Worker→提案应用验证通过，覆盖账户、画布、素材、Agent 入队与 revision 写回。
- [x] 7.2 增加关键事件审计、日志脱敏、服务资源和 Agent 并发限制；SQLite 验证关键审计记录及密码/API Key/提示词/文件名不进入审计详情，第 4 个并发 run 返回 429；模拟 Provider 抛出含密钥/提示词的异常后，日志仅输出 run ID 和异常类型。
- [ ] 7.3 已加入 Web/API/Worker/PostgreSQL/Redis/MinIO/Caddy Compose、数据库迁移启动、健康依赖、备份和显式确认恢复脚本；本机镜像构建、全新部署、健康检查及 PostgreSQL/MinIO 恢复演练通过；异机备份目的地尚未配置或验证。

## Workflow follow-up

- 前端关键流程已接入 API；本地草稿恢复、断网自动重试、冲突选择、云端历史版本恢复、Agent 取消/失败重试、并行子任务状态和角色模型配置均已实现并完成隔离联调。
- 多人同时编辑不在当前 change 中；未来需求确认后另行规划。
- 生图 Provider 协议和 Image Creator 任务路径已实现但默认未配置；收到用户提供的实际接口文档后再开发供应商适配器。
- MVP 规格与任务完成并验收后，再归档 `platform-foundation`。
