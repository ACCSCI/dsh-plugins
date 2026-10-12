# DSH plugins

A collection of plugins for **DeepSeek Harness** (`dsh`) — the desktop/Web harness this repository's
plugins are written against. Each plugin is a self-contained package: a Node **host half** (routes,
services, persistence) and, where useful, a **browser half** (a Web GUI contribution loaded through
the shell's boot graph).

Nothing here is model-facing unless a plugin says so: plugins are ordinary DSH packages installed
into a profile, and the ones in this repository add user-facing surfaces, not agent tools.

## Plugins

| Plugin | What it does | Halves |
| --- | --- | --- |
| [`workspace-todo`](plugins/workspace-todo) | A todo list bound to the Session's working directory, opened from a button in the Session header. Data lives in `<working directory>/.dsh/todos.json`, so every Session on the same directory shares one list. | host + web client |

## Install

```bash
git clone https://github.com/ACCSCI/dsh-plugins
```

Then install one plugin into a DSH profile. Either path works:

- **Plugin manager (applies to a live profile).** From the Plugins page, or through the management
  tool: `install_bundle <absolute path to the plugin directory>`. A new browser half appears after
  the GUI page is refreshed.
- **Official assembly (takes effect after a restart).** `dsh plugin --profile <profile> add <absolute
  path to the plugin directory>`.

A plugin directory is the package that declares `dsh.bundle.patch` (its `cordis.patch.yml` inserts
the loader row) and, for browser halves, `dsh.client` plus a `./client` export.

### Changing a plugin

- **Browser half** (`lib/client.js`): refresh the GUI page. The shell rebuilds its module graph from
  the file on disk.
- **Host half** (`lib/index.js`): restart DSH. The loader imports plugin modules with a plain
  `import()`, so a running process keeps the module it already loaded — disabling/enabling the entry
  or reinstalling the bundle does not re-import it.

## Repository layout

```
plugins/<name>/
  package.json        # name, exports, dsh.bundle.patch, dsh.client
  cordis.patch.yml    # the loader row this bundle inserts
  lib/index.js        # host half
  lib/client.js       # browser half (when the plugin has one)
  test/*.mjs          # dependency-free test scripts
  README.md           # what it does, how it is installed, what was verified
```

## Tests

Every test script runs on plain Node with **no dependencies** and no DSH installation:

```bash
node plugins/workspace-todo/test/host-routes.mjs    # drives the real route handlers over a shimmed ctx.fs contract
node plugins/workspace-todo/test/client-smoke.mjs   # renders the real component tree with a minimal React substitute
node plugins/workspace-todo/test/live-check.mjs <project dir>   # against a running GUI (needs the profile's local credential)
```

CI runs the offline suites on every push.

## License

MIT — see [LICENSE](LICENSE).

---

## 中文说明

这是一个面向 **DeepSeek Harness（`dsh`）** 的插件集合。每个插件都是一个独立包：Node 侧
**host 半**（路由、服务、持久化）+ 可选的浏览器侧 **client 半**（通过启动图注入 Web GUI 的界面贡献）。
这里的插件默认都不注册模型工具——它们是给用户用的界面能力，不是给 Agent 用的工具。

| 插件 | 作用 |
| --- | --- |
| [`workspace-todo`](plugins/workspace-todo) | 绑定到「当前会话工作目录」的待办清单：会话顶栏一个按钮打开浮层面板；数据存在 `<工作目录>/.dsh/todos.json`，同一目录下的所有会话共享一份清单 |

**安装**：`git clone` 本仓库后，把某个插件目录装进 DSH profile —— 插件管理端
`install_bundle <插件目录绝对路径>`（活配置立即生效，新客户端入口刷新页面）或
`dsh plugin --profile <profile> add <插件目录绝对路径>`（重启后生效）。

**改动生效规则**：改 `lib/client.js` 刷新页面即可；改 `lib/index.js` 必须重启 DSH（加载器用普通
`import()` 取模块，进程内的 ESM 缓存不会因为停用/启用 entry 或重装 bundle 而失效）。

**自测**：每个插件的 `test/*.mjs` 都是零依赖的普通 Node 脚本，可直接运行；CI 会在每次 push 时跑离线用例。
