#!/usr/bin/env node
/**
 * Plugin market index generator.
 *
 *   node tools/market-index.mjs          # write docs/index.json and docs/icons/
 *   node tools/market-index.mjs --check  # verify the committed index is current
 *
 * DSH has no built-in index source: a published `index.json` (format 1) is how
 * other installations discover these packages at all. This repository is a
 * monorepo, so every version is pinned to a git commit plus the plugin's
 * directory, and the version list comes from the per-package tags
 * `<name>@<version>` — the tag the market generator would read, spelled the way
 * `git tag` accepts it.
 *
 * Zero dependencies, no network: `git` is the only requirement. The output is
 * meant to be validated before publishing (`@deepseek-ai/dsh-plugin-market-index`
 * ships with a DSH installation); that validator is not a dependency of this
 * repository, so it is not called from here.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const PLUGINS_DIR = path.join(REPO, 'plugins')
const OUT_DIR = path.join(REPO, 'docs')
const ICON_DIR = path.join(OUT_DIR, 'icons')
const INDEX_FILE = path.join(OUT_DIR, 'index.json')
const checkOnly = process.argv.includes('--check')

const INDEX_TITLE = { en: 'ACCSCI DSH plugins', zh: 'ACCSCI 的 DSH 插件' }
const INDEX_DESCRIPTION = {
  en: 'Plugins for DeepSeek Harness (dsh): host + web-client halves, installed from this repository by commit.',
  zh: '面向 DeepSeek Harness（dsh）的插件：host 半 + 浏览器半，按提交从本仓库安装。',
}

const say = (...parts) => console.log(parts.join(' '))
const rel = (p) => path.relative(REPO, p).split(path.sep).join('/')
const exists = (p) => fs.existsSync(p)
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

function git(args) {
  const run = spawnSync('git', args, { cwd: REPO, encoding: 'utf8' })
  if (run.status !== 0) throw new Error('git ' + args.join(' ') + ' failed: ' + (run.stderr ?? '').trim())
  return run.stdout.trim()
}

/**
 * The same discovery rule the self-check uses: `plugins/<name>`, plus a
 * root-level package that carries its own `cordis.patch.yml`.
 */
function listPlugins() {
  const roots = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(PLUGINS_DIR, e.name))
    .filter((root) => exists(path.join(root, 'package.json')))

  for (const entry of fs.readdirSync(REPO, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (['plugins', 'tools', 'docs', 'node_modules'].includes(entry.name)) continue
    const root = path.join(REPO, entry.name)
    if (exists(path.join(root, 'package.json')) && exists(path.join(root, 'cordis.patch.yml'))) roots.push(root)
  }

  return roots.sort((a, b) => rel(a).localeCompare(rel(b)))
}

