import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatDuration, formatTokens, renderRuns, type Palette } from "../src/render.ts";
import { demoRuns } from "../src/preview.ts";

const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Palette;
function view(index: number, expanded = false, width = 120, rows = 40) {
  return renderRuns(demoRuns()[index], plain, { expanded, hint: "ctrl+o to expand", rows }).render(width);
}
test("Claude-compatible token and duration formatting", () => {
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(12400), "12.4k");
  assert.equal(formatTokens(1000), "1.0k");
  assert.equal(formatDuration(23400), "23s");
  assert.equal(formatDuration(119600), "2m 0s");
});
test("completed rows hide result until expanded", () => {
  assert.deepEqual(view(1), [
    "● Explore(Find authentication flow [demo]) (ctrl+o to expand)",
    "  ⎿  Done (7 tool uses · 12.4k tokens · 23s)",
  ]);
  assert.ok(view(1, true).some(s => s.includes("Prompt:")));
  assert.ok(view(1, true).some(s => s.includes("Response:")));
  assert.ok(view(1, true).some(s => s.includes("src/auth.ts")));
});
test("running view shows last three activities and hidden count", () => {
  const lines = view(0);
  assert.equal(lines.length, 5);
  assert.ok(!lines.some(s => s.includes("Search(auth)")));
  assert.ok(lines.at(-1)?.includes("+1 more tool use"));
  assert.ok(view(0, false, 120, 15)[1].includes("In progress… · 7 tool uses"));
});
test("parallel rows reproduce tree connectors", () => {
  const lines = view(2);
  assert.equal(lines[0], "● Running 2 Explore agents… (ctrl+o to expand)");
  assert.ok(lines[1].startsWith("   ├─"));
  assert.ok(lines[2].startsWith("   │"));
  assert.ok(lines[3].startsWith("   └─"));
});
test("interruption is not presented as success", () => {
  assert.equal(view(3)[1], "  ⎿  Interrupted");
});
test("narrow terminal and CJK never exceed available columns", () => {
  for (const width of [0, 1, 4, 12, 40, 80]) {
    const runs = demoRuns()[2];
    runs[0].task.description = "日本語の認証フロー 🔎";
    runs[0].task.prompt = "日本語の幅と長い文章を検証します。".repeat(10);
    for (const line of renderRuns(runs, plain, { expanded: true, hint: "" }).render(width)) {
      assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
    }
  }
});
