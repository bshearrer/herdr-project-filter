import { test } from "node:test";
import assert from "node:assert/strict";
import { readPaneConfig } from "../lib/manifest.js";

const TOML = `
id = "bshearrer.project-filter"

[[actions]]
id = "cycle"

[[panes]]
id = "picker"
title = "Project filter"
placement = "popup"
width = 46
height = 10
command = ["node", "picker.js"]

[[panes]]
id = "other"
width = "50%"
height = 20
command = ["node", "other.js"]
`;

test("reads the width and height of the named pane", () => {
  assert.deepEqual(readPaneConfig(TOML, "picker"), { width: 46, height: 10 });
});

test("reads a percentage width as a string, not a number", () => {
  assert.deepEqual(readPaneConfig(TOML, "other"), { width: "50%", height: 20 });
});

test("returns null for a pane id that isn't declared", () => {
  assert.equal(readPaneConfig(TOML, "nonexistent"), null);
});

test("does not confuse one pane's fields with another's", () => {
  const config = readPaneConfig(TOML, "picker");
  assert.notEqual(config.width, "50%");
});
