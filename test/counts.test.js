import { test } from "node:test";
import assert from "node:assert/strict";
import { countByGroup } from "../lib/counts.js";

const groups = [
  { key: "/y/.git", name: "api-server", kind: "repo", workspaceIds: ["wE", "wAW"] },
  { key: "untracked", name: "untracked", kind: "untracked", workspaceIds: ["wAY"] },
];

test("counts agents per group and flags those needing attention", () => {
  const counts = countByGroup(groups, [
    { workspace_id: "wE", agent_status: "working" },
    { workspace_id: "wAW", agent_status: "blocked" },
    { workspace_id: "wAW", agent_status: "done" },
    { workspace_id: "wAY", agent_status: "idle" },
  ]);
  assert.deepEqual(counts.get("/y/.git"), { total: 3, attention: 2 });
  assert.deepEqual(counts.get("untracked"), { total: 1, attention: 0 });
});

test("reports zeroes for a group with no agents", () => {
  assert.deepEqual(countByGroup(groups, []).get("/y/.git"), { total: 0, attention: 0 });
});

test("ignores agents in workspaces that belong to no group", () => {
  const counts = countByGroup(groups, [{ workspace_id: "wZZ", agent_status: "blocked" }]);
  assert.deepEqual(counts.get("/y/.git"), { total: 0, attention: 0 });
});
