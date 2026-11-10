import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AgentNavigation, agentDetailLines, safeText } from "../src/navigation.ts";
import { AgentStatus } from "../src/status.ts";
import { createRun, type Run } from "../src/state.ts";

// Sonnet's isolated test scenarios, adapted to the focus-safe editor wrapper after Opus review.
const K = { up: "\x1b[A", down: "\x1b[B", enter: "\r", esc: "\x1b", pgup: "\x1b[5~", pgdown: "\x1b[6~" };
type Component = { render(width: number): string[]; handleInput?(key: string): void; dispose?(): void };
function child(name = "task"): Run {
  return Object.assign(createRun({ description: name, prompt: `Prompt: ${name}`, subagent_type: "Explore" }), { status: "running" as const });
}
function setup(runs = [child()], mode: ExtensionContext["mode"] = "tui") {
  const state = { editor: "", passed: [] as string[], writes: [] as (string | undefined)[], renders: 0, done: 0, attaches: 0, component: undefined as Component | undefined };
  const editor = { getText: () => state.editor, handleInput: (key: string) => {
    state.passed.push(key); if (key.length === 1 && key >= " ") state.editor += key;
  } };
  const original = editor.handleInput;
  const theme = { style: (text: string) => text, bold: (text: string) => text, fg: (_color: string, text: string) => text };
  const tui = { terminal: { rows: 24 }, requestRender: () => { state.renders++; } };
  const keybindings = { matches: (key: string, id: string) => key === K.esc && id === "tui.select.cancel" };
  const ctx = {
    mode, sessionManager: { getBranch: () => [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Main conversation" }] } }, { type: "message", message: { role: "bashExecution" } }] },
    ui: { theme, notify() {},
      getEditorComponent: () => () => editor,
      setEditorComponent: (factory: (a: unknown, b: unknown, c: unknown) => unknown) => { state.attaches++; factory(tui, theme, keybindings); },
      setStatus: (_key: string, text: string | undefined) => { state.writes.push(text); },
      custom: (factory: (a: unknown, b: unknown, c: unknown, done: () => void) => Component) => new Promise<void>(resolve => {
        state.component = factory(tui, theme, keybindings, () => {
          state.done++; state.component?.dispose?.(); state.component = undefined; resolve();
        });
      }),
    },
  } as unknown as ExtensionContext;
  const status = new AgentStatus(); status.track("call", runs); status.publish(ctx);
  const nav = new AgentNavigation(status);
  const send = (key: string) => editor.handleInput(key);
  const press = (key: string) => state.component!.handleInput!(key);
  const text = () => state.component!.render(100).join("\n");
  return { ctx, status, nav, state, send, press, text, original, editor };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test("detail contains prompt, current activity, bounded history, live response and error", () => {
  const run = child(); run.currentActivity = "Read(auth.ts)"; run.liveText = "partial"; run.output = "answer"; run.error = "failed";
  run.activities = Array.from({ length: 40 }, (_, i) => ({ kind: "tool" as const, text: `step-${i}` }));
  const lines = agentDetailLines(run);
  assert.ok(lines.includes("Now: Read(auth.ts)")); assert.ok(lines.includes("Prompt: task"));
  assert.ok(lines.includes("partial") && lines.includes("answer") && lines.includes("Error: failed"));
  assert.ok(!lines.includes("step-9") && lines.includes("step-10"));
});
test("unsafe terminal controls cannot enter detail output", () => {
  assert.equal(safeText("ok\x1b]52;c;payload\x07\x1b[2J\rtext\t!"), "oktext  !");
  assert.equal(safeText("日本語\nnext"), "日本語\nnext");
});
test("navigation wraps only the editor, never globally intercepting dialog keys", () => {
  for (const mode of ["rpc", "json", "print"] as const) {
    const h = setup(undefined, mode); h.nav.attach(h.ctx); assert.equal(h.state.attaches, 0);
  }
  const h = setup(); h.nav.attach(h.ctx); assert.equal(h.state.attaches, 1); h.nav.shutdown();
});
test("unselected up keeps normal history; down enters agent selection and arrows cycle", () => {
  const a = child("a"), b = child("b"); const h = setup([a, b]); h.nav.attach(h.ctx);
  h.send(K.up); assert.deepEqual(h.state.passed, [K.up]); assert.equal(h.status.selecting, false);
  h.send(K.down); assert.equal(h.status.selectedRun, a);
  h.send(K.down); assert.equal(h.status.selectedRun, b);
  h.send(K.down); assert.equal(h.status.selectedRun, null);
  h.send(K.up); assert.equal(h.status.selectedRun, b);
  h.nav.shutdown();
});
test("nonempty prompts preserve arrows and submission; text input deselects", () => {
  const h = setup(); h.nav.attach(h.ctx); h.state.editor = "draft";
  for (const key of [K.up, K.down, K.enter, K.esc]) h.send(key);
  assert.deepEqual(h.state.passed, [K.up, K.down, K.enter, K.esc]);
  h.state.editor = ""; h.send(K.down); h.send("x");
  assert.equal(h.state.editor, "x"); assert.equal(h.status.selecting, false);
  h.nav.shutdown();
});
test("empty Enter passes through until selection; Escape clears selection only", () => {
  const h = setup(); h.nav.attach(h.ctx); h.send(K.enter); assert.equal(h.state.component, undefined);
  h.send(K.down); h.send(K.esc); assert.equal(h.status.selecting, false);
  assert.deepEqual(h.state.passed, [K.enter]); h.nav.shutdown();
});
test("switching back to main closes the preview without aborting the child", async () => {
  const a = child("auth"); a.currentActivity = "Read(auth.ts)";
  const h = setup([a]); h.nav.attach(h.ctx); h.send(K.down); h.send(K.enter);
  assert.match(h.text(), /Explore — live activity/); assert.match(h.text(), /Now: Read\(auth.ts\)/);
  h.press(K.up); await flush();
  assert.equal(h.state.component, undefined); assert.equal(a.status, "running");
  assert.equal(h.status.selecting, false); assert.equal(h.status.selectedRun, null);
  h.nav.shutdown();
});
test("Enter on main never opens a preview", async () => {
  const h = setup(); h.nav.attach(h.ctx); h.send(K.down); h.send(K.up);
  assert.equal(h.status.selectedRun, null);
  h.send(K.enter); await flush();
  assert.equal(h.state.component, undefined); assert.equal(h.status.selecting, false);
  h.nav.shutdown();
});
test("live activity changes and final child output update the open panel", async () => {
  const a = child(); const h = setup([a]); h.nav.attach(h.ctx); h.send(K.down); h.send(K.enter);
  a.currentActivity = "Bash(npm test)"; a.liveText = "streaming now";
  assert.match(h.text(), /Bash\(npm test\)/); assert.match(h.text(), /streaming now/);
  a.status = "completed"; a.output = "final answer";
  assert.match(h.text(), /Status: completed/); assert.match(h.text(), /final answer/);
  h.press(K.esc); await flush(); h.nav.shutdown();
});
test("scrolling and CJK narrow widths are bounded", async () => {
  const a = child("日本語の調査"); a.task.prompt = "日本語の長いプロンプト\n".repeat(50);
  const h = setup([a]); h.nav.attach(h.ctx); h.send(K.down); h.send(K.enter);
  for (const width of [1, 2, 4, 20, 80, 120]) {
    for (const line of h.state.component!.render(width)) assert.ok(visibleWidth(line) <= width);
  }
  h.press(K.pgdown); assert.match(h.text(), /日本語/);
  h.press(K.pgup); assert.match(h.text(), /Task:/);
  h.press(K.esc); await flush(); h.nav.shutdown();
});
test("timer and editor wrapper are disposed on shutdown; closing is idempotent", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = setup(); h.nav.attach(h.ctx); h.send(K.down); h.send(K.enter);
  t.mock.timers.tick(999); assert.equal(h.state.renders, 0);
  t.mock.timers.tick(1); assert.ok(h.state.renders > 0);
  h.nav.shutdown(); h.nav.shutdown(); await flush();
  const count = h.state.renders; t.mock.timers.tick(1000); assert.equal(h.state.renders, count);
  assert.equal(h.state.done, 1); assert.equal(h.state.component, undefined);
  h.send(K.down); assert.equal(h.state.passed.at(-1), K.down);
});
test("no live agents means editor navigation passes through", () => {
  const h = setup([]); h.nav.attach(h.ctx); h.send(K.down); assert.equal(h.status.selecting, false);
  assert.deepEqual(h.state.passed, [K.down]); h.nav.shutdown();
});
