/** @typedef {import("./groups.js").Group} Group */

/**
 * Statuses that mean "this agent is waiting on you". Exported so the picker's
 * "all" row can count attention across every agent rather than hardcoding zero.
 */
export const ATTENTION = new Set(["blocked", "done"]);

/**
 * @param {Group[]} groups
 * @param {object[]} agents  result.agents from an agent.list response
 * @returns {Map<string, {total:number, attention:number}>}
 */
export function countByGroup(groups, agents) {
  const byWorkspace = new Map();
  for (const group of groups) {
    for (const id of group.workspaceIds) byWorkspace.set(id, group.key);
  }
  const counts = new Map(groups.map((g) => [g.key, { total: 0, attention: 0 }]));
  for (const agent of agents ?? []) {
    const key = byWorkspace.get(agent.workspace_id);
    if (!key) continue;
    const entry = counts.get(key);
    entry.total += 1;
    if (ATTENTION.has(agent.agent_status)) entry.attention += 1;
  }
  return counts;
}
