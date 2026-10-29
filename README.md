# 在线 AI 无限画布平台 | Online Canvas Platform

**一个面向个人创作者的在线无限画布产品与全栈工程作品集项目。**它探索如何把黑色点阵画布、个人图片素材和有边界的多 Agent 协作整合到一个可自托管的 Web 平台中。

> 当前阶段：前端交互原型。已实现项目首页、无限画布工作区、素材库、用户名登录注册、账户设置和 Agent 配置页面；数据使用演示素材与前端状态，尚未连接 API、数据库或 MinIO，不能作为在线服务使用。

本项目由作者作为求职作品集和工程实践准备，采用 [MIT License](LICENSE) 开源。

## 项目解决什么问题

创作者需要在画布中整理图片、尝试视觉布局，并把一句创作目标转成具体编辑动作。本项目计划提供一个在线 AI 画布：用户在无限画布中组织素材，再让多个职责明确的 Agent 规划、提出画布修改并检查结果；用户预览并接受后，修改才会写入画布。

## 核心设计

- **黑色点阵无限画布：**在无固定页面边界的二维空间中平移、缩放和编辑图片、文字与基础形状。
- **个人素材库：**上传和整理图片，多选后可添加到画布或作为 Agent 的参考素材。
- **多 Agent 协作：**用户只提交一次目标；Coordinator 组织 Planner、Canvas Editor 和 Reviewer，展示任务进度、结果和失败状态。
- **可控的画布修改：**Agent 只能提出允许的画布操作；服务端校验用户权限和画布版本，用户审阅后应用，操作可撤销。
- **用户自带模型：**用户配置 OpenAI 兼容模型并分配给 Agent 角色，密钥由服务端加密保存。
- **单机自托管目标：**计划使用 Docker Compose 在一台服务器部署应用和 PostgreSQL、Redis、MinIO，并为数据配置异机备份。

### Agent 在产品中做什么

例如用户选中三张商品图并要求“排成一张简洁的海报”，Planner 负责给出布局方案，Canvas Editor 将方案转成移动、缩放或添加文字等受限操作，Reviewer 检查重叠和视觉层级。Coordinator 管理执行顺序，最后由用户预览并决定是否应用。

分角色是为了让计划、画布操作和结果检查各有边界，方便显示进度、限制权限和定位失败。Agent 不会直接执行任意代码或绕过服务端改数据库。多 Agent 指多个专业助手协作，不代表多人同时编辑。

## MVP 范围

### 计划纳入

- 唯一用户名和密码注册、登录、登出；不收集邮箱。
- 登录后修改密码和账户注销；MVP 暂无忘记密码自助恢复。
- 个人项目、云端画布保存、revision 冲突保护、撤销与重做。
- 图片上传、私有素材管理、多选添加画布或附加给 Agent。
- Agent 配置、目标拆解、有限并行、审批、结果预览、取消和失败重试。
- PostgreSQL、Redis/ARQ、MinIO 和单服务器 Docker Compose 部署。

### 当前原型可操作范围

- 项目首页可进入画布，画布支持对象选择、拖动、缩放、平移和工具栏切换。
- 素材库可搜索、筛选、多选，并把选择项加入画布或作为 Agent 参考素材；上传仅在浏览器中预览，不会传到服务器。
- Agent 面板可展示 Coordinator/子 Agent 任务树、参考素材、画布修改预览，以及提案接受/拒绝；当前是交互演示，不会调用模型或写入服务端数据。
- 登录、注册与 Agent 设置用于 UI 流程预览；账户和模型配置不会真实保存。

## 本地启动

需要 Node.js 20.19+（或 22.12+）与 pnpm 10。

```bash
pnpm install
pnpm dev
```

前端默认在 `http://localhost:5173`。构建和类型检查：

```bash
pnpm --filter @canvas/web typecheck
pnpm --filter @canvas/web build
```

### 暂不纳入

- 多人同时编辑同一画布、项目邀请和实时协作。
- 管理员后台、团队空间、计费和公开市场。
- 提示词库、音乐/视频功能及完整移动端编辑。
- 外部生图和改图 API 调用。用户后续提供接口文档后再规划接入。

## 技术方案（规划中）

