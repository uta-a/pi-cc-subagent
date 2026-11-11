import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentStatus, STATUS_KEY, renderAgentStatus, type StatusPalette } from "../src/status.ts";
import { createRun, type Run } from "../src/state.ts";

// Integrated from the Sonnet test lane; adapted after Opus's lifecycle review.
const WHITE = { kind: "rgb", r: 255, g: 255, b: 255 };
const GRAY = { kind: "rgb", r: 153, g: 153, b: 153 };
const tagged: StatusPalette = { style(text, options) {
  const color = JSON.stringify(options.fg) === JSON.stringify(WHITE) ? "w" : "g";
  return `<${color}${options.bold ? ":b" : ""}>${text}</>`;
} };
const plain: StatusPalette = { style: text => text };
function run(type: "Explore" | "Plan" | "general-purpose" = "general-purpose", state: Run["status"] = "running", extra: Partial<Run> = {}) {
  return Object.assign(createRun({ description: "task", prompt: "task", subagent_type: type }), { status: state }, extra);
}
function harness(mode: ExtensionContext["mode"] = "tui") {
  const writes: [string, string | undefined][] = [];
  let theme = plain;
  const ctx = { mode, ui: { get theme() { return theme; }, setStatus: (key: string, text: string | undefined) => writes.push([key, text]) } } as unknown as ExtensionContext;
  return { ctx, writes, changeTheme: (next: StatusPalette) => { theme = next; } };
}
const titles = (text: string | undefined) => text?.split("\n").map(row => row.split("\t")[0]);

