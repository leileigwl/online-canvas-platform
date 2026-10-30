# Tasks

## 1. 产品设计与 UI 基线

- [x] 1.1 完成 PRD、个人编辑产品交互、系统架构、数据模型与技术选型；通过跨文档范围核对和 OpenSpec 校验。
- [ ] 1.2 补齐个人项目、画布保存/冲突和多 Agent 并行/审批/结果审阅原型；通过原型清单走查。当前已补顶栏工具栏、图片/文本框加入 Agent 上下文、右侧对话临时图片导入/保存到资产和轻量选中框；保存冲突与失败恢复状态仍待补。
- [x] 1.3 按前端 UI 计划建立 React/Vite/TypeScript、React Router、Tailwind、shadcn/ui 配置、Lucide 与 react-konva 基础框架；通过路由、静态页面、桌面/窄屏参考图走查。

## 2. Monorepo 与单机基础设施

- [ ] 2.1 建立 apps/web、apps/api、apps/worker、packages 与 infra；通过目录职责和根级开发说明复核。
- [ ] 2.2 配置 pnpm/Turborepo 与 Python/uv 工作区、锁文件和根命令；通过依赖安装和服务启动说明复核。
- [ ] 2.3 建立 Docker Compose、Caddy HTTPS 路由和健康检查；通过本机启动后 Web/API 探活复核。
- [ ] 2.4 配置 PostgreSQL、Redis、MinIO 持久卷和异机备份；通过重启保留数据及备份恢复演练复核。

## 3. 账户与个人项目

- [ ] 3.1 实现用户名/密码注册、登录/退出、登录后改密码和账户设置；通过账户流程、用户名冲突和会话过期复核，不实现邮箱验证/找回。
- [ ] 3.2 建立 users/projects/canvases 初始迁移与 user_id 所有权检查；通过跨用户访问拒绝流程复核。
- [ ] 3.3 实现个人项目/画布列表、创建、重命名和删除；通过项目全流程及数据清理规则复核。

## 4. 无限画布与云端保存

- [ ] 4.1 建立 CanvasDocument/元素 schema 与 react-konva 渲染；通过图片/文字/形状/画笔增删改、框选多对象、图层显隐、平移缩放和对象变换走查。当前前端原型交互已补齐，schema 与服务端持久化待后续实现。
- [ ] 4.2 实现 JSONB 快照、schema_version、revision、base_revision 检查和 canvas_versions；通过重开恢复及旧 revision 拒绝复核。
- [ ] 4.3 实现自动保存、失败草稿、撤销/重做和版本恢复；通过断网、重试、冲突提示和操作批次复核。

## 5. 个人图片素材

- [ ] 5.1 实现图片校验、MinIO 私有上传和素材元数据；通过有效/无效/超限上传与服务重启持久性复核。
- [ ] 5.2 实现素材搜索、多选、插入画布和附加 Agent；通过 user_id 权限和 asset ID 引用复核。

## 6. 多 Agent 自主协作

- [ ] 6.1 实现模型配置加密、HTTPS/SSRF 校验、连接测试和 Agent 角色模型映射；通过密钥不回显和地址拦截复核。
- [ ] 6.2 建立 LangGraph Coordinator、Planner、Canvas Editor、Reviewer 和父子任务记录；通过依赖及并行上限复核。
- [ ] 6.3 建立 PostgreSQL checkpoint、审批暂停/恢复、状态事件和 SSE；通过 Worker 重启恢复及用户数据隔离复核。
- [ ] 6.4 实现工具 allowlist、参数/所有权/幂等校验、预算限制、取消和失败重试；通过越权拒绝和重复任务不重复副作用复核。
- [ ] 6.5 实现 Agent 画布操作预览、接受/拒绝及 revision 校验写回；通过旧画布版本保护和操作批次撤销复核。

## 7. MVP 集成与可恢复性

- [ ] 7.1 串联注册、个人项目、画布编辑、素材选择、多 Agent 运行和结果审阅；通过核心个人用户流程验收矩阵复核。
- [ ] 7.2 增加关键事件审计、日志脱敏、服务资源和 Agent 并发限制；通过敏感信息扫描和超限行为复核。
- [ ] 7.3 完成单机部署、异机备份/恢复说明和故障恢复手册；通过全新部署和 PostgreSQL/MinIO 恢复演练复核。

## Workflow follow-up

- 产品设计文档和首版前端 UI 原型持续按备忘录调整；保存冲突/失败恢复等原型状态仍需补齐，再进入 API 与 Worker 开发。
- 多人同时编辑不在当前 change 中；未来需求确认后另行规划。
- 生图/改图 API 等用户提供接口和文档后另行规划；当前不开发其调用。
- MVP 规格与任务完成并验收后，再归档 `platform-foundation`。
