import { test } from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import { emptyUsage, type Details, type Task } from "../src/state.ts";
import { STATUS_KEY } from "../src/status.ts";

function response(): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text: "Done" }], api: "anthropic-messages", provider: "test", model: "test", usage: emptyUsage(), stopReason: "stop", timestamp: Date.now() };
}
type Execute = (id: string, params: Task, signal: AbortSignal | undefined, update: (() => void) | undefined, ctx: ExtensionToolContext) => Promise<{ details: Details; isError?: boolean }>;
function harness() {
  const events = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
  let tool: { execute: Execute };
  const pi = {
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => void) { events.set(name, handler); },
    registerTool(definition: unknown) { tool = definition as typeof tool; },
    registerCommand(name: string, definition: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) { commands.set(name, definition.handler); },
    registerEntryRenderer() {},
    registerMessageRenderer() {},
  } as unknown as ExtensionAPI;
  const writes: (string | undefined)[] = [], notices: string[] = [];
  const pending: { resolve: (message: AssistantMessage) => void; signal: AbortSignal }[] = [];
  let idle = true;
  const ctx = {
    mode: "tui", model: { provider: "test", id: "test" }, thinkingLevel: "off", cwd: "/tmp", tools: [],
    isIdle: () => idle, getSystemPrompt: () => "test",
    ui: { theme: { style: (text: string) => text },
      getEditorComponent: () => () => ({ getText: () => "", handleInput() {} }),
      setEditorComponent() {},
      setStatus(key: string, text: string | undefined) { assert.equal(key, STATUS_KEY); writes.push(text); },
      notify(text: string) { notices.push(text); } },
    modelRegistry: { streamSimple(_model: unknown, _context: unknown, options: { signal: AbortSignal }) {
      let resolve!: (value: AssistantMessage) => void;
      const message = new Promise<AssistantMessage>(r => { resolve = r; });
      pending.push({ resolve, signal: options.signal });
      return { async *[Symbol.asyncIterator]() {}, result: () => message };
    } },
  } as unknown as ExtensionToolContext & ExtensionCommandContext;
  extension(pi);
  // These tests cover the foreground path; background defaults are covered in background.test.ts.
  const execute = (id: string, params: Task, ...rest: [AbortSignal | undefined, (() => void) | undefined, ExtensionToolContext]) =>
    tool.execute(id, { run_in_background: false, ...params } as Task, ...rest);
  return { events, commands, ctx, writes, notices, pending, execute, busy: () => { idle = false; } };
}
const task: Task = { description: "Find code", prompt: "Find code", subagent_type: "Explore" };
const flush = () => new Promise<void>(r => setImmediate(r));

test("extension wiring keeps concurrent executions with duplicate provider ids independent", async () => {
  const h = harness();
  const a = h.execute("same-id", task, undefined, undefined, h.ctx);
  const b = h.execute("same-id", task, undefined, undefined, h.ctx);
  assert.deepEqual(h.writes.at(-1)?.split("\n").map(row => row.split("\t")[0]), ["○ main", "○ Explore  Find code", "○ Explore-2  Find code"]);
  h.pending[0].resolve(response()); await a;
  assert.match(h.writes.at(-1)!, /^○ main\n○ Explore-2  Find code\t/);
  h.pending[1].resolve(response()); await b;
  assert.equal(h.writes.at(-1), undefined);
});
test("name parameter reaches the footer for single and parallel calls", async () => {
  const h = harness();
  const single = h.execute("one", { ...task, name: "researcher" }, undefined, undefined, h.ctx);
  const parallel = h.execute("two", { tasks: [{ ...task, name: "reviewer" }, task] } as unknown as Task, undefined, undefined, h.ctx);
  assert.deepEqual(h.writes.at(-1)?.split("\n").map(row => row.split("\t")[0]), ["○ main", "○ researcher  Find code", "○ reviewer  Find code", "○ Explore  Find code"]);
  for (const pending of h.pending) pending.resolve(response());
  await Promise.all([single, parallel]);
  assert.equal(h.writes.at(-1), undefined);
});
test("model failure and abort clear live badges through execute finally", async () => {
  for (const abort of [false, true]) {
    const h = harness(); const controller = new AbortController();
    const execution = h.execute("id", task, controller.signal, undefined, h.ctx);
    if (abort) controller.abort();
    h.pending[0].resolve({ ...response(), stopReason: "error", errorMessage: "Failed" });
    const result = await execution;
    assert.equal(result.details.runs[0].status, abort ? "aborted" : "failed");
    assert.equal(result.isError, true);
    assert.equal(h.writes.at(-1), undefined);
  }
});
test("shutdown aborts children and prevents late status or result callbacks", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = harness(); let updates = 0;
  const execution = h.execute("id", task, undefined, () => { updates++; }, h.ctx);
  h.events.get("session_shutdown")!({}, h.ctx);
  assert.ok(h.pending[0].signal.aborted);
  const before = updates, writes = h.writes.length;
  t.mock.timers.tick(5000); await flush();
  assert.equal(updates, before);
  h.pending[0].resolve(response()); await execution;
  assert.equal(updates, before);
  assert.equal(h.writes.length, writes);
  assert.equal(h.writes.at(-1), undefined);
});
test("footer ticks do not emit duplicate full tool snapshots", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = harness(); let updates = 0;
  const execution = h.execute("id", task, undefined, () => { updates++; }, h.ctx);
  const start = updates;
  t.mock.timers.tick(5000);
  assert.equal(updates, start);
  h.pending[0].resolve(response()); await execution;
  assert.ok(updates > start); // final state is still flushed immediately
});
test("demo expires, supports off, rejects busy mode and is cleared before real work", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = harness(); const demo = h.commands.get("cc-subagent-status-demo")!;
  await demo("", h.ctx); assert.match(h.writes.at(-1)!, /^○ main\n○ Explore  ホームの git リポジトリ概要調査\t6s · ↓ 26\.4k tokens$/);
  t.mock.timers.tick(10_000); assert.equal(h.writes.at(-1), undefined);
  await demo("", h.ctx); await demo("off", h.ctx); assert.equal(h.writes.at(-1), undefined);
  await demo("", h.ctx);
  const count = h.writes.length; await demo("invalid", h.ctx); assert.equal(h.writes.length, count);
  h.events.get("before_agent_start")!({}, h.ctx); assert.equal(h.writes.at(-1), undefined);
  await demo("", h.ctx);
  const execution = h.execute("id", task, undefined, undefined, h.ctx);
  assert.match(h.writes.at(-1)!, /^○ main\n○ Explore  Find code\t/);
  await demo("", h.ctx); assert.match(h.notices.at(-1)!, /unavailable/);
  h.pending[0].resolve(response()); await execution;
  h.busy(); await demo("", h.ctx); assert.match(h.notices.at(-1)!, /unavailable/);
});
