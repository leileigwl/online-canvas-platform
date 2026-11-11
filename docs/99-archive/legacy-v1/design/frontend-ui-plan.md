# 前端 UI 开发计划

> 状态：前端页面与 FastAPI 已接通；UUID 画布保存/冲突恢复、资产上传与收藏、Agent 角色配置、任务进度、提案审阅和图像参数提交均已实现。底部唯一输入明确区分画布协作与图片生成；窄屏抽屉、空状态和部分任务失败的全量视觉复核仍待完成。视觉基准为 `docs/02-design/prototypes/` 下的页面参考图。

## 1. 结论：现有画布栈够用，补齐 UI 层即可

React + TypeScript + Vite + react-konva 可以实现参考图中的无限画布、图片/文字/形状、多选和变换。Konva 只负责画布内部对象；截图中的导航、素材网格、图层列表、Agent 面板、设置表单、按钮、弹窗和响应式布局应由普通 React/HTML/CSS 组件实现。

**所以目前的核心选型能达到原型图效果，不需要更换画布引擎。**补充的 UI 库只提供实现基础；最终视觉还原度取决于按截图调准布局、间距、颜色、字体、素材和交互状态。

为避免从零手写所有控件样式与可访问交互，MVP 前端方案补充：

| 能力 | 选型 | 用途 |
|---|---|---|
| 页面路由 | React Router 7 | 登录、注册、项目首页、素材、画布、账户和 Agent 设置 |
| 样式与设计令牌 | Tailwind CSS 4 + CSS variables | 页面布局、断点、暗色令牌、间距和状态样式 |
| 可访问 UI 基础组件 | shadcn/ui | Tabs、Dialog、Dropdown、Popover、Tooltip、表单控件等可定制组件源代码 |
| 线性图标 | Lucide React | 工具栏、设置项、状态操作图标 |
| 无限画布 | react-konva / Konva | 对象渲染、命中检测、选择、拖动、缩放与变换 |

shadcn/ui 组件需按项目令牌调整后使用，不能直接套用默认模板。Tailwind、shadcn/ui 和 Lucide 不会改变 Konva 画布模型；React Router 也只负责页面路径。先用 React 组件状态和 `canvas-core` 命令模型完成前端静态/交互原型；接入真实 API 前再决定是否增加服务端缓存库或全局状态库。

## 2. 原型视觉拆解

参考图的核心是克制的近黑界面、低对比点阵、柔白文字、细边框和少量浅绿强调。卡片和内容中的商品/风景图片提供主要色彩；界面本身不需要大面积渐变或装饰色。

### 视觉令牌初稿

| 令牌 | 色值 | 用途 |
|---|---|---|
| Canvas/background | `#080A09` | 全屏工作区与页面底色 |
| Surface | `#111412` | 顶栏、工具栏、主面板 |
| Border | `#2A2F2C` | 分隔线、输入框和卡片边界 |
| Text | `#F1F2EE` | 主文字和高优先级按钮 |
| Muted | `#9DA39E` | 辅助文字、未选中图标 |
| Accent | `#B9E98F` | Agent 当前状态、成功与少量焦点强调 |

字型先用系统字体，中文界面采用 `-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif`；标题可用 `"Songti SC", "SimSun", serif` 做有限的展示字体回退，不在原型阶段引入在线字体依赖。圆角和边框按信息层级使用，不让每个区域都变成同一种 SaaS 卡片。

## 3. 页面布局

### 项目首页

```text
┌ Logo / 我的画布 / 素材                         外观 / 账户 ┐
│                 一句话产品说明                              │
│          目标输入框 / 已选参考图片                            │
│                       新建画布                                │
│ 最近编辑                                                     │
│ [画布缩略图]       [画布缩略图]       [画布缩略图]            │
└──────────────────────────────────────────────────────────────┘
```

首页用 CSS Grid 展示项目缩略图，不用 Konva；空状态、最近编辑和创建入口共享这套布局。目标输入只发起多 Agent 规划，不显示尚未接入的生图/改图承诺。

### 无限画布编辑器

```text
┌ Logo / 项目 / 画布 / 工具栏 / 会话草稿 / 账户 ┐
│ 画布/素材/图层 │  CSS 点阵背景 + Konva 无限画布 │ 过程/已选图 │
│                │                                │ 任务树/审阅 │
│                │ 对象选择/变换/点阵无限空间        │ 输出/审阅   │
├───────────────────────────────────────────────────────────────┤
│ 底部紧凑目标输入栏：提示词 / 模型 / 参数摘要 / 提交           │
└───────────────────────────────────────────────────────────────┘
```

