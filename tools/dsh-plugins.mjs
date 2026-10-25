#!/usr/bin/env node
/**
 * dsh-plugins toolbox.
 *
 *   check   Repository consistency: manifests, README table, CI wiring, profile
 *           snapshot, and (unless --no-tests) every plugin's offline suite.
 *   sync    Keep ~/.dsh/profiles/<profile> and ~/.dsh/plugins in step with the
 *           snapshot under profile/. Dry-run unless --apply / --install.
 *
 * Zero dependencies, plain Node. Nothing here imports DSH: the toolbox has to
 * keep working when the very thing it manages is broken.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const PLUGINS_DIR = path.join(REPO, 'plugins')
const SNAPSHOT_ROOT = path.join(REPO, 'profile')
const PROFILE_FILES = ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']

const argv = process.argv.slice(2)
const command = argv[0] ?? 'check'
const flags = new Set(argv.slice(1).filter((a) => a.startsWith('--')))
const profileName = option('--profile') ?? 'desktop'

function option(flag) {
  const i = argv.indexOf(flag)
  const next = argv[i + 1]
  return i >= 0 && next && !next.startsWith('--') ? next : undefined
}

const say = (...parts) => console.log(parts.join(' '))
const rel = (p) => path.relative(REPO, p).split(path.sep).join('/')
const exists = (p) => fs.existsSync(p)

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function listPlugins() {
  return fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => exists(path.join(PLUGINS_DIR, name, 'package.json')))
    .sort()
}

function patchName(file) {
  const match = fs.readFileSync(file, 'utf8').match(/^\s*name:\s*'([^']+)'/m)
  return match ? match[1] : null
}

// ---------------------------------------------------------------- check ----

function check() {
  const problems = []
  const plugins = listPlugins()
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8')
  const workflowFile = path.join(REPO, '.github', 'workflows', 'tests.yml')
  const workflow = exists(workflowFile) ? fs.readFileSync(workflowFile, 'utf8') : ''

  for (const dir of plugins) {
    const root = path.join(PLUGINS_DIR, dir)
    const pkg = readJson(path.join(root, 'package.json'))
    const fail = (message) => problems.push(rel(root) + ': ' + message)

    if (!/^@dsh-external\//.test(pkg.name)) fail('package name must be scoped @dsh-external/, got ' + pkg.name)
    if (pkg.private !== true) fail('package must stay "private": true (it is installed by path, never published)')

    const patchRel = pkg.dsh?.bundle?.patch
    if (!patchRel) {
      fail('missing dsh.bundle.patch')
    } else if (!exists(path.join(root, patchRel))) {
      fail('dsh.bundle.patch points at a missing file: ' + patchRel)
    } else {
      const inserted = patchName(path.join(root, patchRel))
      if (inserted !== pkg.name) fail('patch inserts "' + inserted + '" but the package is "' + pkg.name + '"')
    }

    if (pkg.dsh?.client) {
      if (pkg.dsh.client.platform !== 'web') fail('dsh.client.platform must be "web"')
      if (!pkg.exports?.['./client']) fail('dsh.client declared but exports["./client"] is missing')
      if (!exists(path.join(root, 'lib', 'client.js'))) fail('missing lib/client.js')
    }

    for (const entry of pkg.files ?? []) {
      const probe = entry.includes('*') ? path.join(root, path.dirname(entry)) : path.join(root, entry)
      if (!exists(probe)) fail('files[] entry does not exist: ' + entry)
    }

    if (!exists(path.join(root, 'README.md'))) fail('missing README.md')
    if (!readme.includes('(plugins/' + dir + ')')) fail('root README has no link to plugins/' + dir)

    const testDir = path.join(root, 'test')
    const tests = exists(testDir) ? fs.readdirSync(testDir).filter((f) => f.endsWith('.mjs')) : []
    if (tests.length === 0) fail('no test/*.mjs')
    if (tests.length > 0 && !workflow.includes('plugins/' + dir + '/test/') && !workflow.includes('tools/dsh-plugins.mjs')) {
      fail('CI workflow neither runs plugins/' + dir + '/test/ nor the toolbox')
    }
  }

  const snapshot = path.join(SNAPSHOT_ROOT, profileName, 'package.json')
  if (exists(snapshot)) {
    const pkg = readJson(snapshot)
    const deps = pkg.dependencies ?? {}
    const bundles = pkg.dsh?.profile?.bundles ?? []
    const localNames = new Set(plugins.map((dir) => readJson(path.join(PLUGINS_DIR, dir, 'package.json')).name))
    for (const [name, spec] of Object.entries(deps)) {
      if (!String(spec).startsWith('link:')) continue
      const target = path.resolve(path.dirname(snapshot), String(spec).slice(5))
      const inside = path.relative(PLUGINS_DIR, target)
      if (!exists(path.join(target, 'package.json'))) problems.push('profile: ' + name + ' links to a missing package: ' + rel(target))
      else if (inside.startsWith('..') || path.isAbsolute(inside)) problems.push('profile: ' + name + ' must link inside plugins/')
      if (!bundles.includes(name)) problems.push('profile: ' + name + ' is a dependency but not a bundle')
    }
    for (const name of bundles) {
      if (!localNames.has(name)) continue
      if (!String(deps[name] ?? '').startsWith('link:')) problems.push('profile: bundle ' + name + ' is not a link: dependency')
    }
  } else {
    problems.push('missing profile snapshot: ' + rel(snapshot))
  }

  if (!flags.has('--no-tests')) {
    for (const dir of plugins) {
      const testDir = path.join(PLUGINS_DIR, dir, 'test')
      if (!exists(testDir)) continue
      for (const file of fs.readdirSync(testDir).filter((f) => f.endsWith('.mjs') && !f.startsWith('live-'))) {
        const filePath = path.join(testDir, file)
        const run = spawnSync(process.execPath, [filePath], { cwd: REPO, encoding: 'utf8' })
        const output = ((run.stdout ?? '') + (run.stderr ?? '')).trim()
        if (run.status !== 0) problems.push(rel(filePath) + ' failed:\n' + output)
        else say('  ok', rel(filePath))
      }
    }
  }

  if (problems.length > 0) {
    say('')
    for (const problem of problems) say('  !!', problem)
    say('')
    say('check failed: ' + problems.length + ' problem(s)')
    process.exit(1)
  }
  say('check ok: ' + plugins.length + ' plugin(s), profile snapshot matches the manifests')
}

// ----------------------------------------------------------------- sync ----

const home = () => process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const snapshotDir = () => path.join(SNAPSHOT_ROOT, profileName)
const liveDir = () => path.join(home(), 'profiles', profileName)

function linkPlan(pkgFile) {
  const pkg = readJson(pkgFile)
  const plan = []
  for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
    if (!String(spec).startsWith('link:')) continue
    const target = path.resolve(path.dirname(pkgFile), String(spec).slice(5))
    plan.push({ name, spec: String(spec), target, linkPath: path.join(home(), 'plugins', path.basename(target)) })
  }
  return plan
}

function linkState(item) {
  if (!exists(item.linkPath)) return 'missing'
  const stat = fs.lstatSync(item.linkPath)
  if (!stat.isSymbolicLink()) return 'real-dir'
  const resolved = path.resolve(item.linkPath, '..', fs.readlinkSync(item.linkPath))
  return resolved === item.target ? 'ok' : 'wrong-target'
}

function sameFile(a, b) {
  const one = fs.readFileSync(a, 'utf8').replace(/\r\n/g, '\n')
  const two = fs.readFileSync(b, 'utf8').replace(/\r\n/g, '\n')
  return one === two
}

function guardApp() {
  if (process.platform !== 'win32' || flags.has('--force')) return
  const run = spawnSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH'], { encoding: 'utf8' })
  if ((run.stdout ?? '').includes('DeepSeek Harness.exe')) {
    say('refusing to touch a live profile while DeepSeek Harness is running (quit it, or pass --force)')
    process.exit(1)
  }
}

function backup(live) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = path.join(home(), 'backups', 'profile-sync-' + stamp)
  fs.mkdirSync(dir, { recursive: true })
  for (const file of PROFILE_FILES) {
    const src = path.join(live, file)
    if (exists(src)) fs.copyFileSync(src, path.join(dir, file))
  }
  say('backup:', dir)
}

function applyLinks(plan) {
  for (const item of plan) {
    const state = linkState(item)
    if (state === 'ok') continue
    if (state === 'real-dir') {
      say('!! ' + item.linkPath + ' is a real directory, not a link; move it away and re-run')
      process.exit(1)
    }
    fs.mkdirSync(path.dirname(item.linkPath), { recursive: true })
    if (exists(item.linkPath)) fs.unlinkSync(item.linkPath)
    fs.symlinkSync(item.target, item.linkPath, 'junction')
    say('linked', item.linkPath, '->', item.target)
  }
}

function copyFiles(snapshot, live) {
  fs.mkdirSync(live, { recursive: true })
  for (const file of PROFILE_FILES) {
    const src = path.join(snapshot, file)
    if (!exists(src)) continue
    fs.copyFileSync(src, path.join(live, file))
    say('wrote', path.join(live, file))
  }
}

function runtime() {
  const candidates = []
  const runtimes = path.join(home(), 'dsh-runtimes')
  if (exists(runtimes)) {
    for (const dir of fs.readdirSync(runtimes)) candidates.push(path.join(runtimes, dir, 'dependencies'))
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'primary-runtime', 'dependencies'))
  }
  for (const base of candidates) {
    const node = path.join(base, 'node', 'bin', 'node.exe')
    const pnpm = path.join(base, 'pnpm', 'bin', 'pnpm.cjs')
    if (exists(node) && exists(pnpm)) return { node, pnpm }
  }
  return null
}

function install(live) {
  const rt = runtime()
  if (!rt) {
    say('!! no app-bundled node+pnpm found; install from the Plugins page instead')
    process.exit(1)
  }
  say('installing with', rt.pnpm)
  const run = spawnSync(rt.node, [rt.pnpm, 'install', '--prefer-offline'], { cwd: live, stdio: 'inherit' })
  if (run.status !== 0) process.exit(run.status ?? 1)
}

function relativizeLinks(text, live) {
  return text.replace(/link:([^"'\s]+)/g, (whole, target) => {
    const abs = path.resolve(live, target)
    const inside = path.relative(PLUGINS_DIR, abs)
    if (inside.startsWith('..') || path.isAbsolute(inside)) return whole
    return 'link:../../plugins/' + inside.split(path.sep).join('/')
  })
}

function capture() {
  const live = liveDir()
  if (!exists(path.join(live, 'package.json'))) {
    say('no live profile at ' + live)
    process.exit(1)
  }
  const snapshot = snapshotDir()
  fs.mkdirSync(snapshot, { recursive: true })
  for (const file of PROFILE_FILES) {
    const src = path.join(live, file)
    if (!exists(src)) continue
    const text = PROFILE_FILES.includes(file) ? relativizeLinks(fs.readFileSync(src, 'utf8'), live) : ''
    fs.writeFileSync(path.join(snapshot, file), text)
    say('captured', file)
  }
}

function sync() {
  if (flags.has('--capture')) {
    capture()
    return
  }
  const snapshot = snapshotDir()
  if (!exists(path.join(snapshot, 'package.json'))) {
    say('no snapshot at ' + rel(snapshot))
    process.exit(1)
  }
  const live = liveDir()
  const plan = linkPlan(path.join(snapshot, 'package.json'))

  say('profile:', live)
  say('')
  say('  file                         state')
  for (const file of PROFILE_FILES) {
    const a = path.join(snapshot, file)
    const b = path.join(live, file)
    const state = !exists(a) ? 'snapshot-missing' : !exists(b) ? 'missing' : sameFile(a, b) ? 'same' : 'different'
    say('  ' + (file + ' ').padEnd(28) + state)
  }
  say('')
  say('  link                         state')
  for (const item of plan) say('  ' + (item.name + ' ').padEnd(28) + linkState(item))

  const dirty = PROFILE_FILES.some((file) => {
    const a = path.join(snapshot, file)
    const b = path.join(live, file)
    return exists(a) && (!exists(b) || !sameFile(a, b))
  }) || plan.some((item) => linkState(item) !== 'ok')

  if (!flags.has('--apply') && !flags.has('--install')) {
    say('')
    say(dirty ? 'dry run: pass --apply to write the profile' : 'already in sync')
    return
  }

  if (flags.has('--apply')) {
    guardApp()
    backup(live)
    applyLinks(plan)
    copyFiles(snapshot, live)
  }
  if (flags.has('--install')) install(live)
  say('')
  say('done: restart DeepSeek Harness so the host halves reload')
}

// ----------------------------------------------------------------- main ----

if (command === 'check') check()
else if (command === 'sync') sync()
else {
  say('usage: node tools/dsh-plugins.mjs <check|sync> [options]')
  say('')
  say('  check              manifests, README, CI, profile snapshot, offline tests')
  say('    --no-tests       skip running the suites')
  say('  sync               compare the profile snapshot with the live profile (dry run)')
  say('    --apply          write it: relink ~/.dsh/plugins, copy the four profile files')
  say('    --install        run the app-bundled pnpm install afterwards')
  say('    --capture        copy the live profile back into profile/ (relative links)')
  say('    --profile <name> profile to target (default: desktop)')
  say('    --force          allow --apply while the app is running')
  process.exit(command === 'help' ? 0 : 1)
}
