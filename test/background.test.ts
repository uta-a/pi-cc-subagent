import { test } from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, ExtensionToolContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import extension from "../src/index.ts";
import { emptyUsage, type Details, type Task } from "../src/state.ts";
import { MAX_BACKGROUND_AGENTS, RESULT_MESSAGE_TYPE } from "../src/background.ts";

interface Params extends Partial<Task> { tasks?: Task[]; run_in_background?: boolean }
interface Result { content: { type: "text"; text: string }[]; details: Details; usage?: Usage; isError?: boolean }
type Execute = (id: string, params: Params, signal: AbortSignal | undefined, update: (() => void) | undefined, ctx: ExtensionToolContext) => Promise<Result>;
type MessageRenderer = Parameters<ExtensionAPI["registerMessageRenderer"]>[1];
const task: Task = { description: "Find code", prompt: "Find code", subagent_type: "Explore" };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function response(text = "Done"): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], api: "anthropic-messages", provider: "test", model: "test", usage: { ...emptyUsage(), input: 100, output: 10, totalTokens: 110 }, stopReason: "stop", timestamp: Date.now() };
}
function harness() {
  const events = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
  const renderers = new Map<string, MessageRenderer>();
  const sent: { message: Parameters<ExtensionAPI["sendMessage"]>[0]; options: Parameters<ExtensionAPI["sendMessage"]>[1] }[] = [];
  const writes: (string | undefined)[] = [], notices: string[] = [];
  const pending: { resolve: (value: AssistantMessage) => void; signal: AbortSignal }[] = [];
  const nested: { name: string; signal?: AbortSignal }[] = [];
  const theme = { style: (text: string) => text, fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
  let editorFactory = () => ({ getText: () => "", handleInput(_key: string) {} });
  let tool!: { execute: Execute; renderResult: (result: Result, options: { expanded: boolean }, theme: Theme, context: { keyHint: () => string }) => Component };
  const pi = {
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => void) { events.set(name, handler); },
    registerTool(definition: unknown) { tool = definition as typeof tool; },
    registerCommand(name: string, definition: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) { commands.set(name, definition.handler); },
    registerEntryRenderer() {},
    registerMessageRenderer(name: string, renderer: MessageRenderer) { renderers.set(name, renderer); },
    sendMessage(message: Parameters<ExtensionAPI["sendMessage"]>[0], options: Parameters<ExtensionAPI["sendMessage"]>[1]) { sent.push({ message, options }); },
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: "tui", cwd: "/tmp", model: { provider: "test", id: "test" }, tools: [{ name: "read", description: "Read", parameters: {} }],
    isIdle: () => true, getSystemPrompt: () => "test",
    ui: { theme, getEditorComponent: () => editorFactory,
      setEditorComponent(factory: typeof editorFactory) { editorFactory = factory; },
      setStatus(_key: string, text: string | undefined) { writes.push(text); },
      notify(text: string) { notices.push(text); } },
    modelRegistry: { streamSimple(_model: unknown, _context: unknown, options: { signal: AbortSignal }) {
      let resolve!: (value: AssistantMessage) => void;
      const result = new Promise<AssistantMessage>(r => { resolve = r; });
      pending.push({ resolve, signal: options.signal });
      return { async *[Symbol.asyncIterator]() {}, result: () => result };
    } },
    executeTool: async (name: string, _args: unknown, options: { signal?: AbortSignal }) => {
      nested.push({ name, signal: options.signal });
      return { isError: false, result: { content: [{ type: "text", text: "contents" }], details: {} } };
    },
  } as unknown as ExtensionToolContext & ExtensionCommandContext;
  extension(pi);
  return { ctx, theme, events, commands, renderers, sent, writes, notices, pending, nested,
    execute: (params: Params, signal?: AbortSignal, update?: () => void) => tool.execute("id", params, signal, update, ctx),
    receipt: (result: Result) => tool.renderResult(result, { expanded: false }, theme, { keyHint: () => "ctrl+o to expand" }).render(200).join("\n"),
    shutdown: () => events.get("session_shutdown")!({}, ctx),
  };
}

