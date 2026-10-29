# 原型图目录

当前图片是视觉参考；`apps/web` 已有首版静态与交互实现。MVP 按单用户编辑设计，不需要多人邀请、在线光标或实时协作原型。产品流程以[产品交互说明](../product-design.md)为准，页面实现状态见[前端 UI 开发计划](../frontend-ui-plan.md)。

前端如何从视觉参考进入静态页面和交互实现，见[前端 UI 开发计划](../frontend-ui-plan.md)。

## 当前原型参考

登录和注册图片是早期视觉参考，不代表最终账号字段；当前产品基线是唯一用户名 + 密码，不采集邮箱。交互稿更新时应同步去掉邮箱输入、邮箱验证和找回密码。

- [01-project-home.png](01-project-home.png)：个人项目首页。
- [02-infinite-canvas-editor.png](02-infinite-canvas-editor.png)：黑色点阵无限画布。
- [03-asset-library.png](03-asset-library.png)：图片素材库。
- [04-login.png](04-login.png)：登录。
- [05-register.png](05-register.png)：注册。
- [06-account-settings.png](06-account-settings.png)：资料与账户安全。
- [07-agent-settings.png](07-agent-settings.png)：OpenAI 兼容模型设置。
- [prototype-notes.md](prototype-notes.md)：页面和状态说明。

## 仍待补充/重画

1. 项目空状态、创建/重命名/删除等项目流程。
2. 画布多选、拖放图片、云端保存失败和 revision 冲突恢复。
3. Agent 角色模型映射与真实连接成功/失败状态。
4. Agent 任务取消、部分失败重试和真实操作差异预览。
5. 账户端到端错误、成功和服务端验证状态；不设计邮箱验证/找回。
6. 窄屏素材管理、图层/Agent 面板抽屉细节。

## 视觉方向

沿用黑色工作区、低对比灰色点阵和简洁工具栏。提示词库、音乐/视频仍不属于 MVP。旧的浅色画板图已归档。

## 当前前端交互范围

- Canvas Stage 支持选择/拖动对象、空格平移、滚轮缩放、缩放手柄变换、复制、删除、撤销和重做。
- 文字便签、形状和连接线工具可在画布空白处创建对象；图片工具选择本地文件插入画布。
- 素材库支持搜索、筛选、多选；多选图片可以加入当前画布。Agent 面板可以多选/移除参考素材。
- Agent 面板展示 Coordinator、Planner、素材分析、Canvas Editor 和 Reviewer 的任务关系，提供本地演示的提案接受/拒绝流程。未调用模型或后端。
- 保存状态只表示本地原型中的编辑状态，不代表云端持久化；用户登录、上传、模型连接和任务均未接入服务端。
