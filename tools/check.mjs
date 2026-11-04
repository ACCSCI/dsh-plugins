#!/usr/bin/env node
/**
 * Repository self-check.
 *
 *   node tools/check.mjs             # manifests, README, CI wiring, then every suite
 *   node tools/check.mjs --no-tests  # manifests only
 *
 * Zero dependencies, no DSH install, no network. Runs the same way in CI and on
 * a laptop; the point is to catch the drift that used to happen silently —
 * a package name that no longer matches the row its cordis.patch.yml inserts,
 * a files[] entry that stopped existing, a plugin missing from the README table
 * or from the CI job. It says nothing about publishing: these packages are
 * installed by path, so a registry is optional.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const PLUGINS_DIR = path.join(REPO, 'plugins')
const SCOPE = '@accsci/'
const runTests = !process.argv.includes('--no-tests')

const say = (...parts) => console.log(parts.join(' '))
const rel = (p) => path.relative(REPO, p).split(path.sep).join('/')
const exists = (p) => fs.existsSync(p)
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

/**
 * Every directory that holds a plugin package: `plugins/<name>`, plus a
 * root-level package that carries its own `cordis.patch.yml` (a personal
 * bundle that predates the `plugins/` convention). Sorted for stable output.
 */
function listPlugins() {
  const roots = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(PLUGINS_DIR, e.name))
    .filter((root) => exists(path.join(root, 'package.json')))

  for (const entry of fs.readdirSync(REPO, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (entry.name === 'plugins' || entry.name === 'tools' || entry.name === 'node_modules') continue
    const root = path.join(REPO, entry.name)
    if (exists(path.join(root, 'package.json')) && exists(path.join(root, 'cordis.patch.yml'))) roots.push(root)
  }

  return roots.sort((a, b) => rel(a).localeCompare(rel(b)))
}

/**
 * The file behind `exports["./client"]`, whether it is written as a bare path
 * or as a conditions object. The client half is not always `lib/client.js`
 * (personal bundles keep it next to the host half), so follow the manifest
 * instead of assuming a layout.
 */
function clientEntry(pkg) {
  const exported = pkg.exports?.['./client']
  if (typeof exported === 'string') return exported
  if (exported && typeof exported === 'object') return exported.default ?? Object.values(exported)[0] ?? null
  return null
}

function patchName(file) {
  const match = fs.readFileSync(file, 'utf8').match(/^\s*name:\s*'([^']+)'/m)
  return match ? match[1] : null
}

const problems = []
const plugins = listPlugins()
const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8')
const workflowFile = path.join(REPO, '.github', 'workflows', 'tests.yml')
const workflow = exists(workflowFile) ? fs.readFileSync(workflowFile, 'utf8') : ''

for (const root of plugins) {
  const dir = rel(root)
  const pkg = readJson(path.join(root, 'package.json'))
  const fail = (message) => problems.push(dir + ': ' + message)

  // Shared plugins carry the `@accsci/` identity. A personal bundle may keep an
  // unscoped `dsh-*` name as long as it stays private: that is the name it was
  // installed under, and renaming it would be a profile migration, not a fix.
  const personallyNamed = pkg.private === true && /^dsh-[a-z0-9-]+$/.test(pkg.name)
  if (!pkg.name.startsWith(SCOPE) && !personallyNamed) {
    fail('package name must be scoped ' + SCOPE + ' (or a private dsh-* bundle), got ' + pkg.name)
  }
  if (!pkg.version) fail('missing version')
  if (!pkg.license) fail('missing license')

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
    const entry = clientEntry(pkg)
    if (!entry) fail('dsh.client declared but exports["./client"] is missing')
    else if (!exists(path.join(root, entry))) fail('exports["./client"] points at a missing file: ' + entry)
  }

  for (const entry of pkg.files ?? []) {
    const probe = entry.includes('*') ? path.join(root, path.dirname(entry)) : path.join(root, entry)
    if (!exists(probe)) fail('files[] entry does not exist: ' + entry)
  }

  if (!exists(path.join(root, 'README.md'))) fail('missing README.md')
  if (!readme.includes('(' + dir + ')')) fail('root README has no link to ' + dir)

  const testDir = path.join(root, 'test')
  const tests = exists(testDir) ? fs.readdirSync(testDir).filter((f) => f.endsWith('.mjs')) : []
  if (tests.length === 0) fail('no test/*.mjs')
  if (tests.length > 0 && !workflow.includes(dir + '/test/') && !workflow.includes('tools/check.mjs')) {
    fail('CI workflow neither runs ' + dir + '/test/ nor the check tool')
  }
}

if (runTests) {
  for (const root of plugins) {
    const testDir = path.join(root, 'test')
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
say('check ok: ' + plugins.length + ' plugin(s)')