test("background returns before responses, freezes a launch receipt and sends one followUp with all results", async () => {
  const h = harness(); let updates = 0;
  const result = await h.execute({ run_in_background: true, tasks: [
    { ...task, name: "researcher" }, { ...task, description: "Design", subagent_type: "Plan" },
  ] }, undefined, () => { updates++; });
  assert.equal(h.pending.length, 2);
  assert.equal(h.sent.length, 0);
  assert.equal(result.usage, undefined);
  assert.match(result.content[0].text, /researcher: Find code/);
  assert.match(result.content[0].text, /Plan: Design/);
  assert.match(result.content[0].text, /delivered later as a message/);
  assert.deepEqual(result.details.runs.map(run => run.status), ["running", "running"]);
  assert.match(h.writes.at(-1)!, /researcher/);
  assert.doesNotMatch(h.receipt(result), /Running|Initializing|Queued/);
  h.pending[1].resolve(response("Design answer")); await flush();
  assert.equal(h.sent.length, 0);
  h.pending[0].resolve(response("Code answer")); await flush();
  assert.equal(h.sent.length, 1);
  const { message, options } = h.sent[0];
  assert.equal(message.customType, RESULT_MESSAGE_TYPE);
  assert.equal(message.display, true);
  assert.deepEqual(options, { deliverAs: "followUp", triggerTurn: true });
  assert.equal(message.content, "## Find code [completed]\nCode answer\n\n## Design [completed]\nDesign answer");
  assert.equal((message.details as Details).runs[0].usage.totalTokens, 110);
  assert.equal(result.details.runs[0].status, "running"); // receipt cannot mutate after returning
  assert.equal(updates, 0); // no tool-result callbacks after returning
  assert.equal(h.writes.at(-1), undefined);
  h.shutdown();
});

test("background rejects the whole call before launch if any task is writable or unspecified", async () => {
  const h = harness();
  for (const subagent_type of ["general-purpose", undefined] as const) {
    await assert.rejects(h.execute({ run_in_background: true, tasks: [task, { ...task, subagent_type }] }), /every task.*read-only/);
    await assert.rejects(h.execute({ ...task, subagent_type, run_in_background: true }), /Explore or Plan/);
  }
  assert.equal(h.pending.length, 0);
  assert.equal(h.sent.length, 0);
  assert.equal(h.writes.length, 0);
  h.shutdown();
});

test("parent abort is isolated; named stop and stop-all interrupt children and release status", async () => {
  const h = harness(), parent = new AbortController();
  await h.execute({ ...task, run_in_background: true }, parent.signal);
  await h.execute({ ...task, run_in_background: true }, parent.signal);
  parent.abort();
  assert.ok(h.pending.every(child => !child.signal.aborted && child.signal !== parent.signal));
  const stop = h.commands.get("cc-agents-stop")!;
  await stop("missing", h.ctx); assert.match(h.notices.at(-1)!, /No matching/);
  await stop("Explore-2", h.ctx);
  assert.equal(h.pending[0].signal.aborted, false);
  assert.equal(h.pending[1].signal.aborted, true);
  h.pending[1].resolve(response()); await flush();
  assert.match(String(h.sent[0].message.content), /\[aborted\]\nInterrupted/);
  assert.match(h.writes.at(-1)!, /Explore  Find code/);
  assert.doesNotMatch(h.writes.at(-1)!, /Explore-2/);
  await stop("", h.ctx);
  assert.equal(h.pending[0].signal.aborted, true);
  h.pending[0].resolve(response()); await flush();
  assert.equal(h.writes.at(-1), undefined);
  assert.match(String(h.sent[1].message.content), /Interrupted/);
  h.shutdown();
});

test("already aborted parent signals do not prevent background launch", async () => {
  const h = harness();
  await h.execute({ ...task, run_in_background: true }, AbortSignal.abort());
  assert.equal(h.pending[0].signal.aborted, false);
  h.pending[0].resolve(response()); await flush();
  assert.equal(h.sent.length, 1);
  h.shutdown();
});

test("session shutdown aborts background work, clears timers and suppresses late messages/status", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = harness();
  await h.execute({ run_in_background: true, tasks: [task, task] });
  h.shutdown(); h.shutdown();
  assert.ok(h.pending.every(child => child.signal.aborted));
  assert.equal(h.writes.at(-1), undefined);
  const count = h.writes.length;
  t.mock.timers.tick(5000);
  for (const child of h.pending) child.resolve(response());
  await flush();
  assert.equal(h.writes.length, count);
  assert.equal(h.sent.length, 0);
  await assert.rejects(h.execute({ ...task, run_in_background: true }), /shut down/);
});

test("global background cap rejects atomically across calls and frees slots only when settled", async () => {
  const h = harness();
  await assert.rejects(h.execute({ run_in_background: true, tasks: Array.from({ length: MAX_BACKGROUND_AGENTS + 1 }, () => task) }), /capacity exceeded/);
  assert.equal(h.pending.length, 0);
  await h.execute({ run_in_background: true, tasks: [task, task, task] });
  await assert.rejects(h.execute({ run_in_background: true, tasks: [task, task] }), /Nothing started/);
  assert.equal(h.pending.length, 3);
  await h.execute({ ...task, run_in_background: true });
  assert.equal(h.pending.length, MAX_BACKGROUND_AGENTS);
  await h.commands.get("cc-agents-stop")!("Explore-4", h.ctx);
  await assert.rejects(h.execute({ ...task, run_in_background: true }), /capacity exceeded/);
  h.pending[3].resolve(response()); await flush();
  await h.execute({ ...task, run_in_background: true });
  assert.equal(h.pending.length, MAX_BACKGROUND_AGENTS + 1);
  for (const child of h.pending) child.resolve(response());
  await flush();
  assert.equal(h.sent.length, 3);
  assert.equal(h.writes.at(-1), undefined);
  h.shutdown();
});