test("screenshot rows: white bold main, gray hollow children and right-hand stats", () => {
  const child = run("Explore", "running", { startedAt: 4000, tokens: 26400, activities: [{ kind: "tool", text: "Read(a)" }] });
  assert.equal(renderAgentStatus([child], tagged, undefined, 10000), "<w:b>● main</>\n<g>○ Explore  task</>\t<g>6s · ↓ 26.4k tokens</>");
  assert.deepEqual(titles(renderAgentStatus([run("Explore"), run(), run("Plan")], plain)), ["● main", "○ Explore  task", "○ general-purpose  task", "○ Plan  task"]);
});
test("selected child is white and main becomes gray", () => {
  const child = run("Plan");
  assert.equal(renderAgentStatus([child], tagged, undefined, 0, child), "<g>○ main</>\n<w:b>● Plan  task</>\t<w:b>0s · ↑ 0 tokens</>");
});
test("duration handles clock skew, unset start time and compact token counts", () => {
  const cases: [number, number, number, string][] = [
    [1000, 1400, 999, "0s · ↑ 999 tokens"], [1000, 7000, 1000, "6s · ↑ 1.0k tokens"],
    [1000, 66000, 12345, "1m 5s · ↑ 12.3k tokens"], [0, 99000, 5, "0s · ↑ 5 tokens"], [50000, 10000, 0, "0s · ↑ 0 tokens"],
  ];
  for (const [startedAt, now, tokens, expected] of cases) {
    const text = renderAgentStatus([run("Explore", "running", { startedAt, tokens })], plain, undefined, now)!;
    assert.equal(text.split("\t")[1], expected);
  }
});
test("description control characters cannot create rows or extra columns", () => {
  const child = run("Explore"); child.task.description = "a\nb\tc\x07d 日本語";
  const text = renderAgentStatus([child], plain)!;
  assert.equal(text.split("\n").length, 2);
  assert.equal(text.split("\t").length, 2);
  assert.ok(text.includes("a b c d 日本語"));
});
test("terminal and queued runs are hidden and overflow stays bounded", () => {
  for (const state of ["pending", "completed", "failed", "aborted"] as const) assert.equal(renderAgentStatus([run("Explore", state)], plain), undefined);
  const text = renderAgentStatus(Array.from({ length: 20 }, () => run()), plain)!;
  assert.equal(text.split("\n").length, 10);
  assert.ok(text.endsWith("+12 more"));
});
test("running and name expose tracked references and stable names", () => {
  const status = new AgentStatus(); const a = run("Explore"), b = run("Explore"), p = run("Plan", "pending");
  status.track("call", [a, b, p]);
  assert.deepEqual(status.running(), [a, b]);
  assert.deepEqual([a, b, p].map(child => status.name(child)), ["Explore", "Explore-2", "Plan"]);
  const capped = new AgentStatus(); capped.track("many", Array.from({ length: 12 }, () => run()));
  assert.equal(capped.running().length, 8);
});
test("arrows follow chat → main → children and clamp at both ends", () => {
  const { ctx } = harness(); const status = new AgentStatus(); const a = run("Explore"), b = run("Plan");
  status.track("call", [a, b]);
  status.move(-1, ctx); assert.equal(status.selecting, false); // chat is the top boundary
  status.move(1, ctx); assert.equal(status.selectedRun, null); assert.ok(status.selecting); // main
  status.move(1, ctx); assert.equal(status.selectedRun, a);
  status.move(1, ctx); assert.equal(status.selectedRun, b);
  status.move(1, ctx); status.move(1, ctx); assert.equal(status.selectedRun, b); // no bottom wrap
  status.move(-1, ctx); assert.equal(status.selectedRun, a);
  status.move(-1, ctx); assert.equal(status.selectedRun, null); assert.ok(status.selecting); // main
  status.move(-1, ctx); assert.equal(status.selecting, false); // chat
  status.move(-1, ctx); assert.equal(status.selecting, false); assert.equal(status.selectedRun, null);
});
test("selection is attached to the Run object when preceding children finish", () => {
  const { ctx, writes } = harness(); const status = new AgentStatus(); const a = run("Explore"), b = run("Explore"), c = run("Plan");
  status.track("call", [a, b, c]); status.move(1, ctx); status.move(1, ctx); status.move(1, ctx);
  a.status = "completed"; status.publish(ctx);
  assert.equal(status.selectedRun, b);
  assert.deepEqual(titles(writes.at(-1)?.[1]), ["○ main", "● Explore-2  task", "○ Plan  task"]);
  status.move(1, ctx); assert.equal(status.selectedRun, c);
});
test("finished or released selection returns to main; all finished resets selection mode", () => {
  const { ctx, writes } = harness(); const status = new AgentStatus(); const a = run("Explore");
  status.track("call", [a]); status.move(1, ctx); status.move(1, ctx); status.release("call", ctx);
  assert.equal(status.selectedRun, null); assert.equal(status.selecting, false);
  assert.deepEqual(writes.at(-1), [STATUS_KEY, undefined]);
});
test("duplicate tool IDs stay independent and remaining names never renumber", () => {
  const { ctx, writes } = harness(); const status = new AgentStatus(); const a = run("Explore"), b = run("Explore");
  const keyA = Symbol("same"), keyB = Symbol("same");
  status.track(keyA, [a]); status.track(keyB, [b]); status.publish(ctx);
  status.release(keyA, ctx);
  assert.deepEqual(titles(writes.at(-1)?.[1]), ["○ main", "○ Explore-2  task"]);
  status.release(keyB, ctx); assert.equal(writes.at(-1)?.[1], undefined);
  status.track(Symbol(), [run("Explore")]); status.publish(ctx);
  assert.deepEqual(titles(writes.at(-1)?.[1]), ["○ main", "○ Explore  task"]);
});
test("custom names replace role labels, number duplicates and fall back when blank", () => {
  const { ctx, writes } = harness(); const status = new AgentStatus();
  const r1 = run("Explore", "running", {}), r2 = run("general-purpose"), r3 = run("Plan"), blank = run("Explore");
  r1.task.name = "researcher"; r2.task.name = "researcher"; r3.task.name = "reviewer"; blank.task.name = "  \n ";
  status.track("call", [r1, r2, r3, blank]); status.publish(ctx);
  assert.deepEqual(titles(writes.at(-1)?.[1]), ["○ main", "○ researcher  task", "○ researcher-2  task", "○ reviewer  task", "○ Explore  task"]);
  assert.equal(status.name(r2), "researcher-2");
  r1.status = "completed"; status.publish(ctx);
  assert.equal(titles(writes.at(-1)?.[1])?.[1], "○ researcher-2  task"); // no renumbering
});
test("custom names are single-line and bounded", () => {
  const child = run("Explore"); child.task.name = "a\nb\tc\x1b[31m" + "長".repeat(40);
  const first = renderAgentStatus([child], plain)!.split("\n")[1].split("\t")[0];
  assert.ok(!/[\x00-\x1f]/.test(first));
  const name = first.slice(2, first.indexOf("  task"));
  assert.equal([...name].length, 24);
  assert.ok(name.startsWith("a b c [31m"));
});
test("identical states are cached and theme changes refresh styles", () => {
  const { ctx, writes, changeTheme } = harness(); const status = new AgentStatus(); const child = run("Explore", "pending");
  status.track("call", [child]); status.publish(ctx); assert.equal(writes.length, 0);
  child.status = "running"; status.publish(ctx); status.publish(ctx); assert.equal(writes.length, 1);
  changeTheme(tagged); status.publish(ctx); assert.ok(writes.at(-1)?.[1]?.startsWith("<g>○ main"));
});
test("shutdown clears only our key and ignores late callbacks", () => {
  const { ctx, writes } = harness(); const status = new AgentStatus(); status.track("old", [run()]); status.publish(ctx); status.shutdown(ctx);
  const count = writes.length; status.publish(ctx); status.release("old", ctx); status.track("stale", [run()]); status.move(1, ctx);
  assert.equal(writes.length, count); assert.deepEqual(writes.at(-1), [STATUS_KEY, undefined]);
  assert.ok(writes.every(([key]) => key === STATUS_KEY));
});
test("non-TUI modes do not update terminal status", () => {
  for (const mode of ["rpc", "print", "json"] as const) {
    const { ctx, writes } = harness(mode); const status = new AgentStatus(); status.track("call", [run()]); status.publish(ctx); status.shutdown(ctx);
    assert.equal(writes.length, 0);
  }
});
