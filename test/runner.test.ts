import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, JsonObject, Message, SimpleStreamOptions, Api, Model } from "@earendil-works/pi-ai";
import { createRun, emptyUsage } from "../src/state.ts";
import { boundReadArgs, callKey, cap, DEFAULT_READ_LINES, MAX_READ_LINES, MAX_TURNS, pooled, runAgent } from "../src/runner.ts";
import { FileLocks } from "../src/locks.ts";
import { captureContext, MAX_CONTEXT_BYTES } from "../src/prompts.ts";
import { reportText } from "../src/results.ts";
import { renderRuns } from "../src/render.ts";

function message(text = "Found it", tool?: string): AssistantMessage {
  return {
    role: "assistant", content: tool ? [{ type: "toolCall", id: "t1", name: tool, arguments: { path: "src/auth.ts" } }] : [{ type: "text", text }],
    api: "anthropic-messages", model: "test", provider: "test", usage: { ...emptyUsage(), input: 100, output: 10, totalTokens: 110 },
    stopReason: tool ? "toolUse" : "stop", timestamp: Date.now(),
  };
}
function toolCalls(...calls: [string, JsonObject][]): AssistantMessage {
  const m = message("", "read");
  m.content = calls.map(([name, args], i) => ({ type: "toolCall" as const, id: `c${Math.random()}-${i}`, name, arguments: args }));
  return m;
}
function harness(responses: AssistantMessage[], execute?: (name: string, args: Record<string, unknown>) => void) {
  let requests = 0;
  const conversations: Message[][] = [];
  const choices: { model: unknown; options: SimpleStreamOptions }[] = [];
  const ctx = {
    model: { id: "test", provider: "test" }, thinkingLevel: "off", cwd: "/tmp",
    tools: ["read", "bash", "write", "edit", "cc_subagent"].map(name => ({ name, parameters: {}, description: name })),
    getSystemPrompt: () => "Follow parent permissions",
    modelRegistry: { streamSimple(model: unknown, context: { messages: Message[] }, options: SimpleStreamOptions) {
      choices.push({ model, options });
      conversations.push(structuredClone(context.messages));
      const response = responses[Math.min(requests++, responses.length - 1)];
      return { async *[Symbol.asyncIterator]() {}, result: async () => response };
    } },
    executeTool: async (name: string, args: Record<string, unknown>) => {
      execute?.(name, args);
      return { isError: false, result: { content: [{ type: "text", text: "file contents" }], details: {} } };
    },
  } as unknown as ExtensionToolContext;
  return { ctx, conversations, choices, requests: () => requests };
}
test("isolated model loop executes tools through parent and accumulates usage", async () => {
  const called: string[] = [];
  const h = harness([message("", "read"), message()], name => called.push(name));
  const run = createRun({ description: "Find auth", prompt: "Find auth", subagent_type: "Explore" });
  await runAgent(run, h.ctx, new AbortController().signal, () => {});
  assert.equal(run.status, "completed");
  assert.equal(run.output, "Found it");
  assert.deepEqual(called, ["read"]);
  assert.equal(run.usage.input, 200);
  assert.equal(run.tokens, 110); // latest context, not cumulative billing
  assert.equal(run.toolUses, 1);
  assert.equal(h.conversations[1].at(-1)?.role, "toolResult");
  const first = h.conversations[0][0];
  assert.equal(first.role, "system");
  if (first.role === "system") assert.deepEqual(first.toolsAdded?.map(t => t.name), ["read"]);
});
test("streaming text is exposed to the live viewer without becoming a premature final response", async () => {
  const h = harness([message("final")]);
  h.ctx.modelRegistry.streamSimple = (() => ({
    async *[Symbol.asyncIterator]() { yield { type: "text_delta", delta: "partial" }; },
    result: async () => message("final"),
  })) as unknown as typeof h.ctx.modelRegistry.streamSimple;
  const run = createRun({ description: "Stream", prompt: "Stream" });
  const updates: { live?: string; activity?: string; output: string }[] = [];
  await runAgent(run, h.ctx, new AbortController().signal, () => updates.push({ live: run.liveText, activity: run.currentActivity, output: run.output }));
  assert.ok(updates.some(update => update.live === "partial" && update.activity === "Writing response…" && update.output === ""));
  assert.equal(run.output, "final");
  assert.equal(run.liveText, undefined);
  assert.equal(run.currentActivity, "completed");
});
test("runner applies selected model, effort and response budget and records the choice", async () => {
  const h = harness([message()]);
  const haiku = { id: "claude-haiku-5-5", provider: "test", reasoning: true, maxTokens: 32768 } as Model<Api>;
  h.ctx.modelRegistry.getAvailable = () => [haiku];
  const run = createRun({ description: "Find code", prompt: "Find code", subagent_type: "Explore" });
  await runAgent(run, h.ctx, new AbortController().signal, () => {});
  assert.equal(h.choices[0].model, haiku);
  assert.equal(h.choices[0].options.reasoning, "minimal");
  assert.equal(h.choices[0].options.maxTokens, 2048);
  assert.equal(run.model, "test/claude-haiku-5-5"); assert.equal(run.effort, "minimal"); assert.equal(run.profile, "quick");
  assert.equal(h.requests(), 1);
});
test("cumulative output budget runs one tool-free partial report request", async () => {
  const first = message("", "read"); first.usage.output = 12000;
  const h = harness([first, message("Incomplete findings")]);
  const run = createRun({ description: "Work", prompt: "Work" });
  await runAgent(run, h.ctx, new AbortController().signal, () => {});
  assert.equal(h.requests(), 2); assert.equal(run.status, "failed"); assert.match(run.error!, /output budget/);
  assert.equal(h.choices[1].options.toolChoice, "none");
  assert.equal(h.choices[1].options.maxTokens, 1024);
  assert.equal(run.output, "Incomplete findings");
  assert.match(reportText(run), /Budget reached.*\n\nIncomplete findings/s);
  assert.ok(h.conversations[1].some(m => m.role === "toolResult" && m.isError));
});
test("tool-call budget bounds oversized batches without an automatic retry", async () => {
  const batch = message("", "read");
  batch.content = Array.from({ length: 30 }, (_, i) => ({ type: "toolCall" as const, id: `t${i}`, name: "read", arguments: { path: `file-${i}.ts` } }));
  let calls = 0;
  const h = harness([batch, message("Partial work")], () => { calls++; });
  const run = createRun({ description: "Work", prompt: "Work" });
  await runAgent(run, h.ctx, new AbortController().signal, () => {});
  assert.equal(calls, 24); assert.equal(h.requests(), 2); assert.equal(run.status, "failed");
  assert.match(run.error!, /tool budget/);
  assert.equal(run.output, "Partial work");
  assert.equal(h.choices[1].options.toolChoice, "none");
  const denied = h.conversations[1].filter(m => m.role === "toolResult" && m.isError);
  assert.equal(denied.length, 6);
  assert.ok(denied.every(m => m.role === "toolResult" && m.content[0].type === "text" && m.content[0].text.startsWith("Budget reached; no more tools.")));
});
test("read limits default to a bounded range and clamp oversized requests", () => {
  assert.deepEqual(boundReadArgs({ path: "a.ts" }), { path: "a.ts", limit: DEFAULT_READ_LINES });
  assert.deepEqual(boundReadArgs({ path: "a.ts", offset: 40, limit: 1000 }), { path: "a.ts", offset: 40, limit: MAX_READ_LINES });
  assert.deepEqual(boundReadArgs({ path: "a.ts", limit: 50 }), { path: "a.ts", limit: 50 });
  for (const limit of [0, -1, 1.5, "20"]) assert.equal(boundReadArgs({ path: "a.ts", limit }).limit, DEFAULT_READ_LINES);
});
test("child read calls reach the parent tool with the bounded limit", async () => {
  const seen: Record<string, unknown>[] = [];
  const h = harness([toolCalls(["read", { path: "big.ts" }], ["read", { path: "big.ts", offset: 200, limit: 9999 }]), message()], (_n, args) => seen.push(args));
  await runAgent(createRun({ description: "Read", prompt: "Read", subagent_type: "Explore" }), h.ctx, new AbortController().signal, () => {});
  assert.deepEqual(seen, [{ path: "big.ts", limit: 200 }, { path: "big.ts", offset: 200, limit: 500 }]);
});
test("identical read-only calls are skipped across turns, including equivalent paths", async () => {
  let calls = 0;
  const h = harness([
    toolCalls(["read", { path: "src/a.ts" }]),
    toolCalls(["read", { path: "/tmp/src/a.ts" }], ["read", { path: "@src/a.ts", limit: 200 }], ["read", { path: "src/a.ts", offset: 200 }]),
    message(),
  ], () => { calls++; });
  const run = createRun({ description: "Read", prompt: "Read", subagent_type: "Explore" });
  await runAgent(run, h.ctx, new AbortController().signal, () => {});
  assert.equal(calls, 2); // first read + the new offset; both equivalent repeats skipped
  const results = h.conversations[2].filter(m => m.role === "toolResult");
  const texts = results.map(m => m.role === "toolResult" && m.content[0].type === "text" ? m.content[0].text : "");
  assert.match(texts[1], /^Skipped: an identical read call/); assert.match(texts[2], /^Skipped/);
  assert.equal(texts[3], "file contents");
  assert.equal(run.activities.filter(a => a.text.endsWith("duplicate skipped")).length, 2);
  assert.equal(run.status, "completed");
});
test("file-changing tools invalidate the duplicate cache", async () => {
  const names: string[] = [];
  const h = harness([
    toolCalls(["read", { path: "a.ts" }]),
    toolCalls(["bash", { command: "sed -i s/a/b/ a.ts" }]),
    toolCalls(["read", { path: "a.ts" }]),
    message(),
  ], name => names.push(name));
  await runAgent(createRun({ description: "Edit", prompt: "Edit" }), h.ctx, new AbortController().signal, () => {});
  assert.deepEqual(names, ["read", "bash", "read"]);
});
test("failed read-only calls are not cached and can be retried", async () => {
  let calls = 0;
  const h = harness([toolCalls(["read", { path: "a.ts" }]), toolCalls(["read", { path: "a.ts" }]), message()]);
  h.ctx.executeTool = async () => ({ toolCall: {} as never, isError: ++calls === 1, result: { content: [{ type: "text", text: calls === 1 ? "EBUSY" : "ok" }], details: {} } });
  await runAgent(createRun({ description: "Read", prompt: "Read", subagent_type: "Explore" }), h.ctx, new AbortController().signal, () => {});
  assert.equal(calls, 2);
});
test("call keys distinguish tools and arguments but not equivalent path spellings", () => {
  assert.equal(callKey("read", { path: "a.ts", limit: 200 }, "/w"), callKey("read", { limit: 200, path: "/w/a.ts" }, "/w"));
  assert.notEqual(callKey("read", { path: "a.ts" }, "/w"), callKey("grep", { path: "a.ts" }, "/w"));
  assert.notEqual(callKey("grep", { pattern: "x", path: "src" }, "/w"), callKey("grep", { pattern: "y", path: "src" }, "/w"));
});
test("automatic routing respects scoped models", async () => {
  const h = harness([message()]);
  const parent = h.ctx.model!;
  const haiku = { id: "claude-haiku-5-5", provider: "other", reasoning: true } as Model<Api>;
  h.ctx.modelRegistry.getAvailable = () => [parent, haiku];
  Object.defineProperty(h.ctx, "scopedModels", { value: [{ model: parent }] });
  const run = createRun({ description: "Find", prompt: "Find", subagent_type: "Explore" });
  await runAgent(run, h.ctx, new AbortController().signal, () => {});
  assert.equal(h.choices[0].model, parent);
});
test("read-only tool allowlist is enforced even for hallucinated bash", async () => {
  let calls = 0;
  const h = harness([message("", "bash"), message()], () => { calls++; });
  const run = createRun({ description: "Read only", prompt: "Look", subagent_type: "Plan" });
  await runAgent(run, h.ctx, new AbortController().signal, () => {});
  assert.equal(calls, 0);
  const result = h.conversations[1].at(-1);
  assert.ok(result?.role === "toolResult" && result.isError);
});
test("parent tool rejection is propagated into child conversation", async () => {
  const h = harness([message("", "read"), message()]);
  h.ctx.executeTool = async () => ({ toolCall: {} as never, isError: true, result: { content: [{ type: "text", text: "Permission denied" }], details: {} } });
  const run = createRun({ description: "Check", prompt: "Check" });
  await runAgent(run, h.ctx, new AbortController().signal, () => {});
  const result = h.conversations[1].at(-1);
  assert.ok(result?.role === "toolResult" && result.isError);
  assert.ok(run.activities.some(a => a.error));
});
test("abort before launch makes no model request", async () => {
  const h = harness([message()]);
  const signal = AbortSignal.abort();
  const run = createRun({ description: "Check", prompt: "Check" });
  await runAgent(run, h.ctx, signal, () => {});
  assert.equal(run.status, "aborted");
  assert.equal(h.requests(), 0);
});
test("empty/error/length model results fail rather than appearing done", async () => {
  for (const response of [message(""), { ...message(), stopReason: "error" as const, errorMessage: "Unavailable" }, { ...message(), stopReason: "length" as const }]) {
    const h = harness([response]);
    const run = createRun({ description: "Check", prompt: "Check" });
    await runAgent(run, h.ctx, new AbortController().signal, () => {});
    assert.equal(run.status, "failed");
  }
});
test("maximum turns bounds non-terminating agents", async () => {
  const h = harness([...Array.from({ length: MAX_TURNS }, () => message("", "read")), message("Turn limit report")]);
  const run = createRun({ description: "Loop", prompt: "Loop" });
  await runAgent(run, h.ctx, new AbortController().signal, () => {});
  assert.equal(run.status, "failed");
  assert.equal(h.requests(), MAX_TURNS + 1);
  assert.equal(h.choices.at(-1)!.options.toolChoice, "none");
  assert.match(run.error!, /turn budget/);
  assert.equal(run.output, "Turn limit report");
  const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const rendered = renderRuns([run], plain as never, { expanded: true, hint: "" }).render(200).join("\n");
  assert.match(rendered, /turn budget/);
  assert.match(rendered, /Turn limit report/);
});
test("pool caps concurrency and retains task ordering", async () => {
  let current = 0, peak = 0;
  const seen: number[] = [];
  await pooled([0, 1, 2, 3, 4, 5, 6, 7], 4, async item => {
    peak = Math.max(peak, ++current); seen.push(item);
    await new Promise(resolve => setTimeout(resolve, 2)); current--;
  });
  assert.equal(peak, 4);
  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6, 7]);
});
test("slim Explore/Plan prompts use captured project context; writers and missing context retain parent", async () => {
  const context = captureContext([{ path: "/tmp/AGENTS.md", content: "Project conventions" }], "/tmp");
  for (const subagent_type of ["Explore", "Plan", "general-purpose", undefined] as const) {
    for (const captured of [undefined, context]) {
      const h = harness([message()]);
      const run = createRun({ description: "Work", prompt: "Work", subagent_type });
      await runAgent(run, h.ctx, new AbortController().signal, () => {}, { context: captured });
      const system = h.conversations[0][0];
      assert.equal(system.role, "system");
      if (system.role !== "system" || typeof system.content !== "string") continue;
      const slim = captured && (subagent_type === "Explore" || subagent_type === "Plan");
      if (slim) {
        assert.match(system.content, /<project_context>.*\/tmp\/AGENTS.md.*Project conventions/s);
        assert.doesNotMatch(system.content, /Follow parent permissions/);
        assert.match(system.content, /Today's date: \d{4}-\d{2}-\d{2}/);
      } else assert.match(system.content, /Follow parent permissions/);
      const headings = subagent_type === "Explore" ? ["## Findings", "## Start here", "## Gaps"]
        : subagent_type === "Plan" ? ["## Recommendation", "## Steps", "## Risks", "## Open questions"]
        : ["## Changed files", "## Validation", "## Open risks", "## Next step", "## Needs decision"];
      for (const heading of headings) assert.ok(system.content.includes(heading));
      if (subagent_type === "Explore") assert.match(system.content, /paths\/symbols.*find\/grep narrowly.*needed ranges.*5 lines.*path:line/s);
      if (!subagent_type || subagent_type === "general-purpose") assert.match(system.content, /Never claim success.*validation failed.*options instead of guessing/s);
    }
  }
});
test("provider rejection of the project-context prompt retries once with the full parent prompt", async () => {
  const context = captureContext([{ path: "/tmp/AGENTS.md", content: "Project conventions" }], "/tmp");
  const rejected = { ...message(), content: [], stopReason: "error" as const, errorMessage: "prompt-capture: no capture", usage: emptyUsage() };
  const h = harness([rejected, message("Found it")]);
  const run = createRun({ description: "Find", prompt: "Find", subagent_type: "Explore" });
  await runAgent(run, h.ctx, new AbortController().signal, () => {}, { context });
  assert.equal(h.requests(), 2);
  assert.match((h.conversations[0][0] as { content: string }).content, /project_context/);
  assert.match((h.conversations[1][0] as { content: string }).content, /^Follow parent permissions/);
  assert.equal(h.conversations[1].length, 2); // rejected attempt is discarded, not replayed
  assert.equal(run.status, "completed"); assert.equal(run.output, "Found it");
  // A second rejection (full prompt) is a real failure, and later-turn errors never retry.
  const twice = harness([rejected, rejected]);
  const failed = createRun({ description: "Find", prompt: "Find", subagent_type: "Explore" });
  await runAgent(failed, twice.ctx, new AbortController().signal, () => {}, { context });
  assert.equal(twice.requests(), 2); assert.equal(failed.status, "failed");
});
test("context capture keeps a whole-file prefix, marks truncation and falls back safely", async () => {
  const files = [{ path: "a", content: "日".repeat(100) }, { path: "b", content: "x".repeat(MAX_CONTEXT_BYTES) }, { path: "c", content: "small" }];
  const captured = captureContext(files, "/tmp")!;
  assert.deepEqual(captured.files, [files[0]]);
  assert.equal(captured.truncated, true);
  files[0].content = "changed";
  assert.notEqual(captured.files[0].content, files[0].content);
  const h = harness([message()]);
  await runAgent(createRun({ description: "Work", prompt: "Work", subagent_type: "Explore" }), h.ctx, new AbortController().signal, () => {}, { context: captured });
  assert.match((h.conversations[0][0] as { content: string }).content, /Project context truncated/);
  assert.equal(captureContext(undefined, "/tmp"), undefined);
  assert.equal(captureContext([{ path: "bad", content: null as never }], "/tmp"), undefined);
  for (const context of [captureContext([{ path: "a", content: "x".repeat(MAX_CONTEXT_BYTES) }], "/tmp"), captureContext([{ path: "a", content: "small" }], "/other")]) {
    const fallback = harness([message()]);
    await runAgent(createRun({ description: "Work", prompt: "Work", subagent_type: "Explore" }), fallback.ctx, new AbortController().signal, () => {}, { context });
    assert.match((fallback.conversations[0][0] as { content: string }).content, /Follow parent permissions/);
  }
});
test("child write/edit conflict results name another child or main without executing", async () => {
  for (const owner of ["main", "child"] as const) {
    for (const tool of ["edit", "write"]) {
      const locks = new FileLocks();
      const holder = createRun({ description: "Holder", prompt: "Holder" });
      const run = createRun({ description: "Writer", prompt: "Writer" });
      locks.start(holder, "holder"); locks.start(run, "writer");
      if (owner === "main") { locks.mainCall("m", "/tmp/shared.ts"); locks.mainEnd("m", false); }
      else locks.claim(holder, "/tmp/shared.ts");
      let executed = 0;
      const h = harness([toolCalls([tool, { path: "@shared.ts" }]), message("Conflict reported")], () => { executed++; });
      await runAgent(run, h.ctx, new AbortController().signal, () => {}, { locks });
      assert.equal(executed, 0);
      const result = h.conversations[1].find(m => m.role === "toolResult");
      assert.ok(result?.role === "toolResult" && result.isError);
      if (result?.role === "toolResult" && result.content[0].type === "text") {
        assert.match(result.content[0].text, owner === "main" ? /locked by main/ : /background agent holder/);
        assert.match(result.content[0].text, /report the conflict instead of retrying/);
      }
    }
  }
});
test("budget wrap-up failure preserves budget error; abort skips wrap-up", async () => {
  for (const failure of ["error", "throw", "empty"] as const) {
    const first = message("", "read"); first.usage.output = 12000;
    const last = failure === "empty" ? message("") : { ...message(), stopReason: "error" as const, errorMessage: "Wrap-up failed" };
    const h = harness([first, last]);
    if (failure === "throw") {
      const original = h.ctx.modelRegistry.streamSimple.bind(h.ctx.modelRegistry);
      h.ctx.modelRegistry.streamSimple = ((...args: Parameters<typeof original>) => {
        if (args[2]?.toolChoice === "none") throw new Error("Transport failed");
        return original(...args);
      }) as typeof original;
    }
    const run = createRun({ description: "Work", prompt: "Work" });
    await runAgent(run, h.ctx, new AbortController().signal, () => {});
    assert.equal(run.status, "failed");
    assert.match(run.error!, /Budget reached.*output budget/);
    assert.equal(run.output, "");
  }
  const first = message("", "read"); first.usage.output = 12000;
  const h = harness([first]);
  const controller = new AbortController();
  const run = createRun({ description: "Work", prompt: "Work" });
  await runAgent(run, h.ctx, controller.signal, () => { if (run.usage.output) controller.abort(); });
  assert.equal(run.status, "aborted"); assert.equal(run.error, "Interrupted");
  assert.equal(h.requests(), 1);
  assert.ok(h.choices.every(choice => choice.options.toolChoice !== "none"));
});
test("output truncation handles multibyte text", () => {
  assert.equal(cap("短い文"), "短い文");
  const output = cap("日".repeat(500), 10);
  assert.ok(output.endsWith("[Output truncated]"));
  assert.ok(!output.includes("�"));
});
