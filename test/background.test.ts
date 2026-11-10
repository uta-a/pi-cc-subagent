import { test } from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage, Usage, Message, SimpleStreamOptions } from "@earendil-works/pi-ai";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
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
  const events = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
  const renderers = new Map<string, MessageRenderer>();
  const sent: { message: Parameters<ExtensionAPI["sendMessage"]>[0]; options: Parameters<ExtensionAPI["sendMessage"]>[1] }[] = [];
  const writes: (string | undefined)[] = [], notices: string[] = [];
  const pending: { resolve: (value: AssistantMessage) => void; signal: AbortSignal }[] = [];
  const nested: { name: string; signal?: AbortSignal }[] = [];
  const conversations: Message[][] = [];
  const choices: SimpleStreamOptions[] = [];
  const theme = { style: (text: string) => text, fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
  let editorFactory = () => ({ getText: () => "", handleInput(_key: string) {} });
  let tool!: { execute: Execute; renderResult: (result: Result, options: { expanded: boolean }, theme: Theme, context: { keyHint: () => string }) => Component };
  const pi = {
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { events.set(name, handler); },
    registerTool(definition: unknown) { tool = definition as typeof tool; },
    registerCommand(name: string, definition: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) { commands.set(name, definition.handler); },
    registerEntryRenderer() {},
    registerMessageRenderer(name: string, renderer: MessageRenderer) { renderers.set(name, renderer); },
    sendMessage(message: Parameters<ExtensionAPI["sendMessage"]>[0], options: Parameters<ExtensionAPI["sendMessage"]>[1]) { sent.push({ message, options }); },
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: "tui", cwd: "/tmp", model: { provider: "test", id: "test" }, tools: ["read", "write", "edit"].map(name => ({ name, description: name, parameters: {} })),
    isIdle: () => true, getSystemPrompt: () => "test",
    ui: { theme, getEditorComponent: () => editorFactory,
      setEditorComponent(factory: typeof editorFactory) { editorFactory = factory; },
      setStatus(_key: string, text: string | undefined) { writes.push(text); },
      notify(text: string) { notices.push(text); } },
    modelRegistry: { streamSimple(_model: unknown, context: { messages: Message[] }, options: SimpleStreamOptions & { signal: AbortSignal }) {
      conversations.push(structuredClone(context.messages));
      choices.push(options);
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
  return { ctx, theme, events, commands, renderers, sent, writes, notices, pending, nested, conversations, choices,
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

test("read-only calls run in the background by default", async () => {
  const h = harness();
  const single = await h.execute({ ...task });
  assert.match(single.content[0].text, /^Launched background agents:/);
  const parallel = await h.execute({ tasks: [task, { ...task, subagent_type: "Plan" }] });
  assert.match(parallel.content[0].text, /^Launched background agents:/);
  assert.equal(h.pending.length, 3);
  for (const pending of h.pending) pending.resolve(response());
  await flush();
  assert.equal(h.sent.length, 2);
  h.shutdown();
});
test("explicit false always waits; full total capacity makes implicit calls wait", async () => {
  for (const params of [
    { ...task, run_in_background: false },
    { ...task, subagent_type: "general-purpose" as const, run_in_background: false },
  ]) {
    const h = harness();
    let settled = false;
    const call = h.execute(params).then(result => { settled = true; return result; });
    await flush();
    assert.equal(settled, false, JSON.stringify(params)); // waits for children
    for (const pending of h.pending) pending.resolve(response("answer"));
    const result = await call;
    assert.match(result.content[0].text, /\[completed\]\nanswer/);
    assert.equal(h.sent.length, 0);
    h.shutdown();
  }
  const h = harness();
  await h.execute({ tasks: Array.from({ length: MAX_BACKGROUND_AGENTS }, () => task) });
  let settled = false;
  const overflow = h.execute({ ...task }).then(result => { settled = true; return result; });
  await flush();
  assert.equal(settled, false); // capacity full: implicit default falls back to waiting instead of failing
  for (const pending of h.pending) pending.resolve(response("answer"));
  assert.match((await overflow).content[0].text, /\[completed\]/);
  await flush();
  assert.equal(h.sent.length, 1);
  h.shutdown();
});
test("writers and unspecified types launch in the background by default and explicit true", async () => {
  for (const subagent_type of ["general-purpose", undefined] as const) {
    for (const run_in_background of [undefined, true]) {
      const h = harness();
      const result = await h.execute({ tasks: [task, { ...task, subagent_type }], run_in_background });
      assert.equal(result.details.background, true);
      assert.equal(h.pending.length, 2);
      for (const child of h.pending) child.resolve(response());
      await flush();
      assert.equal(h.sent.length, 1);
      h.shutdown();
    }
  }
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

test("background completion saves full output, returns a head/path and caps UI details", async t => {
  const dir = fs.mkdtempSync(join(process.cwd(), ".test-results-"));
  t.mock.method(os, "tmpdir", () => dir);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = harness();
  await h.execute({ run_in_background: true, tasks: [task, task] });
  for (const child of h.pending) child.resolve(response("日".repeat(30000)));
  await flush();
  const { content, details } = h.sent[0].message;
  assert.equal(typeof content, "string");
  assert.ok(Buffer.byteLength(content as string) <= 48 * 1024 + 30);
  assert.match(content as string, /Full result \(88 KiB\) saved to:/);
  assert.ok(Buffer.byteLength(content as string) < 6 * 1024);
  const paths = [...(content as string).matchAll(/saved to: (.+) —/g)].map(match => match[1]);
  assert.equal(paths.length, 2);
  for (const path of paths) assert.equal(fs.readFileSync(path, "utf8"), "日".repeat(30000));
  assert.ok((details as Details).runs.every(run => run.output.endsWith("[Output truncated]") && !run.output.includes("�")));
  h.shutdown();
  for (const path of paths) assert.equal(fs.existsSync(path), false);
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

test("writer cap is per task, atomic across calls, with implicit foreground fallback", async () => {
  const h = harness();
  const writer = { ...task, subagent_type: undefined };
  await assert.rejects(h.execute({ run_in_background: true, tasks: [writer, writer, writer] }), /2 writable.*Nothing started/);
  assert.equal(h.pending.length, 0);
  await h.execute({ tasks: [writer, writer] });
  await assert.rejects(h.execute({ ...writer, run_in_background: true }), /capacity exceeded/);
  assert.equal(h.pending.length, 2);
  // Read-only tasks still fit beside the two writers, up to the total cap.
  await h.execute({ tasks: [task, task] });
  await assert.rejects(h.execute({ ...task, run_in_background: true }), /capacity exceeded/);
  const foreground = h.execute(writer);
  await flush();
  assert.equal(h.pending.length, 5);
  h.pending[4].resolve(response("foreground answer"));
  assert.equal((await foreground).details.background, undefined);
  await h.commands.get("cc-agents-stop")!("worker-2", h.ctx);
  await assert.rejects(h.execute({ ...writer, run_in_background: true }), /capacity exceeded/);
  h.pending[1].resolve(response()); await flush();
  assert.equal(h.sent.length, 0); // first group still has one running writer
  await h.execute({ ...writer, run_in_background: true });
  assert.equal(h.pending.length, 6);
  for (const child of h.pending) child.resolve(response());
  await flush();
  h.shutdown();
});

function mutate(name = "edit", path = "@shared.ts"): AssistantMessage {
  return { ...response(), stopReason: "toolUse", content: [{ type: "toolCall", id: "mutation", name, arguments: { path } }] };
}
function mainCall(h: ReturnType<typeof harness>, name = "write", path = "shared.ts", parentToolCallId?: string) {
  return h.events.get("tool_call")!({ toolName: name, toolCallId: "main-call", input: { path }, parentToolCallId }, h.ctx) as { block: boolean; reason: string } | undefined;
}
function mainEnd(h: ReturnType<typeof harness>, isError = false) {
  h.events.get("tool_execution_end")!({ toolName: "write", toolCallId: "main-call", isError }, h.ctx);
}
test("main write/edit blocks only top-level conflicts and releases child locks on every settlement", async () => {
  for (const status of ["completed", "failed", "aborted"] as const) {
    const h = harness();
    await h.execute({ description: "Write", prompt: "Write", name: "writer" });
    h.pending[0].resolve(mutate()); await flush();
    assert.equal(h.nested.length, 1);
    for (const tool of ["write", "edit"]) {
      assert.deepEqual(mainCall(h, tool), { block: true, reason: "/tmp/shared.ts is being modified by background agent writer; wait for its result message or stop it with /cc-agents-stop writer." });
      assert.equal(mainCall(h, tool, "/tmp/shared.ts", "parent"), undefined);
    }
    assert.equal(mainCall(h, "read"), undefined);
    if (status === "aborted") await h.commands.get("cc-agents-stop")!("writer", h.ctx);
    h.pending[1].resolve(status === "failed" ? { ...response(), stopReason: "error", errorMessage: "Failed" } : response());
    await flush();
    assert.equal((h.sent[0].message.details as Details).runs[0].status, status);
    assert.equal(mainCall(h), undefined);
    h.shutdown();
  }
});
test("main reservations protect pending/successful edits but not failed or nested edits", async () => {
  for (const outcome of ["pending", "success", "failure", "nested"] as const) {
    const h = harness();
    await h.execute({ description: "Write", prompt: "Write" });
    assert.equal(mainCall(h, "edit", "@shared.ts", outcome === "nested" ? "parent" : undefined), undefined);
    if (outcome === "success" || outcome === "failure") mainEnd(h, outcome === "failure");
    h.pending[0].resolve(mutate()); await flush();
    assert.equal(h.nested.length, outcome === "pending" || outcome === "success" ? 0 : 1);
    if (!h.nested.length) {
      const text = JSON.stringify(h.conversations[1]);
      assert.match(text, /locked by main/);
    }
    h.pending[1].resolve(response()); await flush();
    // Main locks expire after the last writer; a new child may edit that path.
    await h.execute({ description: "Write again", prompt: "Write again" });
    h.pending[2].resolve(mutate()); await flush();
    assert.equal(h.nested.length, outcome === "pending" || outcome === "success" ? 1 : 2);
    h.pending[3].resolve(response()); await flush();
    h.shutdown();
  }
});
test("child locks remain until settlement and do not guard foreground children", async () => {
  const h = harness();
  await h.execute({ description: "A", prompt: "A", name: "alpha" });
  await h.execute({ description: "B", prompt: "B", name: "beta" });
  h.pending[0].resolve(mutate("write")); await flush();
  h.pending[1].resolve(mutate()); await flush();
  assert.equal(h.nested.length, 1);
  assert.match(JSON.stringify(h.conversations[3]), /background agent alpha/);
  // Foreground children deliberately do not participate in background locks.
  const foreground = h.execute({ description: "Foreground", prompt: "Foreground", run_in_background: false });
  h.pending[4].resolve(mutate()); await flush();
  assert.equal(h.nested.length, 2);
  h.pending[5].resolve(response()); await foreground;
  await h.commands.get("cc-agents-stop")!("alpha", h.ctx);
  assert.ok(mainCall(h)?.block); // abort requested is not settled yet
  h.pending[2].resolve(response()); await flush();
  assert.equal(mainCall(h), undefined);
  mainEnd(h, true);
  h.pending[3].resolve(response()); await flush();
  h.shutdown();
});
test("shutdown clears locks immediately and late model responses cannot reacquire them", async () => {
  const h = harness();
  await h.execute({ description: "Write", prompt: "Write" });
  h.pending[0].resolve(mutate()); await flush();
  assert.ok(mainCall(h)?.block);
  h.shutdown();
  assert.equal(mainCall(h), undefined);
  h.pending[1].resolve(mutate()); await flush();
  assert.equal(h.nested.length, 1);
  assert.equal(h.sent.length, 0);
});
test("extension injects the latest bounded context capture and clears it on capture failure", async () => {
  const h = harness();
  const capture = (content: unknown) => h.events.get("before_agent_start")!({ systemPromptOptions: { contextFiles: [{ path: "AGENTS.md", content }] } }, h.ctx);
  capture("old context"); capture("latest context");
  await h.execute(task);
  const system = h.conversations[0][0] as { content: string };
  assert.match(system.content, /<project_context>.*latest context/s);
  assert.doesNotMatch(system.content, /old context|^test\n/);
  capture(null);
  await h.execute(task);
  assert.match((h.conversations[1][0] as { content: string }).content, /^test\n/);
  for (const child of h.pending) child.resolve(response());
  await flush(); h.shutdown();
});
test("foreground large result stores full text with restrictive modes and removes it at shutdown", async t => {
  const dir = fs.mkdtempSync(join(process.cwd(), ".test-results-"));
  t.mock.method(os, "tmpdir", () => dir);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = harness();
  const call = h.execute({ ...task, run_in_background: false });
  const full = "HEAD:" + "x".repeat(60000) + ":TAIL";
  h.pending[0].resolve(response(full));
  const result = await call;
  const text = result.content[0].text;
  assert.match(text, /HEAD:/);
  assert.doesNotMatch(text, /:TAIL/);
  assert.ok(Buffer.byteLength(text) < 3 * 1024);
  const path = text.match(/saved to: (.+) —/)![1];
  assert.equal(fs.readFileSync(path, "utf8"), full);
  assert.equal(fs.statSync(path).mode & 0o777, 0o600);
  assert.equal(fs.statSync(join(dir, "pi-cc-subagent")).mode & 0o777, 0o700);
  assert.match(result.details.runs[0].output, /Output truncated/);
  h.shutdown();
  assert.equal(fs.existsSync(path), false);
});
test("result-file write failure falls back to capped inline text in both delivery modes", async t => {
  const dir = fs.mkdtempSync(join(process.cwd(), ".test-results-"));
  t.mock.method(os, "tmpdir", () => dir);
  t.mock.method(fs, "writeFileSync", () => { throw new Error("Disk full"); });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const run_in_background of [false, true]) {
    const h = harness();
    const call = h.execute({ ...task, run_in_background });
    h.pending[0].resolve(response("x".repeat(60000)));
    const result = await call; await flush();
    const text = run_in_background ? String(h.sent[0].message.content) : result.content[0].text;
    assert.match(text, /Output truncated/);
    assert.doesNotMatch(text, /saved to:/);
    h.shutdown();
  }
});
test("large budget partial reports save the error and full report in both delivery modes", async t => {
  const dir = fs.mkdtempSync(join(process.cwd(), ".test-results-"));
  t.mock.method(os, "tmpdir", () => dir);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const run_in_background of [false, true]) {
    const h = harness();
    const call = h.execute({ ...task, run_in_background });
    const exhausted = response(); exhausted.usage.output = 4096;
    h.pending[0].resolve(exhausted); await flush();
    const partial = "## Findings\n" + "Incomplete evidence\n".repeat(1000);
    h.pending[1].resolve(response(partial));
    const result = await call; await flush();
    const text = run_in_background ? String(h.sent[0].message.content) : result.content[0].text;
    assert.match(text, /Budget reached/); assert.match(text, /## Findings/);
    const path = text.match(/saved to: (.+) —/)![1];
    assert.match(fs.readFileSync(path, "utf8"), /Budget reached.*\n\n## Findings/s);
    assert.ok(fs.readFileSync(path, "utf8").endsWith(partial));
    const details = run_in_background ? h.sent[0].message.details as Details : result.details;
    assert.equal(details.runs[0].output, partial);
    h.shutdown(); assert.equal(fs.existsSync(path), false);
  }
});
test("foreground and background budget results include both error and partial report", async () => {
  for (const run_in_background of [false, true]) {
    const h = harness();
    const call = h.execute({ ...task, run_in_background });
    const exhausted = response(); exhausted.usage.output = 4096;
    h.pending[0].resolve(exhausted); await flush();
    assert.equal(h.choices[1].toolChoice, "none");
    h.pending[1].resolve(response("## Findings\nPartial report; more work needed"));
    const result = await call; await flush();
    const text = run_in_background ? String(h.sent[0].message.content) : result.content[0].text;
    assert.match(text, /\[failed\]\nBudget reached.*output budget/s);
    assert.match(text, /Partial report; more work needed/);
    if (run_in_background) {
      const message = { ...h.sent[0].message, role: "custom" as const, timestamp: Date.now() };
      const rendered = h.renderers.get(RESULT_MESSAGE_TYPE)!(message, { expanded: true, outputPad: 0, keyHint: () => "", keyText: () => "" }, h.theme)!.render(200).join("\n");
      assert.match(rendered, /Budget reached/); assert.match(rendered, /Partial report; more work needed/);
    }
    h.shutdown();
  }
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
