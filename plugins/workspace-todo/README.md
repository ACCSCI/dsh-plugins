# workspace-todo

按工作目录维护的个人待办清单（DSH 插件包，`@accsci/dsh-workspace-todo`）。

## 是什么

- **入口**：会话顶栏右侧的工具区（“在应用中打开 / 下载会话日志”旁边）多一个清单按钮，
  未完成数为 0 时不显示徽标；点击弹出浮层面板，Esc 或点击面板外关闭。
- **数据**：`<当前会话的工作目录>/.dsh/todos.json`。同一目录下的所有会话共享一份清单，
  换项目自动换清单；文件是纯 JSON，可手工编辑、可提交到版本库。
- **不是给 AI 用的**：本插件不注册任何模型工具，Agent 既看不到也改不了这份清单。
- **服务端**：Host 半只提供两条 JSON 路由，用 `ctx.fs` 读写（自动建 `.dsh` 目录、原子写入、
  版本令牌防覆盖）：
  - `GET  /workspace-todo/api/state?dir=<绝对目录>`
  - `POST /workspace-todo/api/save` `{ dir, todos, version }`

## 沙箱、鉴权与错误码

- **写入边界**：GUI 发起的请求没有会话上下文，若不给策略，`ctx.sandboxPolicy.resolve()` 会回退到
  「工作区写」的**无会话兜底根目录**（通常是用户主目录），于是写到该根目录之外的盘符或路径
  会被 `FS_SANDBOX_DENIED` 拒绝。本插件因此在每次写入时显式声明
  `{ mode: 'workspace-write', workspaceRoot: <当前工作目录> }`：既放行正在看的项目，又把写入
  严格围栏在该工作目录之内（实际只写 `<dir>/.dsh/todos.json`）。
- **跨站请求**：插件路由挂在 Web carrier 上，不经过 Connection 的 cookie 鉴权栅栏，因此两条路由
  自行拒绝跨站请求（`sec-fetch-site: cross-site` 或 `Origin` 与 Host 不一致 → 403）。本机进程
  仍可访问——它本来就能直接读写同一个纯文本文件，Host 白名单只会带来虚假的安全感。
- **错误码**：`400` 非法 JSON / 非法目录，`403` 跨站，`405` 非 POST，`409` 版本冲突或目标不是
  普通文件（`FS_NOT_REGULAR_FILE`），`413` 请求体过大，`415` 非文本目标，其余为 `500`。

## 功能

| 能力 | 说明 |
| --- | --- |
| 新增 | 面板顶部输入框，回车或“添加” |
| 状态 | 待办 / 进行中 / 已完成 / 阻塞 / 等待（下拉选择） |
| 优先级 | 高 / 中 / 低 |
| 截止日期 | 主题化月历浮层：六周网格、翻月、今天/明天/清除、方向键移动；逾期标红 |
| 备注 + 子任务 | 每行“备注”展开：备注文本域 + 子任务勾选/新增/删除，父行显示 `已完成/总数` |
| 拖拽排序 | 按住行首 `⠿` 拖动，落点按上/下半行决定插入位置 |
| 点击复制 | 点标题复制标题纯文本，点顶部路径复制工作目录；面板内提示“已复制” |
| 删除 | 每行“删除”按钮 |
| 清空已完成 | 仅当存在已完成项时出现在底栏；走应用自带的 `Modal` **二次确认**（写明将移除几项、不可撤销），取消/关闭/Esc 都不动数据 |
| 徽标 | 顶栏按钮显示未完成数量 |
| 筛选 | 全部 / 未完成 / 已完成（记忆在 localStorage） |
| 保存 | 改动后 350ms 自动落盘；关闭面板、切后台、关页面时立即冲刷 |
| 外部改动 | 其它窗口或编辑器先改了文件时，保存被拒并提示“重新载入”，不静默覆盖 |

## 外观与交互

界面不是自己仿一套皮，而是直接使用 shell 自己的 UI 套件：

- **`@deepseek-ai/dsh-client-ui-primitives`**：状态/优先级都用它的 `Menu` 渲染（与官方插件同一套圆角、投影、
  开合动画与键盘行为），不再是原生 `<select>`。该模块在 shell 的冻结平台模块表里
  （`window.__DSH_BOOT__` 的种子表），所以客户端半直接 `require` 即可，不需要声明 `dsh.client.inject`。
