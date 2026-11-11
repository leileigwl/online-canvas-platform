# 在线画布平台产品设计基线记录

> 当前 MVP 选择个人单用户编辑与多 Agent 创作；多人实时编辑暂不考虑。

## 已完成

- 黑色点阵无限画布、用户名/密码账户、个人项目和图片素材范围；不收集邮箱。
- 多 Agent 自主规划：Coordinator + Planner/Canvas Editor/Reviewer；外部图像 API 后续提供后再接入 Image Creator。
- 用户自带 OpenAI 兼容模型、按 Agent 角色映射、服务端密钥加密。
- PostgreSQL JSONB + revision 画布保存、Redis/ARQ 长任务、MinIO 私有图片存储。
- 产品交互、架构/数据图、技术 ADR 和 OpenSpec 行为规格/任务。

## 当前不包含

- 多人同时编辑、项目成员邀请/角色、实时光标和 CRDT 同步。
- 尚未实现 Monorepo 应用代码、API、数据库迁移或 Agent Worker。
- 已有原型图为早期风格参考，需补充多 Agent 任务树、审批、结果审阅及画布保存状态。

## 下一步

1. 按[原型清单](../02-design/prototypes/README.md)补 Agent 和画布保存原型。
2. 进入 UI 前端调试，先用模拟数据走通页面、画布和 Agent 状态。
3. UI/交互稳定后，按 OpenSpec tasks 开始实现 API、Worker 和单机部署。
