/** @typedef {import("./groups.js").Group} Group */
/** @typedef {string|null} Scope */

/** The cycle sequence: unfiltered first, then each group in order. */
function sequence(groups) {
  return [null, ...groups.map((g) => g.key)];
}

/**
 * Advance one step. An unrecognized current scope is treated as `all`, so a
 * stale state file never strands the cycle.
 * @param {Group[]} groups
 * @param {Scope} current
 * @returns {Scope}
 */
export function nextScope(groups, current) {
  const seq = sequence(groups);
  const found = seq.indexOf(current);
  const index = found === -1 ? 0 : found;
  return seq[(index + 1) % seq.length];
}

/**
 * Keep a scope only if it still names a live group. Never advances.
 * @param {Group[]} groups
 * @param {Scope} stored
 * @returns {Scope}
 */
export function resolveScope(groups, stored) {
  if (stored === null || stored === undefined) return null;
  return groups.some((g) => g.key === stored) ? stored : null;
}
