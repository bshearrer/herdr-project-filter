import { test } from "node:test";
import assert from "node:assert/strict";
import { nextScope, resolveScope } from "../lib/cycle.js";

const groups = [
  { key: "/y/.git", name: "api-server", kind: "repo", workspaceIds: ["wE"] },
  { key: "/c/.git", name: "web-client", kind: "repo", workspaceIds: ["w2A"] },
  { key: "untracked", name: "untracked", kind: "untracked", workspaceIds: ["wAY"] },
];

test("advances from all through every group and back to all", () => {
  assert.equal(nextScope(groups, null), "/y/.git");
  assert.equal(nextScope(groups, "/y/.git"), "/c/.git");
  assert.equal(nextScope(groups, "/c/.git"), "untracked");
  assert.equal(nextScope(groups, "untracked"), null);
});

test("treats an unrecognized stored scope as all and advances from there", () => {
  assert.equal(nextScope(groups, "/gone/.git"), "/y/.git");
});

test("stays at all when there are no groups", () => {
  assert.equal(nextScope([], null), null);
  assert.equal(nextScope([], "/gone/.git"), null);
});

test("resolveScope keeps a live scope", () => {
  assert.equal(resolveScope(groups, "/c/.git"), "/c/.git");
});

test("resolveScope drops a stale scope without advancing", () => {
  assert.equal(resolveScope(groups, "/gone/.git"), null);
  assert.equal(resolveScope([], "untracked"), null);
});

test("resolveScope passes null through", () => {
  assert.equal(resolveScope(groups, null), null);
});
