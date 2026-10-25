# DSH plugins

Plugins for **DeepSeek Harness** (`dsh`) — the desktop/Web harness these plugins are written
against. Each one is a self-contained package: a Node **host half** (routes, services, persistence)
and, where useful, a **browser half** (a Web GUI contribution loaded through the shell's boot graph).

Nothing here is model-facing unless a plugin says so: these add user-facing surfaces, not agent
tools. Every plugin ships with dependency-free tests that run on plain Node.

## Plugins

| Plugin | Package | What it does | Halves |
| --- | --- | --- | --- |
| [`workspace-todo`](plugins/workspace-todo) | `@accsci/dsh-workspace-todo` | A todo list bound to the Session's working directory, opened from a button in the Session header. Data lives in `<working directory>/.dsh/todos.json`, so every Session on the same directory shares one list. | host + web client |
| [`sysmon`](plugins/sysmon) | `@accsci/dsh-sysmon` | Live CPU / memory / GPU meters under the composer. CPU and memory come from `node:os`; GPU needs the Windows performance counters through a small PowerShell sampler and renders as unavailable everywhere else. | host + web client |

## Install

```bash
git clone https://github.com/ACCSCI/dsh-plugins
```

Then install one plugin directory into a DSH profile. Either path works:

- **Plugin manager (live profile):** `install_bundle <absolute path to plugins/<name>>`, then refresh
  the GUI page for the browser half.
- **Official assembly (after a restart):** `dsh plugin --profile <profile> add <absolute path to
  plugins/<name>>`.

On **DSH Desktop** the `desktop` profile belongs to the application — install from **Settings →
Plugins** (or by path through its plugin manager); the CLI refuses to touch that profile while the
app manages it.

A plugin directory is the package that declares `dsh.bundle.patch` (its `cordis.patch.yml` inserts
the loader row) and, for browser halves, `dsh.client` plus a `./client` export.

Nothing here is on npm. The `@accsci/*` names are package identities, not registry coordinates —
install by path, or point your own profile at a checkout.

### Changing a plugin

- **Browser half** (`lib/client.js`): refresh the GUI page. The shell rebuilds its module graph from
  the file on disk.
- **Host half** (`lib/index.js`): restart DSH. The loader imports plugin modules with a plain
  `import()`, so a running process keeps the module it already loaded — disabling/enabling the entry
  or reinstalling the bundle does not re-import it.

## Repository layout

```
plugins/<name>/     # package.json, cordis.patch.yml, lib/, test/, README.md
tools/check.mjs     # the repository self-check
```

This repository is source only: the DSH profile that installs these packages is personal and is not
published here.

## Tests

Every suite runs on plain Node with **no dependencies** and no DSH installation:

```bash
node tools/check.mjs             # manifests, README, CI wiring, then every suite
node tools/check.mjs --no-tests  # manifests only
node plugins/sysmon/test/host.mjs
```

`check` enforces the invariants that otherwise break silently: the package name versus the `name:`
its `cordis.patch.yml` inserts, `files[]` entries that exist, a `./client` export behind every
`dsh.client` half, and a README row and CI hook for every plugin. CI runs it on every push.

The workspace-todo suite also ships a live check that needs a running GUI:

```bash
node plugins/workspace-todo/test/live-check.mjs <project dir>
```

## Optional: npm

The manifests are npm-ready (`publishConfig.access: public`, `files` whitelists, no `private`), so
publishing later is a two-liner:

```bash
cd plugins/sysmon && npm publish --registry=https://registry.npmjs.org
```

Not doing it is fine: path installs and `link:` dependencies in a profile never touch the registry.

## License

MIT — see [LICENSE](LICENSE).

---

## 中文说明

面向 **DeepSeek Harness（`dsh`）** 的插件集合。每个插件都是一个独立包：Node 侧 **host 半**
（路由、服务、持久化）+ 可选的浏览器侧 **client 半**（通过启动图注入 Web GUI 的界面贡献）。
这些插件默认不注册模型工具——它们是给用户用的界面能力，不是给 Agent 用的工具。

插件以目录形式安装（`@accsci/*` 是包名，不是已发布的 npm 坐标）：

```bash
git clone https://github.com/ACCSCI/dsh-plugins
dsh plugin --profile <profile> add <插件目录绝对路径>
```

桌面端请在 **设置 → 插件** 里装：`desktop` profile 归 Electron 应用管理，命令行改不了它。

| 插件 | 作用 |
| --- | --- |
| [`workspace-todo`](plugins/workspace-todo) | 绑定到「当前会话工作目录」的待办清单：会话顶栏一个按钮打开浮层面板；数据存在 `<工作目录>/.dsh/todos.json`，同一目录下的所有会话共享一份清单 |
| [`sysmon`](plugins/sysmon) | 输入框下方的 CPU / 内存 / GPU 实时读数：CPU 与内存取自 `node:os`，全平台可用；GPU 走 Windows 性能计数器（PowerShell 采样器），其他平台显示为不可用 |

**改动生效规则**：改 `lib/client.js` 刷新页面即可；改 `lib/index.js` 必须重启 DSH（加载器用普通
`import()` 取模块，进程内的 ESM 缓存不会因为停用/启用 entry 或重装 bundle 而失效）。

**自测**：`node tools/check.mjs` 校验清单一致性并跑完所有离线用例；CI 每次 push 都跑它。

**发布（可选）**：`cd plugins/sysmon && npm publish --registry=https://registry.npmjs.org`。不发布也
不影响任何用法——按路径装、profile 里用 `link:`，都不经过 registry。
