# 需求关系图

> MVP 核心：个人账户和项目、无限画布、图片素材、多 Agent 自主协作。

## 需求树

```mermaid
mindmap
  root((在线无限画布))
    账户与项目
      注册登录和账户安全
      个人项目/画布管理
      user_id 所有权校验
    无限画布
      缩放/平移/视口恢复
      图片/文字/基础形状
      选择/多选/变换/图层
      自动保存/撤销/版本保护
    多 Agent 自主协作
      Coordinator
      任务图/依赖/并行
      Planner
      Canvas Editor
      Reviewer
      BYOK 模型配置/角色映射
      审批/预算/取消/重试
      结果预览/应用/撤销
    图片素材
      私有上传与 MinIO
      多选加入画布
      多选附加给 Agent
    单服务器部署
      Web/API/Worker
      PostgreSQL/Redis/MinIO
      Compose/HTTPS/异机备份
```

## 数据和能力映射

| 需求 | 主要数据/组件 | MVP 优先级 |
|---|---|---|
| 账户和会话 | users、sessions | P0 |
| 个人项目 | projects、owner_id | P0 |
| 画布文档和冲突保护 | canvases.document JSONB、revision、canvas_versions | P0 |
| 图片素材 | assets、StorageAdapter、MinIO | P0 |
| 用户模型配置 | model_configs（密钥加密） | P0 |
| Agent 角色 | agent_role_configs | P0 |
| Agent 父运行和子任务 | agent_runs、agent_tasks、tool_runs、checkpoints | P0 |
| 长任务 | Redis/ARQ、Worker、PostgreSQL 运行状态 | P0 |
| 多人实时编辑 | — | 当前不纳入 MVP |
| 外部生图/改图接口 | Image Creator 适配层预留 | 后续，等待用户接口文档 |

## Agent 执行流程

```mermaid
sequenceDiagram
  actor User as 用户
  participant Web as Web/Agent 面板
  participant API as FastAPI
  participant DB as PostgreSQL
  participant Q as Redis/ARQ
  participant Worker as LangGraph Worker
  participant LLM as 用户模型服务
  User->>Web: 目标 + 参考图片
  Web->>API: 创建 AgentRun + canvas revision
  API->>DB: 校验所有权并持久化运行
  API->>Q: 派发 Coordinator 任务
  Q->>Worker: 恢复/运行任务图
  Worker->>LLM: Coordinator 规划并派发子 Agent
  Worker-->>API: 计划/子任务状态/结果
  API-->>Web: SSE 状态与审批卡片
  User->>Web: 审批并接受操作预览
  Web->>API: 提交操作批次和 base_revision
  API->>DB: 重验所有权/幂等键/revision
  API-->>Web: 保存成功或 revision 冲突
```

## 原型与规格对应

| 页面 | OpenSpec capability |
|---|---|
| 登录/注册/账户/项目 | identity-projects |
| 无限画布/保存/撤销 | canvas-editing |
| 图片库/上传/引用 | asset-storage |
| Agent 设置/任务树/审阅 | agent-orchestration |

UI 调试顺序：页面和账户 → 单用户画布 → 素材流 → 多 Agent 任务树与审批 → 保存失败/revision 冲突/任务错误状态。多人实时编辑暂不设计。
