# 原型图目录

当前图片是视觉参考，尚不是已实现的交互原型。MVP 按单用户编辑设计，不需要多人邀请、在线光标或实时协作原型。原型流程和组件状态以[产品交互说明](../product-design.md)为准。

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

## 下一轮补充/重画

1. 项目首页空状态、项目卡片和新建项目流程。
2. 无限画布对象选中、多选、图片拖入、保存失败/版本冲突。
3. Agent 角色模型映射、连接失败状态。
4. Agent 任务树的并行执行、等待审批、部分失败重试、结果预览/应用。
5. 用户名/密码注册、登录和账户设置的表单错误和成功状态；不设计邮箱验证/找回密码。
6. 窄屏素材、图层和 Agent 面板折叠状态。

## 视觉方向

沿用黑色工作区、低对比灰色点阵和简洁工具栏。提示词库、音乐/视频仍不属于 MVP。旧的浅色画板图已归档。