/** `@accsci/dsh-sysmon` → `accsci-dsh-sysmon`; used as the icon filename. */
const iconName = (name) => name.replace(/^@/, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase()

const repoUrl = git(['remote', 'get-url', 'origin'])
  .replace(/^git\+/, '')
  .replace(/\.git$/, '')
  .replace(/^git@([^:]+):/, 'https://$1/')

/**
 * Every `<name>@<version>` tag that points at this package, newest first.
 * The tag's own manifest must agree with the tag: a mistyped tag would
 * otherwise publish a version that cannot be installed.
 */
function taggedVersions(pkg, dir) {
  const pattern = new RegExp('^' + pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '@(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)$')
  const versions = []
  for (const tag of git(['tag', '--list']).split('\n').filter(Boolean)) {
    const match = tag.match(pattern)
    if (!match) continue
    const commit = git(['rev-list', '-n', '1', tag])
    const manifest = JSON.parse(git(['show', commit + ':' + dir + '/package.json']))
    if (manifest.version !== match[1]) {
      throw new Error(`tag ${tag} points at ${dir}/package.json version ${manifest.version}`)
    }
    versions.push({ version: match[1], commit, publishTimestamp: Number(git(['log', '-1', '--format=%ct', tag])) })
  }
  return versions
}

/** The version on the default branch, unless a tag already records it. */
function headVersion(pkg, dir, taken) {
  const commit = git(['rev-parse', 'HEAD'])
  if (taken.includes(pkg.version)) return []
  const manifest = JSON.parse(git(['show', commit + ':' + dir + '/package.json']))
  if (manifest.version !== pkg.version) return []
  return [{ version: pkg.version, commit, publishTimestamp: Number(git(['log', '-1', '--format=%ct', commit])) }]
}

const published = []
for (const root of listPlugins()) {
  const dir = rel(root)
  const pkg = readJson(path.join(root, 'package.json'))
  // Private bundles carry machine- or network-specific behaviour; the market
  // formats only installable packages, so they stay out of the index entirely.
  if (pkg.private === true) continue

  const tagged = taggedVersions(pkg, dir)
  const versions = [...tagged, ...headVersion(pkg, dir, tagged.map((v) => v.version))]
    .sort((a, b) => b.version.localeCompare(a.version, 'en', { numeric: true }))
  if (versions.length === 0) {
    say('  skip', dir, '(no tag and no committed version)')
    continue
  }

  const icon = exists(path.join(root, 'icon.svg')) ? 'icons/' + iconName(pkg.name) + '.svg' : undefined
  const market = pkg.market ?? {}
  // `manifest.description` is the English text every package already carries;
  // `market.description` / `market.title` add the other languages. A localized
  // object must contain `en`, so English always comes from the manifest.
  const description = pkg.description
    ? { en: pkg.description, ...(market.description ?? {}) }
    : market.description
  published.push({
    name: pkg.name,
    title: market.title ?? pkg.name,
    description,
    icon,
    author: market.author ?? 'ACCSCI',
    homepage: repoUrl + '/blob/main/' + dir + '/README.md',
    repository: { url: repoUrl, directory: dir },
    versions: versions.map(({ version, commit, publishTimestamp }) => ({
      version,
      publishTimestamp,
      source: { type: 'git', url: repoUrl + '.git', commit, path: dir },
    })),
    _root: root,
  })
}

const index = {
  format: 1,
  title: INDEX_TITLE,
  description: INDEX_DESCRIPTION,
  plugins: published.map(({ _root, ...plugin }) => plugin),
}
const serialized = JSON.stringify(index, null, 2) + '\n'

const PAGE_FILE = path.join(OUT_DIR, 'index.html')

/** The Pages landing page: what the index is, its URL, and what it lists. */
function renderPage() {
  const github = repoUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/)
  const site = github ? `https://${github[1].toLowerCase()}.github.io/${github[2]}/` : './'
  const indexUrl = site + 'index.json'
  const esc = (value) => String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  const text = (value, lang) => (typeof value === 'string' ? value : value?.[lang] ?? value?.en ?? '')

  const cards = index.plugins.map((plugin) => {
    const latest = plugin.versions[0]
    const icon = plugin.icon ? `<img class="icon" src="${esc(plugin.icon)}" alt="" width="44" height="44">` : ''
    const en = text(plugin.description, 'en')
    const enLine = en && en !== text(plugin.description, 'zh') ? `<p class="en">${esc(en)}</p>` : ''
    return `<article class="card">${icon}<div><h2>${esc(text(plugin.title, 'zh'))} <span class="en tag">${esc(text(plugin.title, 'en'))}</span></h2><p>${esc(text(plugin.description, 'zh'))}</p>${enLine}<p class="meta"><code>${esc(plugin.name)}</code> · v${esc(latest.version)} · <a href="${esc(plugin.homepage)}">源码</a></p></div></article>`
  }).join('\n    ')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(text(index.title, 'zh'))}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 48px 24px 64px; background: #0b1120; color: #e2e8f0;
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; }
  main { max-width: 780px; margin: 0 auto; }
  h1 { margin: 0 0 4px; font-size: 1.9rem; letter-spacing: -0.02em; }
  .lead { margin: 0 0 32px; color: #94a3b8; }
  h2 { margin: 0 0 6px; font-size: 1.05rem; }
  h2 .tag { font-size: 0.8rem; color: #94a3b8; font-weight: 400; }
  p { margin: 0 0 6px; }
  .en { color: #94a3b8; font-size: 0.9rem; }
  .meta { color: #94a3b8; font-size: 0.85rem; }
  code { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 0.9em; color: #93c5fd; }
  a { color: #60a5fa; }
  .url { display: block; margin: 10px 0 0; padding: 12px 14px; border-radius: 10px; background: #0f172a;
    border: 1px solid #1e293b; overflow-wrap: anywhere; }
  ol { margin: 8px 0 0; padding-left: 1.3em; }
  .card { display: flex; gap: 16px; align-items: flex-start; padding: 16px 18px; margin: 0 0 10px;
    background: #0f172a; border: 1px solid #1e293b; border-radius: 12px; }
  .icon { flex: none; border-radius: 10px; }
  .note { color: #94a3b8; font-size: 0.85rem; margin-top: 32px; }
</style>
</head>
<body>
<main>
  <h1>${esc(text(index.title, 'zh'))}</h1>
  <p class="lead">${esc(text(index.description, 'zh'))}</p>

  <h2>把它加进 DSH</h2>
  <ol>
    <li>打开<b>插件</b>，在<b>实验性插件</b>下打开<b>自定义插件索引</b>。</li>
    <li>切到<b>发现</b>，点<b>添加索引源</b>，粘贴下面的地址。</li>
    <li>选择插件并<b>安装</b>；确认框会显示 git 仓库、提交和目录。</li>
  </ol>
  <code class="url">${esc(indexUrl)}</code>

  <h2 style="margin-top:36px">索引里的插件</h2>
  <div class="list">
    ${cards}
  </div>

  <p class="note">索引是第三方内容：标题、图标和来源都由本仓库声明，DSH 只校验文件格式。本仓库同时提供
  <a href="${esc(repoUrl)}">改过的源码</a>，按目录安装这条路一直可用。</p>
</main>
</body>
</html>
`
}

if (checkOnly) {
  const stale = [[INDEX_FILE, serialized], [PAGE_FILE, renderPage()]]
    .filter(([file, expected]) => (exists(file) ? fs.readFileSync(file, 'utf8') : '') !== expected)
    .map(([file]) => rel(file))
  if (stale.length > 0) {
    say('stale: ' + stale.join(', ') + ' — run node tools/market-index.mjs')
    process.exit(1)
  }
  say('ok ' + rel(INDEX_FILE) + ' (' + published.length + ' plugin(s))')
  process.exit(0)
}

fs.mkdirSync(ICON_DIR, { recursive: true })
for (const plugin of published) {
  if (!plugin.icon) continue
  fs.copyFileSync(path.join(plugin._root, 'icon.svg'), path.join(OUT_DIR, plugin.icon))
}
fs.writeFileSync(INDEX_FILE, serialized)
fs.writeFileSync(PAGE_FILE, renderPage())

for (const plugin of published) {
  say('  ' + plugin.name + ' ' + plugin.versions.map((v) => v.version).join(', '))
}
say('wrote ' + rel(INDEX_FILE) + ' (' + published.length + ' plugin(s))')
