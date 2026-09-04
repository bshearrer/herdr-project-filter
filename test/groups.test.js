import { test } from "node:test";
import assert from "node:assert/strict";
import { groupWorkspaces } from "../lib/groups.js";

const repo = (id, label, key, name) => ({
  workspace_id: id,
  label,
  worktree: { repo_key: key, repo_name: name, is_linked_worktree: false },
});
const plain = (id, label) => ({ workspace_id: id, label });

test("groups a main checkout with its linked worktrees", () => {
  const groups = groupWorkspaces([
    repo("wE", "api-server", "/y/.git", "api-server"),
    repo("wAW", "api-207", "/y/.git", "api-server"),
    repo("wAX", "api-195", "/y/.git", "api-server"),
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0], {
    key: "/y/.git",
    name: "api-server",
    kind: "repo",
    workspaceIds: ["wE", "wAW", "wAX"],
  });
});

test("keeps separate repos separate, in first-appearance order", () => {
  const groups = groupWorkspaces([
    repo("wE", "api-server", "/y/.git", "api-server"),
    repo("w2A", "Code", "/c/.git", "web-client"),
    repo("wAW", "api-207", "/y/.git", "api-server"),
  ]);
  assert.deepEqual(groups.map((g) => g.name), ["api-server", "web-client"]);
  assert.deepEqual(groups[0].workspaceIds, ["wE", "wAW"]);
  assert.deepEqual(groups[1].workspaceIds, ["w2A"]);
});

test("collects workspaces with no worktree into a trailing untracked group", () => {
  const groups = groupWorkspaces([
    plain("w27", "Finance"),
    repo("wE", "api-server", "/y/.git", "api-server"),
    plain("wAY", "Dev"),
  ]);
  assert.deepEqual(groups.map((g) => g.key), ["/y/.git", "untracked"]);
  assert.equal(groups[1].kind, "untracked");
  assert.equal(groups[1].name, "untracked");
  assert.deepEqual(groups[1].workspaceIds, ["w27", "wAY"]);
});

test("omits the untracked group when every workspace has a repo", () => {
  const groups = groupWorkspaces([repo("wE", "api-server", "/y/.git", "api-server")]);
  assert.deepEqual(groups.map((g) => g.key), ["/y/.git"]);
});

test("returns an empty array for an empty session", () => {
  assert.deepEqual(groupWorkspaces([]), []);
});

test("falls back to the repo key basename when repo_name is missing", () => {
  const groups = groupWorkspaces([
    { workspace_id: "w1", label: "x", worktree: { repo_key: "/srv/thing/.git" } },
  ]);
  assert.equal(groups[0].name, "thing");
});
