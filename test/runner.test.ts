import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message, SimpleStreamOptions, Api, Model } from "@earendil-works/pi-ai";
import { createRun, emptyUsage } from "../src/state.ts";
import { cap, MAX_TURNS, pooled, runAgent } from "../src/runner.ts";

function message(text = "Found it", tool?: string): AssistantMessage {
  return {
    role: "assistant", content: tool ? [{ type: "toolCall", id: "t1", name: tool, arguments: { path: "src/auth.ts" } }] : [{ type: "text", text }],
    api: "anthropic-messages", model: "test", provider: "test", usage: { ...emptyUsage(), input: 100, output: 10, totalTokens: 110 },
    stopReason: tool ? "toolUse" : "stop", timestamp: Date.now(),
  };
}
function harness(responses: AssistantMessage[], execute?: (name: string) => void) {
  let requests = 0;
  const conversations: Message[][] = [];
  const choices: { model: unknown; options: SimpleStreamOptions }[] = [];
  const ctx = {
    model: { id: "test", provider: "test" }, thinkingLevel: "off", cwd: "/tmp",
    tools: ["read", "bash", "cc_subagent"].map(name => ({ name, parameters: {}, description: name })),
    getSystemPrompt: () => "Follow parent permissions",
    modelRegistry: { streamSimple(model: unknown, context: { messages: Message[] }, options: SimpleStreamOptions) {
      choices.push({ model, options });
      conversations.push(structuredClone(context.messages));
      const response = responses[Math.min(requests++, responses.length - 1)];
      return { async *[Symbol.asyncIterator]() {}, result: async () => response };
    } },
    executeTool: async (name: string) => {
      execute?.(name);
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
test("cumulative output budget prevents another model request", async () => {
  const first = message("", "read"); first.usage.output = 12000;
  const h = harness([first]);
  const run = createRun({ description: "Work", prompt: "Work" });
  await runAgent(run, h.ctx, new AbortController().signal, () => {});
  assert.equal(h.requests(), 1); assert.equal(run.status, "failed"); assert.match(run.error!, /output budget/);
});
test("tool-call budget bounds oversized batches without an automatic retry", async () => {
  const batch = message("", "read");
  batch.content = Array.from({ length: 30 }, (_, i) => ({ type: "toolCall" as const, id: `t${i}`, name: "read", arguments: { path: "file.ts" } }));
  let calls = 0;
  const h = harness([batch], () => { calls++; });
  const run = createRun({ description: "Work", prompt: "Work" });
  await runAgent(run, h.ctx, new AbortController().signal, () => {});
  assert.equal(calls, 24); assert.equal(h.requests(), 1); assert.equal(run.status, "failed");
  assert.match(run.error!, /tool budget/);
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
  const h = harness([message("", "read")]);
  const run = createRun({ description: "Loop", prompt: "Loop" });
  await runAgent(run, h.ctx, new AbortController().signal, () => {});
  assert.equal(run.status, "failed");
  assert.equal(h.requests(), MAX_TURNS);
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
test("output truncation handles multibyte text", () => {
  assert.equal(cap("短い文"), "短い文");
  const output = cap("日".repeat(500), 10);
  assert.ok(output.endsWith("[Output truncated]"));
  assert.ok(!output.includes("�"));
});