| 层 | 规划技术 | 主要职责 |
|---|---|---|
| Web 前端 | React、TypeScript、Vite、React Router 7 | 页面路由和应用壳 |
| UI 组件 | Tailwind CSS 4、shadcn/ui、Lucide React | 暗色设计令牌、可访问控件和线性图标 |
| 画布 | react-konva / Konva | 无限画布中的图像、文字、形状和变换 |
| API | Python、FastAPI | 用户会话、项目、画布、素材和 Agent API |
| Agent 编排 | LangGraph | Coordinator 任务图、专业 Agent、审批与恢复 |
| 后台任务 | Redis、ARQ | 长任务排队、重试和取消信号 |
| 业务数据 | PostgreSQL、JSONB | 账户、项目、画布版本和 Agent 运行记录 |
| 图片存储 | MinIO | 私有图片对象和未来图像服务结果 |
| 部署 | Docker Compose、Caddy | 单服务器应用编排与 HTTPS 入口 |

以上后端部分是设计基线，尚未实现；开发时依赖版本与具体 API 会通过 Context7 和官方文档核对。

## Monorepo 结构

```text
apps/
  web/       React + TypeScript + Konva 前端
  api/       FastAPI 后端
  worker/    ARQ + LangGraph Agent 与长任务
packages/    共享画布模型、API 客户端和 UI
infra/       Docker Compose、Caddy、PostgreSQL、Redis、MinIO
docs/        PRD、产品设计、架构、原型和路线图
openspec/    产品行为规格和实施任务
```

## 项目进度

- [x] 产品需求、MVP 边界和技术选型文档
- [x] 系统架构图、数据模型和 OpenSpec 实施计划
- [x] 黑色点阵无限画布及主要页面的视觉参考图
- [x] 前端 UI 技术与分阶段实现计划
- [x] 完成前端页面与无限画布交互原型首版
- [ ] 补齐 Agent 失败/重试、保存失败/冲突与恢复等边界状态原型
- [x] 按参考图进行桌面/窄屏视觉走查并修正窄屏画布初始视口
- [ ] 实现账户、画布、素材、Agent 和单机部署

## 文档导航

| 文档 | 说明 |
|---|---|
| [产品说明](docs/PRODUCT.md) | 目标用户、产品边界和核心流程 |
| [MVP PRD](docs/01-product/PRD.md) | 用户故事、范围和验收标准 |
| [产品与交互设计](docs/02-design/product-design.md) | 页面结构、交互状态和多 Agent 体验 |
| [前端 UI 开发计划](docs/02-design/frontend-ui-plan.md) | 视觉令牌、页面布局、前端选型和实现顺序 |
| [原型文档](docs/02-design/prototypes/README.md) | 原型参考图、页面说明和待补状态 |
| [系统架构](docs/02-design/system-architecture.md) | 系统组件、数据流和架构图 |
| [技术选型 ADR](docs/03-decisions/ADR-0001-monorepo-and-stack.md) | Monorepo、技术栈及取舍 |
| [OpenSpec 变更](openspec/changes/platform-foundation/README.md) | 可追踪的能力规格和实施任务 |
| [会话交接](docs/session-handoff.md) | 当前阶段、验证和下一步 |

## 常见问题

**这是可以直接使用的在线画布吗？** 还不是。仓库包含可运行的前端交互原型；账户、画布、素材和 Agent 都是前端演示状态，没有 API、云端保存或在线 Demo。

**MVP 会调用 AI 生图或改图接口吗？** 暂时不会。接口由用户后续提供后，才会按真实 API 文档单独规划实现。

**多 Agent 是什么意思？** 系统根据一个创作目标自动组织规划、画布编辑和检查等角色，结果先由用户审阅。它不等于多个用户实时协作。

**MVP 支持多人同时编辑吗？** 不支持。首版按一个用户编辑个人画布设计。

**项目采用什么开源许可证？** 本仓库采用 MIT License，完整条款见 [LICENSE](LICENSE)。

## English Summary

Online Canvas Platform is a portfolio project for an AI-assisted infinite canvas web application. Its first runnable frontend prototype includes a dark dotted canvas workspace, project home, image asset library, username-based auth screens, account settings, and user-configurable agent settings. The current UI uses local fixtures and does not connect to an API, database, MinIO, or model provider. The planned backend stack is FastAPI, LangGraph, PostgreSQL, Redis/ARQ, and MinIO. Prepared for job applications and released under the MIT License.

## License

This project is licensed under the [MIT License](LICENSE).
