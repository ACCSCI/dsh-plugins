# DSH plugins

A collection of plugins for **DeepSeek Harness** (`dsh`) — the desktop/Web harness this repository's
plugins are written against. Each plugin is a self-contained package: a Node **host half** (routes,
services, persistence) and, where useful, a **browser half** (a Web GUI contribution loaded through
the shell's boot graph).

Nothing here is model-facing unless a plugin says so: plugins are ordinary DSH packages installed
into a profile, and the ones in this repository add user-facing surfaces, not agent tools.

The repository doubles as my cross-machine plugin source: [`profile/`](profile) holds a snapshot of
the live DSH profile and [`tools/dsh-plugins.mjs`](tools/dsh-plugins.mjs) puts it back on another
machine. See [Cross-machine sync](#cross-machine-sync).

## Plugins

| Plugin | What it does | Halves |
| --- | --- | --- |
| [`workspace-todo`](plugins/workspace-todo) | A todo list bound to the Session's working directory, opened from a button in the Session header. Data lives in `<working directory>/.dsh/todos.json`, so every Session on the same directory shares one list. | host + web client |
| [`sysmon`](plugins/sysmon) | Live CPU / memory / GPU meters under the composer. CPU and memory come from `node:os`; GPU needs the Windows performance counters through a small PowerShell sampler and renders as unavailable everywhere else. | host + web client |

## Install

```bash
git clone https://github.com/ACCSCI/dsh-plugins
```

Then install one plugin into a DSH profile. Either path works:

- **Plugin manager (applies to a live profile).** From the Plugins page, or through the management
  tool: `install_bundle <absolute path to plugins/<name>>`. A new browser half appears after the GUI
  page is refreshed.
- **Official assembly (takes effect after a restart).** `dsh plugin --profile <profile> add <absolute
  path to plugins/<name>>`.

A plugin directory is the package that declares `dsh.bundle.patch` (its `cordis.patch.yml` inserts
the loader row) and, for browser halves, `dsh.client` plus a `./client` export.

### Changing a plugin

- **Browser half** (`lib/client.js`): refresh the GUI page. The shell rebuilds its module graph from
  the file on disk.
- **Host half** (`lib/index.js`): restart DSH. The loader imports plugin modules with a plain
  `import()`, so a running process keeps the module it already loaded — disabling/enabling the entry
  or reinstalling the bundle does not re-import it.

## Cross-machine sync

`profile/<name>/` is the snapshot of a profile: `package.json` (the bundle stack and exact
dependency specs), `cordis.patch.yml` (row overrides), `pnpm-workspace.yaml` and
`pnpm-lock.yaml`. Those four files are the whole machine-independent intent. `node_modules`,
sessions, attachments and credentials never enter the repository.

Local plugins are linked with a **relative** specifier — `link:../../plugins/<name>` — which resolves
to `~/.dsh/plugins/<name>` from the profile directory and to `plugins/<name>` from the snapshot.
One file, valid on every machine and every checkout location.

```bash
node tools/dsh-plugins.mjs sync                    # dry run: what would change
node tools/dsh-plugins.mjs sync --apply            # relink ~/.dsh/plugins, write the four files
node tools/dsh-plugins.mjs sync --apply --install  # ... then run the app's own pnpm
node tools/dsh-plugins.mjs sync --capture          # copy the live profile back into the repo
```

Rules the tool encodes, all learned the hard way:

- **Quit the app first.** The desktop profile belongs to the Electron application — `dsh plugin
  --profile desktop …` is rejected outright, even for `list`. `sync --apply` refuses to run while
  the app is up unless you pass `--force`.
- **Use the app's pnpm.** The app ships node 24 + pnpm 11 and verifies the lockfile against
  supply-chain policies; a system pnpm 9/10 silently skips that. `--install` locates the bundled
  runtime under `~/.dsh/dsh-runtimes/*/dependencies`.
- **The Plugins page rewrites local specs to absolute paths.** Installing a bundle from the GUI turns
  `link:../../plugins/<name>` back into `link:C:/Users/…`; run `sync --apply` afterwards.
- **Restart after `--apply`.** Host halves are imported once per process.

## Repository layout

```
plugins/<name>/     # package.json, cordis.patch.yml, lib/, test/, README.md
profile/<name>/     # the DSH profile snapshot (four files)
tools/              # dsh-plugins.mjs — check + sync
```

## Tests

Every test script runs on plain Node with **no dependencies** and no DSH installation:

```bash
node tools/dsh-plugins.mjs check          # manifests, README, CI, snapshot, then every suite
node tools/dsh-plugins.mjs check --no-tests
node plugins/sysmon/test/host.mjs         # one suite on its own
```

`check` enforces the invariants that used to break silently: package name versus the `name:` in
`cordis.patch.yml`, `files[]` entries that exist, a README row and a CI hook for every plugin, and
the profile snapshot's links. CI runs it on every push.

The workspace-todo suite also ships a live check that needs a running GUI:

```bash
node plugins/workspace-todo/test/live-check.mjs <project dir>
```

## License

MIT — see [LICENSE](LICENSE).

---

## 中文说明

这是一个面向 **DeepSeek Harness（`dsh`）** 的插件集合。每个插件都是一个独立包：Node 侧
**host 半**（路由、服务、持久化）+ 可选的浏览器侧 **client 半**（通过启动图注入 Web GUI 的界面贡献）。
这里的插件默认都不注册模型工具——它们是给用户用的界面能力，不是给 Agent 用的工具。

这个仓库同时是我跨电脑的插件源：[`profile/`](profile) 存 profile 快照，
[`tools/dsh-plugins.mjs`](tools/dsh-plugins.mjs) 负责把它在新机器上还原。

| 插件 | 作用 |
| --- | --- |
| [`workspace-todo`](plugins/workspace-todo) | 绑定到「当前会话工作目录」的待办清单：会话顶栏一个按钮打开浮层面板；数据存在 `<工作目录>/.dsh/todos.json`，同一目录下的所有会话共享一份清单 |
| [`sysmon`](plugins/sysmon) | 输入框下方的 CPU / 内存 / GPU 实时读数：CPU 与内存取自 `node:os`，全平台可用；GPU 走 Windows 性能计数器（PowerShell 采样器），其他平台显示为不可用 |

**跨机同步**：

```bash
node tools/dsh-plugins.mjs sync                    # 只比对，不写盘
node tools/dsh-plugins.mjs sync --apply            # 建 link + 写 profile 四个文件
node tools/dsh-plugins.mjs sync --apply --install  # 再用应用自带的 pnpm 装一遍
node tools/dsh-plugins.mjs sync --capture          # 把当前 profile 收回仓库
```

三条硬约束：**先退出应用**（desktop profile 归 Electron 独占）；**别用系统 pnpm**（应用自带
node 24 + pnpm 11，且会校验 lockfile 的供应链策略）；**在插件页重装本地插件会把相对路径写回绝对
路径**，之后要再跑一次 `sync --apply`。

**安装**：`git clone` 本仓库后，把某个插件目录装进 DSH profile —— 插件管理端
`install_bundle <插件目录绝对路径>`（活配置立即生效，新客户端入口刷新页面）或
`dsh plugin --profile <profile> add <插件目录绝对路径>`（重启后生效）。

**改动生效规则**：改 `lib/client.js` 刷新页面即可；改 `lib/index.js` 必须重启 DSH（加载器用普通
`import()` 取模块，进程内的 ESM 缓存不会因为停用/启用 entry 或重装 bundle 而失效）。

**自测**：`node tools/dsh-plugins.mjs check` 会校验清单一致性并跑完所有插件的离线用例；CI 每次
push 都跑它。
