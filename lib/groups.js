/** @typedef {{key:string, name:string, kind:"repo"|"untracked", workspaceIds:string[]}} Group */

export const UNTRACKED_KEY = "untracked";

/**
 * Derive a display name for a repo group.
 * herdr reports repo_name for every worktree-backed workspace, but fall back to
 * the directory holding the .git entry so a malformed record still renders.
 */
function repoName(worktree) {
  if (worktree.repo_name) return worktree.repo_name;
  const parts = String(worktree.repo_key).split("/").filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : String(worktree.repo_key);
}

/**
 * @param {object[]} workspaces  result.workspaces from a workspace.list response
 * @returns {Group[]}
 */
export function groupWorkspaces(workspaces) {
  /** @type {Map<string, Group>} */
  const repos = new Map();
  /** @type {string[]} */
  const untracked = [];

  for (const ws of workspaces ?? []) {
    const key = ws.worktree?.repo_key;
    if (!key) {
      untracked.push(ws.workspace_id);
      continue;
    }
    let group = repos.get(key);
    if (!group) {
      group = { key, name: repoName(ws.worktree), kind: "repo", workspaceIds: [] };
      repos.set(key, group);
    }
    group.workspaceIds.push(ws.workspace_id);
  }

  const groups = [...repos.values()];
  if (untracked.length > 0) {
    groups.push({
      key: UNTRACKED_KEY,
      name: UNTRACKED_KEY,
      kind: "untracked",
      workspaceIds: untracked,
    });
  }
  return groups;
}
