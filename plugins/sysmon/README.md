# sysmon

Live **CPU**, **memory** and **GPU** readout in the DSH composer dock.

Three compact meters sit under the input box and poll one host route. CPU and
memory come from `node:os` in the Host process, so they cost nothing and work on
every platform. GPU utilisation is only published through the Windows performance
counters, so it needs a small PowerShell sampler; everywhere else the GPU meter
renders as "unavailable" rather than as 0%.

## What it adds

| Half | Contribution |
| --- | --- |
| host | `GET /sysmon/stats` (plain `webServer` route, no auth, no Remote contribution) |
| client | three meters registered into `conversation.composer.dock` |

The route is outside `/api` on purpose: the widget needs no codec and no
authenticated fetch, and it exposes nothing but utilisation numbers.

## Snapshot shape

```json
{
  "ts": 1761400000000,
  "host": { "platform": "win32", "cores": 24 },
  "cpu": { "pct": 12.5, "cores": 24 },
  "mem": { "used": 21474836480, "total": 68719476736, "pct": 31.2 },
  "gpu": { "pct": 7, "dedicatedMB": 1024, "sharedMB": 0, "available": true, "detail": "ok" }
}
```

`cpu.pct` is a delta between two ticks, so the very first snapshot of a fresh
activation may carry `null` — the widget shows a dash, not a zero.

## Config

```yaml
- insert:
    - id: sysmon
      name: '@accsci/dsh-sysmon'
      config:
        intervalMs: 2000   # clamped to 500..60000
        gpu: true          # false = never spawn the sampler
```

## Install

```bash
# from a checkout of this repository
# plugin manager (live profile):   install_bundle <absolute path to plugins/sysmon>
# official assembly (after restart): dsh plugin --profile <profile> add <absolute path to plugins/sysmon>
```

## Tests

```bash
node plugins/sysmon/test/host.mjs
```

The suite drives the real route handler over a shimmed context and covers the
config clamp, the JSON contract, `HEAD`, and the `405` path. It runs with the GPU
sampler disabled, so it never touches the machine's counters and runs on CI.

**What CI does not cover:** the GPU reading itself. The sampler is a PowerShell
PDH client (`lib/gpu-sampler.ps1`) that only exists on Windows; a green suite says
the contract holds, not that a specific GPU reports the right percentage.

## Layout

```
lib/index.js        # host half: sampler, route, config
lib/client.js       # browser half: three meters
lib/gpu-sampler.ps1 # Windows PDH sampler (one line per sample)
locale/*.json       # plugin list title/description
icon.svg            # plugin list icon
```

## 中文摘要

在 DSH 输入框下方实时显示 **CPU / 内存 / GPU** 占用：CPU 与内存取自宿主进程的
`node:os`，全平台可用；GPU 只能走 Windows 性能计数器，由 `lib/gpu-sampler.ps1`
常驻采样，非 Windows 平台显示为"不可用"而不是 0%。

配置项：`intervalMs`（500–60000，默认 2000）、`gpu`（false 则不启动采样器）。
测试只覆盖配置归一化与 HTTP 契约，**不覆盖 GPU 读数本身**。