test("completion message renderer reuses collapsed Done rows and the tools-expand key", async () => {
  const h = harness();
  assert.ok(h.renderers.has(RESULT_MESSAGE_TYPE));
  await h.execute({ ...task, run_in_background: true });
  h.pending[0].resolve(response("Final answer")); await flush();
  const renderer = h.renderers.get(RESULT_MESSAGE_TYPE)!;
  const message = { ...h.sent[0].message, role: "custom" as const, timestamp: Date.now() };
  const hint = (id: string, label: string) => { assert.equal(id, "app.tools.expand"); return `custom-key ${label}`; };
  const render = (expanded: boolean) => renderer(message, { expanded, outputPad: 0, keyHint: hint, keyText: () => "custom-key" }, h.theme)!.render(200).join("\n");
  assert.match(render(false), /Done \(0 tool uses · 110 tokens/);
  assert.match(render(false), /custom-key to expand/);
  assert.doesNotMatch(render(false), /Final answer/);
  assert.match(render(true), /Prompt:/);
  assert.match(render(true), /Final answer/);
  h.shutdown();
});

test("background preview remains available after return and shows final output when the child finishes", async () => {
  const h = harness();
  let preview!: Component & { handleInput(key: string): void; dispose(): void };
  h.ctx.ui.custom = ((factory: (tui: unknown, theme: Theme, keys: unknown, done: () => void) => typeof preview) => new Promise<void>(resolve => {
    preview = factory({ terminal: { rows: 40 }, requestRender() {} }, h.theme, { matches: () => false }, () => { preview.dispose(); resolve(); });
  })) as typeof h.ctx.ui.custom;
  await h.execute({ ...task, name: "researcher", run_in_background: true });
  const open = h.commands.get("cc-agents")!("", h.ctx);
  const text = () => preview.render(200).join("\n");
  assert.match(text(), /researcher — live activity/);
  assert.match(text(), /Status: running/);
  h.pending[0].resolve(response("Final findings")); await flush();
  assert.equal(h.writes.at(-1), undefined);
  assert.match(text(), /Status: completed/);
  assert.match(text(), /Usage: 110 cumulative tokens/);
  assert.match(text(), /Final findings/);
  preview.handleInput("\r"); await open;
  h.shutdown();
});

test("background completion caps child and combined output like foreground results", async () => {
  const h = harness();
  await h.execute({ run_in_background: true, tasks: [task, task] });
  for (const child of h.pending) child.resolve(response("日".repeat(30000)));
  await flush();
  const { content, details } = h.sent[0].message;
  assert.equal(typeof content, "string");
  assert.ok(Buffer.byteLength(content as string) <= 48 * 1024 + 30);
  assert.match(content as string, /\[Output truncated\]$/);
  assert.ok((details as Details).runs.every(run => run.output.endsWith("[Output truncated]") && !run.output.includes("�")));
  h.shutdown();
});

test("background nested reads still use executeTool after the parent tool has returned", async () => {
  const h = harness();
  await h.execute({ ...task, run_in_background: true });
  h.pending[0].resolve({ ...response(), stopReason: "toolUse", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/index.ts" } }] });
  await flush();
  assert.equal(h.nested[0].name, "read");
  assert.equal(h.nested[0].signal, h.pending[0].signal);
  assert.equal(h.pending.length, 2);
  h.pending[1].resolve(response()); await flush();
  assert.equal((h.sent[0].message.details as Details).runs[0].toolUses, 1);
  h.shutdown();
});

test("failed background tasks settle with other results and preserve foreground usage accounting", async () => {
  const h = harness();
  await h.execute({ run_in_background: true, tasks: [task, task] });
  h.pending[0].resolve({ ...response(), stopReason: "error", errorMessage: "Unavailable" });
  h.pending[1].resolve(response("ok")); await flush();
  assert.equal(h.sent.length, 1);
  assert.match(String(h.sent[0].message.content), /\[failed\]\nUnavailable/);
  assert.match(String(h.sent[0].message.content), /\[completed\]\nok/);
  const foreground = h.execute({ ...task, run_in_background: false });
  h.pending[2].resolve(response());
  assert.equal((await foreground).usage?.totalTokens, 110);
  assert.equal(h.sent.length, 1);
  h.shutdown();
});