- **图标用应用自带的图标集**（`IconQueueOutline*` / `IconLoadingOutline*` / `IconCheckOutline*` /
  `IconWarningOutline*` / `IconClockOutline*` / `IconTrashOutline*` …），而不是外挂 Lucide：
  这样线条粗细、尺寸档位与整个 GUI 一致；Lucide 也不在平台模块表里，只能内联路径数据，风格反而会割裂。
  **图标按基名解析，不按精确导出名**：不同构建的后缀不同（桌面端 app.asar 里是 `…OutlineRegular` /
  `…OutlineMedium`，npm 上的 `0.1.5-rc.1` 是 `…Outline16` / `…Outline14`）。写死某个后缀会在另一种构建里
  得到 `undefined`，而 `createElement(undefined)` 是 React #130 硬崩——整个面板会在渲染瞬间挂掉（错误日志
  会显示 `slot entry crashed in 'shell.overlay'`）。因此本插件按基名在多个后缀里找，找不到就渲染空，
  并且在没有 `Menu` 导出的构建里退回到内置列表。
- **颜色全部走主题令牌**（`--dsw-alias-*`）：状态色取自 `brand-primary` / `state-success-primary` /
  `state-error-primary` / `state-warn-primary` / `label-secondary`，浅色与深色主题都自动正确，
  不写死黑色或白色。
- **日期选择器**：套件里没有日历组件（官方「定时」插件也是用 `Menu` + 输入框拼的），所以本插件自带一个
  主题化月历浮层——六周网格、翻月、`今天 / 明天 / 清除`、方向键移动与 Esc 关闭，取值仍是 `YYYY-MM-DD`。
  它和菜单一样按框架层（portal）渲染，否则会被面板的 `overflow:hidden` 裁掉。
- **原生控件跟随面板主题**：面板挂载时按自身背景亮度推导并设置 `color-scheme`，
  日期选择器这类无法自绘的原生控件因此不会在深色主题下弹出刺眼的白底黑字。
- **动效**：面板淡入/缩放进入与退出（退出先播完动画再卸载，不会闪断）、备注区展开动画、
  状态“进行中”的图标持续旋转、按钮/行/胶囊的 hover 与按下过渡；`prefers-reduced-motion` 下全部关闭。

### 热更新（HMR）下的状态共享

客户端插件改动会触发热替换，而热替换会**再实例化一份模块**：旧实例已挂载的面板可能还在，而按钮已经是新实例的。
如果每个实例各持一份模块作用域状态，点按钮就是在改新实例的 store，而屏幕上那份面板读的是旧实例的 store——
表现就是「点不开面板」。因此本插件的 store（面板开关、清单、保存队列、加载令牌）挂在
`globalThis.__dshWorkspaceTodoShared__` 上：同一页面里所有存活实例共用一份，热替换后按钮与面板始终同步；
整页刷新只创建一次。

## 装配

```powershell
# 免手工（管理端工具，活配置立刻生效；新客户端入口需刷新页面）
plugin_manager install_bundle <本目录的绝对路径>

# 或官方装配（重启 DSH 后生效）
dsh plugin --profile <profile> add <本目录的绝对路径>
```

安装后**刷新一次 GUI 页面**（新插件的客户端入口要重新注入 `window.__DSH_BOOT__`）。

> **改动 host 半（`lib/index.js`）后必须重启 DSH**：加载器用普通 `import()` 取模块，
> 进程内的 ESM 缓存不会因为 entry 停用/启用或重装 bundle 而失效（客户端半只需刷新页面）。
> 本插件的沙箱边界修复属于 host 半，因此首次装配后需要重启一次。

## 数据格式

```json
{
  "version": 1,
  "updatedAt": "2026-01-01T00:00:00.000Z",
  "todos": [
    {
      "id": "todo-...",
      "title": "标题",
      "status": "todo | doing | done | blocked | waiting",
      "priority": "high | medium | low | null",
      "due": "YYYY-MM-DD | null",
      "notes": "",
      "subtasks": [{ "id": "subtask-...", "title": "子任务", "done": false }],
      "createdAt": 0,
      "updatedAt": 0,
      "doneAt": 0
    }
  ]
}
```

