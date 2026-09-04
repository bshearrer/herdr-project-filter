import { test } from "node:test";
import assert from "node:assert/strict";
import {
  truncate,
  nameColumnWidth,
  formatCount,
  renderLine,
  viewportSize,
  scrollOffset,
} from "../lib/layout.js";

const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

test("truncate leaves short-enough text untouched", () => {
  assert.equal(truncate("abcdefghij", 10), "abcdefghij"); // exactly the budget
  assert.equal(truncate("abcd", 10), "abcd"); // room to spare
});

test("truncate replaces the last column with an ellipsis rather than wrapping", () => {
  assert.equal(truncate("abcdefghij", 8), "abcdefg…");
  assert.equal(truncate("abcdefghij", 8).length, 8);
});

test("truncate degrades gracefully at the very narrow end", () => {
  assert.equal(truncate("abcdefghij", 1), "a");
  assert.equal(truncate("abcdefghij", 0), "");
  assert.equal(truncate("abcdefghij", -3), "");
});

test("nameColumnWidth sizes to the longest name present, not a fixed guess", () => {
  assert.equal(nameColumnWidth(["all", "api", "web-client"]), 10);
});

test("nameColumnWidth floors short screens so the column doesn't collapse", () => {
  assert.equal(nameColumnWidth(["all"], { min: 6, max: 20 }), 6);
});

test("nameColumnWidth ceilings long names so one repo can't push the count column out of alignment", () => {
  const longName = "a-repository-with-a-very-long-name-indeed"; // 42 chars
  assert.equal(nameColumnWidth(["all", longName], { min: 6, max: 20 }), 20);
});

test("formatCount pads singular and plural to the same width", () => {
  assert.equal(formatCount(1, 10), "  1 agent ");
  assert.equal(formatCount(12, 10), " 12 agents");
  assert.equal(formatCount(1, 10).length, 10);
  assert.equal(formatCount(12, 10).length, 10);
});

test("renderLine never exceeds the requested column budget", () => {
  const segments = [
    { text: "› ", color: "\x1b[36m" },
    { text: "web-client".padEnd(20) },
    { text: "  6 agents", color: "\x1b[2m" },
    { text: " ● 3 waiting", color: "\x1b[33m" },
  ];
  for (const columns of [0, 1, 5, 12, 24, 40, 80]) {
    const line = renderLine(segments, columns);
    assert.ok(
      strip(line).length <= columns,
      `renderLine(..., ${columns}) produced ${strip(line).length} visible columns: ${JSON.stringify(strip(line))}`,
    );
  }
});

test("renderLine truncates the segment straddling the boundary and drops what follows", () => {
  const segments = [{ text: "abcdefghij" }, { text: " extra tail text" }];
  const line = renderLine(segments, 8);
  assert.equal(strip(line), "abcdefg…");
});

test("renderLine preserves color codes around the surviving text", () => {
  const line = renderLine([{ text: "api-server", color: "\x1b[1m" }], 10);
  assert.equal(line, "\x1b[1mapi-server\x1b[0m");
});

test("renderLine drops a segment entirely once nothing fits", () => {
  const line = renderLine([{ text: "ab", color: "\x1b[1m" }, { text: "cd" }], 2);
  assert.equal(strip(line), "ab");
  assert.equal(line, "\x1b[1mab\x1b[0m");
});

test("viewportSize fits as many rows as the count and chrome allow", () => {
  assert.equal(viewportSize(3, 8, 3), 3, "fewer rows than fit shows them all");
  assert.equal(viewportSize(12, 8, 3), 5, "more rows than fit clamps to the available space");
});

test("viewportSize never returns fewer than one row even under a tiny pane", () => {
  assert.equal(viewportSize(12, 3, 3), 1);
});

test("scrollOffset does not move until the selection walks off an edge", () => {
  assert.equal(scrollOffset(0, 2, 12, 5), 0);
  assert.equal(scrollOffset(0, 5, 12, 5), 1, "selection past the bottom edge scrolls by exactly one");
  assert.equal(scrollOffset(3, 1, 12, 5), 1, "selection above the top edge scrolls up to meet it");
});
