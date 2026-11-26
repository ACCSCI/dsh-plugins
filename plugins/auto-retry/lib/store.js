/**
 * Durable toggle and policy overrides for @accsci/dsh-auto-retry.
 *
 * One small JSON file, profile-scoped so two profiles keep independent
 * switches. The Loader row config stays the declarative default; a value the
 * user changed in the GUI is stored here and wins until it is written back.
 * Reads never throw: a missing, unreadable, or hand-broken file falls back to
 * the defaults, because a broken preferences file must not disable recovery.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Bump when the stored shape changes in a way that needs migration. */
export const STATE_VERSION = 1;

/**
 * Where the state file lives: inside the active profile when one is known,
 * otherwise under the harness home, otherwise under the default harness home.
 *
 * A plugin Host process does not receive the `DSH_PROFILE_DIR` a shell tool
 * sees, so in practice this resolves through `$DSH_HOME`; the first branch keeps
 * per-profile state for launches that do provide it.
 * @param {Record<string, string | undefined>} [env] - process environment.
 * @returns {string} absolute path of the JSON file.
 */
export function stateFilePath(env = process.env) {
  const profileDir = env.DSH_PROFILE_DIR;
  if (typeof profileDir === 'string' && profileDir.trim() !== '') {
    return path.join(profileDir, 'auto-retry.json');
  }
  const home = env.DSH_HOME;
  if (typeof home === 'string' && home.trim() !== '') {
    return path.join(home, 'auto-retry.json');
  }
  return path.join(os.homedir(), '.dsh', 'auto-retry.json');
}

/** Keep only fields this plugin understands, so a hand-edited file cannot inject state. */
function pick(raw) {
  if (raw === null || typeof raw !== 'object') return {};
  const source = raw.settings !== null && typeof raw.settings === 'object' ? raw.settings : raw;
  const picked = {};
  if (typeof source.enabled === 'boolean') picked.enabled = source.enabled;
  for (const key of ['initialDelayMs', 'maxDelayMs']) {
    const value = Number(source[key]);
    if (Number.isFinite(value)) picked[key] = value;
  }
  const jitter = Number(source.jitterRatio);
  if (Number.isFinite(jitter)) picked.jitterRatio = jitter;
  if (typeof source.retryUnknown === 'boolean') picked.retryUnknown = source.retryUnknown;
  return picked;
}

/**
 * Read the persisted overrides.
 * @param {string} file - absolute path of the state file.
 * @returns {Promise<Record<string, unknown>>} stored fields, or an empty object.
 */
export async function readState(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return {};
    return {};
  }
  try {
    return pick(JSON.parse(text));
  } catch {
    return {};
  }
}

/**
 * Persist the overrides atomically.
 * @param {string} file - absolute path of the state file.
 * @param {Record<string, unknown>} settings - complete settings object to keep.
 * @returns {Promise<void>} resolves after the rename publishes the new bytes.
 */
export async function writeState(file, settings) {
  const payload = `${JSON.stringify({ version: STATE_VERSION, settings: pick({ settings }) }, null, 2)}\n`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, payload, 'utf8');
  await fs.rename(temporary, file);
}