写入前会逐条校验（状态/优先级枚举、日期格式、标题与备注长度上限、最多 500 条、最多 100 条子任务），
上限彼此自洽：500 条 × 1 万字符备注仍在 16 MiB 请求体之内，面板能编出来的清单就是路由收得下的清单。
手工编辑出的小毛病不会让面板崩掉。

保存策略：改动后 350 ms 自动落盘；关闭面板、切到后台、关闭页面立即冲刷（超 64 KiB 的载荷自动放弃
`keepalive`，改用普通请求）；改动/排队中的编辑用序号精确跟踪。

并发保护三分支（客户端随每次保存上报它读到的 `version` 与 `exists`）：

| 客户端状态 | 服务端守卫 | 别的窗口抢先时的结果 |
| --- | --- | --- |
| 读到文件不存在（`exists:false`） | `createIfAbsent` | 409 `conflict`，**不覆盖**对方刚创建的清单 |
| 读到文件 + 版本令牌 | `replaceIfVersion` | 409 `conflict`，文件保持对方版本 |
| 两者都没有（纯 API 调用/测试） | 无条件写入 | 覆盖（显式契约） |

出现冲突时面板显示「未写入」并提供「重新载入」，不会静默丢行。

**清空备份网**：当一次保存会把**非空**清单变成**空**清单时（唯一一种“一次误操作就毁掉全部内容”的编辑），
被替换的原文会先留一份到 `<工作目录>/.dsh/todos.json.bak`，面板提示一次。原文来自同一次写入返回的
`before`，所以只在那一次转变上多写一个小文件；备份失败不影响保存本身。恢复方式：把 `.bak` 复制回
`todos.json` 即可。

## 卸载

```powershell
plugin_manager remove_bundle @accsci/dsh-workspace-todo
```

卸载只影响插件本身，`<项目>/.dsh/todos.json` 保留。

## 文件

- `lib/index.js` — Host 半：两条路由、沙箱写入边界、路径与数据校验、并发守卫与清空备份。
- `lib/client.js` — 客户端半：顶栏按钮、浮层面板、共享 store、剪贴板、拖拽排序。
- `cordis.patch.yml` — bundle 层插入行（`id: workspace-todo`）。
- `test/host-routes.mjs` — 用镜像 `ctx.fs` 契约的桩驱动真实路由处理器（35 项）。
- `test/client-smoke.mjs` — 迷你 React 渲染真实组件树，覆盖交互、UI 套件菜单与保存队列（66 项）。
- `test/live-check.mjs` — 对运行中的 GUI 做活体检查（栅栏、错误码、真实写入往返）。

## 验证记录（2026-10-12）

| 层面 | 证据 |
| --- | --- |
| Host 半（离线） | `test/host-routes.mjs` **35/35**：路径与输入校验、错误码映射、跨站栅栏、版本冲突、受保护创建、清空备份、沙箱写入边界 |
| 客户端半（离线） | `test/client-smoke.mjs` **66/66**：渲染、应用 UI 套件的状态/优先级菜单与图标、日期/备注/子任务、拖拽重排、复制、筛选、保存队列与并发编辑、工作区切换、备份提示、面板进出场状态 |
| 活体路由 | `test/live-check.mjs` **9/9**（GUI 运行于 `http://127.0.0.1:19387`）：跨站/外来 Origin 403、非法 JSON 400、项目路径映射、真实写入往返、`.dsh` 目录自动创建、过期版本 409 |
| 客户端入场 | 启动图含 `@accsci/dsh-workspace-todo`，服务器返回的 combo bundle 即最新客户端半 |
| 端到端 | GUI 中一次真实新增后，`<项目目录>/.dsh/todos.json` 出现在项目目录（该路径只可能由面板经这两条路由创建） |
| **未验证** | 真实浏览器里的渲染观感与拖拽/复制手感；跨窗口并发写的实测 |

> 交付时的遗留：首次端到端验证中，一次不带版本令牌的探测写入恰好覆盖了用户刚创建的那条待办
> （文件当时已存在，但请求以“文件不存在”的身份写入）。该竞态已按上文三分支守卫修复，并新增清空备份网；
> 被覆盖的那一条内容没有备份，无法从磁盘恢复。

## 自测

```powershell
node test\host-routes.mjs     # 35/35，无外部依赖
node test\client-smoke.mjs    # 66/66，无外部依赖
node test\live-check.mjs <项目目录>   # 需 GUI 正在运行
```
