/**
 * @accsci/dsh-auto-retry — state file tests.
 *
 * The file is the only persistence the plugin has, and the one thing a user may
 * hand-edit, so a missing, corrupt, or hostile file must never take recovery
 * down with it.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readState, stateFilePath, writeState } from '../lib/store.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-retry-store-'))
const file = path.join(root, 'profile', 'auto-retry.json')

try {
  // Missing file: no overrides, not an error.
  assert.deepEqual(await readState(file), {})

  await writeState(file, {
    enabled: false,
    initialDelayMs: 5000,
    maxDelayMs: 45000,
    jitterRatio: 0.2,
    retryUnknown: true,
  })
  assert.deepEqual(await readState(file), {
    enabled: false,
    initialDelayMs: 5000,
    maxDelayMs: 45000,
    jitterRatio: 0.2,
    retryUnknown: true,
  })
  // The stored shape is versioned so a later release can migrate it.
  const stored = JSON.parse(await fs.readFile(file, 'utf8'))
  assert.equal(stored.version, 1)
  assert.equal(stored.settings.enabled, false)

  // A hand-broken file falls back to defaults instead of throwing.
  await fs.writeFile(file, '{ not json', 'utf8')
  assert.deepEqual(await readState(file), {})

  // Unknown fields and wrong types are dropped, never trusted.
  await fs.writeFile(file, JSON.stringify({
    version: 1,
    settings: { enabled: 'yes', initialDelayMs: 'nope', maxDelayMs: 9000, retryUnknown: 'true', injected: true },
  }), 'utf8')
  assert.deepEqual(await readState(file), { maxDelayMs: 9000 })

  // The flat legacy shape is accepted too, so an early hand-written file works.
  await fs.writeFile(file, JSON.stringify({ enabled: true, initialDelayMs: 1000 }), 'utf8')
  assert.deepEqual(await readState(file), { enabled: true, initialDelayMs: 1000 })

  // No temporary file is left behind by an atomic write.
  const leftovers = (await fs.readdir(path.dirname(file))).filter(name => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])

  // The path follows the active profile, then the configured harness home, then
  // the default harness home.
  assert.equal(
    stateFilePath({ DSH_PROFILE_DIR: path.join(root, 'profile') }),
    path.join(root, 'profile', 'auto-retry.json'),
  )
  assert.equal(
    stateFilePath({ DSH_HOME: path.join(root, 'home') }),
    path.join(root, 'home', 'auto-retry.json'),
  )
  assert.equal(
    stateFilePath({}),
    path.join(os.homedir(), '.dsh', 'auto-retry.json'),
  )
} finally {
  await fs.rm(root, { recursive: true, force: true })
}

console.log('auto-retry store: ok')
