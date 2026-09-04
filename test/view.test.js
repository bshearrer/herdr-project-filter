import { test } from "node:test";
import assert from "node:assert/strict";
import { buildViewRequest } from "../lib/view.js";

const SOURCE = "plugin:project-filter";
const groups = [
  { key: "/y/.git", name: "api-server", kind: "repo", workspaceIds: ["wE", "wAW"] },
  { key: "untracked", name: "untracked", kind: "untracked", workspaceIds: ["wAY"] },
];

test("a null scope clears the view, carrying the source", () => {
  assert.deepEqual(buildViewRequest(groups, null, SOURCE), {
    method: "agent.view.clear",
    params: { source: SOURCE },
  });
});

test("a repo scope sets a workspace_id filter sorted by sidebar order", () => {
  assert.deepEqual(buildViewRequest(groups, "/y/.git", SOURCE), {
    method: "agent.view.set",
    params: {
      source: SOURCE,
      label: "api-server",
      filter: { op: "in", field: "workspace_id", values: ["wE", "wAW"] },
      sort: [{ field: "workspace_order", order: "asc" }],
    },
  });
});

// Regression: the sort was originally attention-first, which reordered the list
// under the user's cursor. herdr's attention priority is blocked 4, done 3,
// working 2, idle 1 — and focusing an agent marks it seen, turning done into
// idle. Clicking the top row therefore dropped it below every working agent.
// `status` and `seen` encode the same seen bit and `state_change_seq` moves on
// the same transition, so none of them may appear in this sort either.
test("the sort uses no key that changes when an agent is merely looked at", () => {
  const unstable = new Set(["attention", "status", "seen", "state_change_seq"]);
  for (const scope of ["/y/.git", "untracked"]) {
    const { params } = buildViewRequest(groups, scope, SOURCE);
    for (const entry of params.sort) {
      assert.ok(
        !unstable.has(entry.field),
        `sort key "${entry.field}" reorders the list when an agent is focused`,
      );
    }
  }
});

test("the untracked scope uses the same shape", () => {
  const req = buildViewRequest(groups, "untracked", SOURCE);
  assert.equal(req.method, "agent.view.set");
  assert.equal(req.params.label, "untracked");
  assert.deepEqual(req.params.filter.values, ["wAY"]);
});

test("an unknown scope clears rather than sending an empty filter", () => {
  assert.deepEqual(buildViewRequest(groups, "/gone/.git", SOURCE), {
    method: "agent.view.clear",
    params: { source: SOURCE },
  });
});
