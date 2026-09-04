import fs from "node:fs";
import path from "node:path";

/** @typedef {string|null} Scope */

const FILE = "state.json";

/** @returns {string} */
export function stateDir() {
  const dir = process.env.HERDR_PLUGIN_STATE_DIR;
  if (!dir) throw new Error("HERDR_PLUGIN_STATE_DIR is not set");
  return dir;
}

/**
 * Any unreadable or unexpected state is reported as unfiltered. The resting
 * state is the safe default, so there is nothing to gain from failing loudly.
 * @param {string} dir
 * @returns {Scope}
 */
export function readScope(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, FILE), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.scope === "string" ? parsed.scope : null;
  } catch {
    return null;
  }
}

/**
 * Write via a private temp file and rename, so a concurrent reader sees either
 * the whole old file or the whole new one and never an empty or half-written
 * one. This is load-bearing rather than defensive: herdr emits both
 * `workspace.created` and `worktree.opened` for a single worktree-open action
 * and both are hooked, so every worktree open races two `refresh` processes
 * here — and a torn read reports `null`, which the loser then persists,
 * silently dropping the operator's scope.
 *
 * @param {string} dir
 * @param {Scope} scope
 */
export function writeScope(dir, scope) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${FILE}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify({ scope }) + "\n", "utf8");
    fs.renameSync(tmp, path.join(dir, FILE));
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
