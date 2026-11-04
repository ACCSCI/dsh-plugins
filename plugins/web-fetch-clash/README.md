# dsh-web-fetch-clash

让 DSH 的 `web_fetch` 在 Clash Verge 的 **TUN / 系统代理 / 全部关闭 / Clash 退出** 四种状态下都能抓网页。

## 为什么需要

内置 provider（`@deepseek-ai/dsh-web-fetch-http`）会先用系统 DNS 解析目标，再把每个地址交给
ipaddr.js 判定，只有 `unicast` 才放行。Clash 在 TUN 模式下用 fake-IP 应答，所有域名都解析到
`198.18.0.0/15` 与 `2001:2::/64`，被判定为 reserved，于是无论访问哪个站点都报：

```
URL hostname "example.com" resolves to a non-public IP address
```

这跟网络是否通畅无关——同一时刻 `curl` 直连、浏览器都正常。

## 做法

只替换传输层，其余（重定向策略、大小上限、字符集解码、错误码）保持官方语义：

| 情况 | 走法 |
| --- | --- |
| 本地 Clash 混合端口在监听（TUN / 系统代理 / 都关都算） | 交给代理，由代理解析域名 → 本地 DNS 不参与判定 |
| 代理不可用（Clash 退出 / 端口失联） | 直连，并把 fake-IP 段当作「TUN 哨兵地址」放行 |
| 私网字面量（`127.0.0.1`、`10.x` …） | 照旧拒绝，SSRF 防护保留 |
| 跨域重定向 | 照旧拒绝，与官方一致 |

端口探测顺序：`config.proxyPort` → Clash Verge `config.yaml` 的 `mixed-port` → 7897/7890/7891…
结果缓存 3 秒；请求中途代理掉线会回退直连一次。

零运行时依赖，只用 Node 内置模块。

## 装配方式

profile 侧是**真副本**（由 `npm pack` 出的 tarball 安装），不是软链，所以本目录可以随意移动/重命名。

`dist/dsh-web-fetch-clash-1.0.0.tgz` 就是 profile 当前锁定的那个包
（`dependencies` 里写着 `file:D:/Projects/dsh-plugins/plugins/web-fetch-clash/dist/…tgz`），
**别删 `dist/`**，否则下次 `pnpm install` 找不到包。

升级步骤：

```powershell
cd D:\Projects\dsh-plugins\plugins\web-fetch-clash
npm pack --pack-destination .\dist
# 然后在 DSH 里对 plugin_manager 执行：
#   remove_bundle  dsh-web-fetch-clash
#   install_bundle D:\Projects\dsh-plugins\plugins\web-fetch-clash\dist\dsh-web-fetch-clash-<版本>.tgz
```

只改 `index.js` 调试时可以临时用目录安装（`link:` 软链），改完再按上面打包固定。

## 配置

`cordis.patch.yml` 里的 `config`（全部可选）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `proxyPort` | 自动探测 | 强制指定 Clash 混合端口 |
| `ports` | `[7897, 7890, 7891, 10801, 10808, 20171]` | 探测候选 |
| `probeTimeoutMs` | `200` | 单端口探活超时 |
| `maxResponseBytes` / `maxBodyChars` / `timeoutMs` / `maxRedirects` / `userAgent` | 同官方默认 | 传输上限 |

## 自测

```powershell
node test/live-local.mjs
```

覆盖：代理分支、无代理的 fake-IP 直连分支、私网字面量拒绝、跨域重定向拒绝。

这是**活体**用例（`live-` 前缀，`tools/check.mjs` 不会在 CI 里跑它）：它会真的访问 example.com 与
google.com，因此需要能出网的网络与正在运行的 Clash，适合在本机手工执行，不适合做仓库门禁。
