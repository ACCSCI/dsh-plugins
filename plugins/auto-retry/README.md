# @accsci/dsh-auto-retry

**供应商临时故障时把模型请求重试到成功；额度、鉴权这类永久问题立刻停。**

DSH 内置的 `dsh-llm-retry` 对超时、限流、5xx 等失败最多重试 5 次，然后整轮失败——截图里
`已重试模型请求 (5/5)` 之后显示 `本轮运行失败` 就是这条路径。这个插件在它前面接管：

- 临时失败 → **不限次数**重试，直到成功、你点停止，或插件被卸载；
- 永久失败 → 立即按原样失败，不再重发同一条注定失败的请求（哪怕提供方策略要求重试）；
- 两处开关：**设置 → 自动重试** 一整页参数，**会话头**一个开关药丸，随时一键切换；
- 重试过程沿用 DSH 自带的重试行，聊天里显示 `正在重试模型请求 (12/∞)` 与倒计时。

## 安装

```bash
node ../../tools/check.mjs          # 可选：仓库自检
```

- **插件管理器（实时生效）**：`install_bundle <本目录绝对路径>`，然后刷新 GUI 页面。
- **官方装配（重启后生效）**：`dsh plugin --profile <profile> add <本目录绝对路径>`。

浏览器半边需要刷新一次页面；宿主半边改动需要重启 DSH。

## 策略

| 处理 | 失败 code |
| --- | --- |
| **无限重试** | `TIMEOUT`、`TRANSPORT`、`SERVER`、`RATE_LIMIT`、`EMPTY_RESPONSE`、`STREAM_CLOSED`、`MALFORMED_RESPONSE`、`HTTP_408/425/429`、`HTTP_5xx` |
| **立即失败** | `QUOTA`、`ACCOUNT_QUOTA`、`AUTH`、`INVALID_CREDENTIAL`、`MISSING_CREDENTIAL`、`ACCOUNT_SIGN_IN_REQUIRED`、`INVALID_REQUEST`、`MODEL_UNSUPPORTED`、`CONTENT_REFUSED`、`HTTP_400/401/402/403/404/413/415/422` 等 |
| **交给其它机制** | `CONTEXT_WINDOW_EXCEEDED`（压缩）、`IMAGE_OFFLOAD_REQUIRED`（图片卸载）、`ABORTED`（你点了停止） |
| **默认不重试** | 插件无法归类的 code（`PI_AI_ERROR`、`UNKNOWN` 等）；设置里的「未知失败也重试」可打开 |

额外兜底：失败文本里出现余额/额度字样（`insufficient quota`、`余额不足`、`配额`……）时，
即使 code 是 `TIMEOUT` 或 5xx 也按**永久失败**处理——中转站常把 402 报成普通错误。

### 等待节奏

首次 2 秒，按 ×1.8 指数增长，单次上限 60 秒，±20% 抖动；两次等待都可在设置页改。
提供方给出且不超过上限的 `Retry-After` 优先于本地退避。**没有尝试次数上限。**

等待发生在同一个 turn 内，模型看不到重试：会话历史仍是同一份，重试的步骤用相同前缀重跑，
KV cache 可以继续复用。任何时刻点「停止」都会打断等待。

## 开关

- **设置 → 自动重试**：开关、首次等待、最长等待、未知失败是否重试，以及当前状态与最近一次重试。
- **会话头药丸**：`自动重试 开/关`，点击即切换；重试进行中会显示进行中的数量。两处共享同一个状态。

开关与参数写成一份 JSON：有 profile 目录时写在 profile 里，否则写在 **DSH 主目录**
（`$DSH_HOME/auto-retry.json`，默认 `~/.dsh/auto-retry.json`），所以同一台机器上的各 profile
默认共用一份开关；Loader 行里的 `config` 只是声明默认值，GUI 改过的值优先。
宿主写入失败时，改动仍在本次运行中生效，页面会明确提示「未能写入」。

## 行为边界

- 只作用于 **agent loop 里的模型请求**。会话标题、摘要这类直接 `ctx.llm.stream()` 的调用仍是单次。
- **子代理**的模型请求同样会被重试。
- 每次重试都是一次**新的计费请求**；供应商长时间故障时会持续产生请求，请用停止按钮或关掉开关。
- 开关打开时本插件拥有判定权：即使提供方配置成 `retryPolicy.mode: always`，额度/鉴权类失败也会立即停止。
  关掉开关后完全回到内置的 5 次策略。
- 上下文超限压缩、图片卸载、用户取消仍由原有机制处理，本插件不接管。

## 测试

```bash
node test/policy.mjs        # 分类与退避
node test/store.mjs         # 状态文件：缺文件、损坏、旧格式、原子写
node test/host.mjs          # 监听器与路由：重试链、额度直停、取消、跨站拒绝、重启后恢复
node test/client-smoke.mjs  # 浏览器半边：两个插槽注册、药丸切换、设置页控件
```

零依赖，不需要安装 DSH：路由和监听器都在一个最小的 `ctx` 桩上驱动。

## 文件

```
lib/index.js   宿主半边：waterfall 监听器、重试链、状态路由
lib/policy.js  失败分类与退避（纯函数，测试直接驱动）
lib/store.js   profile 级的 auto-retry.json 读写
lib/client.js  浏览器半边：设置页与会话头药丸
```