- Konva Stage 始终填充可视区域；工具栏固定在顶栏的“会话草稿”状态旁，不因绘制或 viewport 变换而位移，只显示选择箭头、手形、撤销和重做。对象使用画布世界坐标，缩放和平移由 viewport 控制，不做固定画板边框。
- 点阵使用与 viewport 同步的 CSS `radial-gradient` 背景，避免把大量点逐个绘制为可命中 Konva 节点。
- 顶栏、左右栏、浮动工具栏、Agent 任务树和对象检查器使用 DOM/CSS；需要键盘焦点的控件不绘制进 Canvas。
- 左侧提供画布入口、素材库入口和图层显隐/选择；右侧 Agent 面板只展示已提交目标、任务过程、输出审阅和已选图片，并可缩窄/恢复。
- 常驻工具栏提供选择、平移、导入图片、撤销/重做；移除文字、形状、连接线和画笔图标。选择工具支持框选多对象。顶栏不放分享、预览和缩放按钮，缩放操作只保留在画布左下角。
- 目标输入栏固定在画布区底部，保持紧凑；提示词、模型、参数摘要和提交按钮常驻。提交后右侧展示 Agent 过程；用户点击画布图片时图片追加为参考并聚焦输入栏，参考图片显示在底部和右侧。
- 点击图像参数摘要，在画布范围内打开可滚动的设置浮层，提供质量、W/H 尺寸、16 倍数对齐、分辨率、宽高比、透明背景和 1–10 张数量选项。提交只显示本地演示反馈，不调用真实图像生成服务。
- 顶栏“导入图片”可一次导入多张本地图片并放到画布；导入图片全部加入底部参考，最多保留 10 张。点击画布图片会追加到参考列表，不打开弹层。
- 右侧面板不放消息输入框或添加素材按钮；参考图片通过点击画布对象加入，也可以在右侧或底部输入栏移除。
- 左侧图层标题只显示图层名称和搜索，不显示加号。
- 素材卡片支持单张快捷加入画布；从编辑器进入素材库时保留当前画布 ID，加入后返回原画布。
- Agent 右侧面板按三步计划展示解析画布、生成方案和输出结果，并用已完成/运行中/待开始状态表达进度；结果生成后再显示提案审阅/应用。Agent 配置页面保留大字号主内容，将左侧导航轨宽度收至约 168–190px。模型字段维持易读尺寸。
- 桌面优先对齐参考图；窄屏将侧栏改为抽屉，保持画布操作区可用，不承诺手机端完整编辑体验。

### 素材库和账户

- 素材库用 CSS Grid 做多列缩略图、上传 dropzone、多选状态和底部批量操作栏。
- 登录/注册使用唯一用户名和密码，不出现邮箱字段、邮件验证或邮件找回。
- Agent 配置用表单组件和角色卡片；API Key 始终以遮罩状态呈现。

## 4. 开发顺序

1. **前端地基：**Vite + React + TypeScript、页面路由、Tailwind、令牌、shadcn 基础控件和 Lucide 图标；补桌面/窄屏应用壳，并配置 Caddy 将 SPA 深层路由回退到 `index.html`。
2. **静态页面：**登录/注册、项目首页、素材库、Agent 设置；用本地 fixture 展示真实文案和状态。
3. **画布框架：**实现顶栏、左侧图层/素材、中心点阵 Stage、右侧 Agent 面板和浮动工具栏。
4. **画布交互：**选中/拖动/缩放对象，图片/文字/形状命令，撤销重做；让 UI 状态与 `CanvasDocument` 分离。
5. **Agent 原型状态：**任务计划、等待确认、并行/排队、部分失败重试、结果差异预览、接受/放弃和撤销。
6. **视觉复核：**在 1440×1024 桌面基准下与原型并排比较；再复核约 1024px 和窄屏抽屉、键盘焦点、空/错误/载入状态。
7. **API 联调：**前端状态稳定后再连接 FastAPI、素材上传、SSE 和账户会话；API 尚未实现时不伪装成已保存或真实 Agent 执行。

## 5. 前端边界

- `apps/web` 负责路由和页面组合；`packages/ui` 负责跨页面基础控件；`packages/canvas-core` 负责画布文档类型与操作命令。
- 页面初期用内置 fixture；不把浏览器本地数据当成线上持久化成功。
- Konva 的序列化格式不作为服务端数据契约；API 读写自有 `CanvasDocument` schema。
- 不增加第二套 Canvas 引擎、全量组件主题框架或 CSS-in-JS。若要做画布内富文本编辑并需要 HTML overlay，再评估 react-konva-utils。
- 每次实现前用 Context7 按锁定版本核对框架/API，并记录版本和官方链接；本次查阅基线见 [ADR-0001](../03-decisions/ADR-0001-monorepo-and-stack.md)。

## 6. 原型验收检查点

- 画布是视觉主区域，点阵不会形成固定边界；拖动画布时对象与点阵空间感一致。
- 图层/Agent/素材区用 DOM 呈现，当前选中对象和任务步骤有清楚状态。
- Agent 结果应用前可审阅；按钮文案明确说明应用、取消、重试或撤销的结果。
- 目标截图的整体布局、暗色层次、细边框、低对比点阵和留白相符；未接入的生图功能需通过明确的本地演示提示表达。
- 桌面参考图与窄屏抽屉都可操作；所有按钮、弹窗和表单均有可见焦点与禁用/错误状态。

