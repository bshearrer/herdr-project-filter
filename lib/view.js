/** @typedef {import("./groups.js").Group} Group */
/** @typedef {string|null} Scope */

/**
 * Sidebar order, matching the Spaces panel above. Applied only inside a scope —
 * the unfiltered view keeps whatever ordering the user configured.
 *
 * Deliberately NOT sorted by attention. herdr's attention priority folds in
 * whether an agent has been *seen* (blocked 4, done 3, working 2, idle 1), and
 * focusing an agent marks it seen — so an attention-sorted list reorders itself
 * the instant you click it, dropping the row you just aimed at below every
 * working agent. `status` and `seen` fold in the same bit, and
 * `state_change_seq` moves on the same transition, so every attention-bearing
 * sort key is unstable under the act of looking.
 *
 * Inside a scope the whole group is visible at once and each row already
 * carries its state icon, so ordering buys little and positional stability
 * buys a lot.
 */
export const VIEW_SORT = [{ field: "workspace_order", order: "asc" }];

/**
 * @param {Group[]} groups
 * @param {Scope} scope
 * @param {string} source
 * @returns {{method: string, params: object}}
 */
export function buildViewRequest(groups, scope, source) {
  const group = scope === null ? undefined : groups.find((g) => g.key === scope);
  if (!group) {
    // Both "all" and a scope whose group has disappeared resolve to unfiltered.
    return { method: "agent.view.clear", params: { source } };
  }
  return {
    method: "agent.view.set",
    params: {
      source,
      label: group.name,
      filter: { op: "in", field: "workspace_id", values: group.workspaceIds },
      sort: VIEW_SORT,
    },
  };
}