## 7. Context7 查阅记录

查阅日期：2026-10-29。实现前按 Context7/官方文档确认框架 API，依赖版本以 pnpm lockfile 为准。

| 库 | Context7 ID | 设计结论 | 官方文档 |
|---|---|---|---|
| Konva | `/konvajs/site` | Stage/Layer/Line/Transformer 支撑自由绘制、拖框选择和多对象变换；指针坐标需从视口平移/缩放还原到画布坐标。 | [Konva](https://konvajs.org/docs/index.html) |
| Konva Transformer 样式 | `/konvajs/site`（Konva 10.9.0） | `borderStrokeWidth`、`anchorSize`、`anchorStrokeWidth` 和 `anchorCornerRadius` 控制选中框与控制点；本轮使用 1px 选中线和 7px 控制点。 | [Transformer Styling](https://konvajs.org/docs/select_and_transform/Transformer_Styling.html) |
| Tailwind CSS | `/tailwindlabs/tailwindcss.com` | Vite 插件、CSS `@theme` 令牌可实现统一暗色主题和断点。 | [Tailwind CSS](https://tailwindcss.com/docs/installation/using-vite) |
| shadcn/ui | `/websites/ui_shadcn` | Vite + Tailwind 可组合；组件源码可定制为本项目视觉，图标库配置可用 Lucide。 | [shadcn/ui Vite](https://ui.shadcn.com/docs/installation/vite) |
| React Router | `/remix-run/react-router` | Vite SPA 采用 BrowserRouter/Routes 的 declarative 模式，不需要引入框架模式。 | [React Router Declarative](https://reactrouter.com/start/declarative/installation) |
| React Router `useSearchParams` | `/remix-run/react-router` | 素材库从画布入口接收 `canvas` 查询参数，并在添加素材后返回对应画布路由。 | [useSearchParams](https://reactrouter.com/api/hooks/useSearchParams) |
| React Router `useParams` | `/remix-run/react-router` | 从动态画布路由读取 canvas ID，并以 React `key` 在切换画布时重建编辑器实例。 | [useParams](https://reactrouter.com/api/hooks/useParams) |

实现首版后锁定并验证的直接依赖版本：React 19.3.1、React Router 7.18.5、react-konva 19.3.2、Konva 10.9.0、Tailwind CSS 4.3.3、Vite 8.3.5、TypeScript 7.0.2、Lucide React 1.63.0。锁文件为 `pnpm-lock.yaml`；运行 `pnpm --filter @canvas/web typecheck` 和 `pnpm --filter @canvas/web build` 均通过。该版本记录描述当前依赖解析结果，升级前仍需按 Context7/官方文档复核兼容性。

当前页面覆盖项目首页、素材库、无限画布、用户名登录/注册、账户设置和 Agent 设置。无限画布保留选择、单/多对象变换、显隐、画笔与对象配色、图片/文字/形状/连接线、缩放和撤销/重做；常驻工具栏显示选择、手形、图片导入、撤销/重做，并与“会话草稿”状态同处顶栏。点击画布图片会自动追加到右侧已选图片和底部参考；顶栏导入图片插入画布并同步到底部参考列表。底部输入会在右侧开始展示 Agent 过程，右侧不再有独立输入框或添加素材弹层。清空 Agent 对话同时移除本轮消息、计划、结果和已选参考；已应用到画布的操作保留。

2026-10-31 接入状态：登录/注册、账户、个人项目、UUID 画布、资产和 Agent 模型配置走 FastAPI；示例画布 ID 仍使用本地 fixture。UUID 画布保存通过 revision API；本地未同步草稿与有限撤销历史写入浏览器存储，刷新后按 base revision 恢复或进入冲突处理。临时网络/服务错误采用退避自动重试，重新联网立即恢复；冲突时明确选择本地覆盖或载入云端。已保存画布可从版本入口浏览 revision，并将所选快照恢复为新 revision。素材上传先存服务端，Agent 目标和图像参数进入持久任务；Worker 的 Image Creator 使用抽象 Provider。默认 Provider 未配置时明确显示失败，注入 Provider 后结果先作为临时图片，可保存或加入画布。Compose 下 Redis/Worker 已实机启动并验证队列入队、进程崩溃重派、PostgreSQL 检查点续跑和终态更新；窄屏抽屉及错误/空状态全量视觉复核仍待完成。

画笔和选取交互以 Context7 最新检索的 Konva 官方示例为依据：自由绘制使用 Line points，框选以画布坐标计算矩形相交，Transformer 绑定当前选中的节点；参见 [Free Drawing](https://konvajs.org/docs/sandbox/Free_Drawing.html) 与 [Basic Select and Transform](https://konvajs.org/docs/select_and_transform/Basic_demo.html)。
