import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, response, flush, model } from "./helpers.ts";
import { FIELD_DESCRIPTIONS, AGENT_PROMPT, SEND_PROMPT } from "../src/cc-texts.ts";
import { settings } from "../src/settings.ts";

test("registers exactly Agent, SendMessage and TaskStop; Agent schema is CC's subset", () => {
  const h = harness(); assert.deepEqual([...h.tools.keys()], ["Agent", "SendMessage", "TaskStop"]);
  const tool = h.tools.get("Agent")!;
  assert.deepEqual(Object.keys(tool.parameters.properties), ["description", "prompt", "subagent_type", "model", "effort", "run_in_background", "name"]);
  assert.deepEqual(tool.parameters.required, ["description", "prompt"]);
  for (const [name, description] of Object.entries(FIELD_DESCRIPTIONS)) assert.equal((tool.parameters.properties[name] as { description: string }).description, description);
  assert.notEqual(tool.executionMode, "sequential");
  assert.equal(tool.description, AGENT_PROMPT); assert.match(tool.description, /Branch ship-readiness audit/);
  assert.match(tool.description, /read for a known path/); assert.match(tool.description, /grep tool for a specific symbol/);
  assert.equal(h.tools.get("SendMessage")!.description, SEND_PROMPT); assert.doesNotMatch(SEND_PROMPT, /\| `"main"`/); h.shutdown();
});
test("before_agent_start injects deterministic agent types and actual Pi tools every turn", () => {
  const h = harness(); const first = h.before().systemPrompt;
  assert.match(first, /<system-reminder>\nAvailable agent types for the Agent tool:/);
  assert.match(first, /- Explore: Fast read-only search agent/);
  const explore = first.split("\n").find(line => line.startsWith("- Explore:"))!;
  assert.match(explore, /Tools: All tools except write, edit/);
  assert.match(first, /- general-purpose:.*\(Tools: All tools\)/);
  assert.equal(h.before().systemPrompt, first);
  // Uses a prompt section (forwarded by pi-claude-bridge); replaces the prompt only when sections are unavailable.
  assert.equal(h.before().replaced, false);
  const fallback = h.before(undefined, false); assert.equal(fallback.replaced, true); assert.match(fallback.systemPrompt, /<system-reminder>\nAvailable agent types/); h.shutdown();
});
test("agent listing shows the provider/model each agent would run on", () => {
  const h = harness();
  h.available([model("claude-opus-4-6"), model("claude-haiku-5-5", "other"), model("gpt-6-luna", "openai-codex")]);
  const line = (prompt: string, name: string) => prompt.split("\n").find(l => l.startsWith(`- ${name}:`))!;
  assert.match(line(h.before().systemPrompt, "Explore"), /\(Tools: [^)]*\) \(Model: test\/claude-opus-4-6\)$/);
  h.config({ defaultModel: "openai-codex/gpt-6-luna" });
  assert.match(line(h.before().systemPrompt, "general-purpose"), /\(Model: openai-codex\/gpt-6-luna\)$/);
  h.config({ defaultModel: "haiku" });
  assert.match(line(h.before().systemPrompt, "Plan"), /\(Model: other\/claude-haiku-5-5\)$/);
  h.config({ defaultModel: "missing/model" });
  assert.match(line(h.before().systemPrompt, "Plan"), /\(Model: unavailable \(missing\/model\)\)$/);
  h.config({ autoModel: true });
  assert.match(line(h.before().systemPrompt, "Plan"), /\(Model: auto \(chosen per task\)\)$/); h.shutdown();
});
test("unknown subagent_type errors list active definitions without launching", async () => {
  const h = harness(); await assert.rejects(h.agent({ subagent_type: "unknown" }), /Available types: general-purpose, Explore, Plan/);
  assert.equal(h.pending.length, 0); h.shutdown();
});
test("duplicate provider call IDs keep concurrent foreground UI rows independent", async () => {
  const h = harness(); const a = h.agent({ run_in_background: false, subagent_type: "Explore" }); const b = h.agent({ run_in_background: false, subagent_type: "Explore" });
  assert.match(h.writes.at(-1)!, /Explore-2/); h.pending[0].resolve(response()); await a;
  assert.match(h.writes.at(-1)!, /Explore-2/); h.pending[1].resolve(response()); await b;
  assert.equal(h.writes.at(-1), undefined); h.shutdown();
});
test("footer ticks do not resend full snapshots, final status is flushed", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] }); const h = harness(); let updates = 0;
  const call = h.agent({ run_in_background: false }, undefined, () => { updates++; }); const before = updates;
  t.mock.timers.tick(5000); assert.equal(updates, before); h.pending[0].resolve(response()); await call;
  assert.ok(updates > before); h.shutdown();
});
test("demo expires, supports off, rejects busy mode and clears before real work", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] }); const h = harness(); const demo = h.commands.get("cc-subagent-status-demo")!;
  await demo("", h.ctx); assert.match(h.writes.at(-1)!, /Explore  ホームの git リポジトリ概要調査/);
  t.mock.timers.tick(10000); assert.equal(h.writes.at(-1), undefined);
  await demo("", h.ctx); await demo("off", h.ctx); assert.equal(h.writes.at(-1), undefined);
  await demo("", h.ctx); h.before(); assert.equal(h.writes.at(-1), undefined);
  await demo("", h.ctx); await h.agent({ name: "worker" }); assert.match(h.writes.at(-1)!, /worker  Find code/);
  await demo("", h.ctx); assert.match(h.notices.at(-1)!, /unavailable/); h.pending[0].resolve(response()); await flush();
  h.busy(); await demo("", h.ctx); assert.match(h.notices.at(-1)!, /unavailable/); h.shutdown();
});
test("indirect nested orchestration is blocked too, without blocking main's own tools", async () => {
  const h = harness(); await h.agent();
  for (const toolName of ["Agent", "SendMessage", "TaskStop"]) {
    const event = { toolName, toolCallId: "same-id/1/1", parentToolCallId: "same-id/1", input: {} };
    assert.deepEqual(h.events.get("tool_call")!(event, h.ctx), { block: true, reason: "Subagents cannot call Agent, SendMessage or TaskStop." });
    assert.equal(h.events.get("tool_call")!({ ...event, parentToolCallId: undefined }, h.ctx), undefined);
  }
  h.pending[0].resolve(response()); await flush(); h.shutdown();
});
test("SendMessage/TaskStop compact renderers preserve errors", () => {
  const h = harness();
  const send = h.tools.get("SendMessage")!, stop = h.tools.get("TaskStop")!;
  assert.equal(send.renderCall({ to: "worker", message: "first line\nsecond line" }, h.theme, {}).render(200).join("\n").trimEnd(), "SendMessage → worker: first line");
  assert.equal(stop.renderCall({ task_id: "worker" }, h.theme, {}).render(200).join("\n").trimEnd(), "Stop Task worker");
  const failed = { content: [{ type: "text" as const, text: "Agent not found" }] };
  assert.match(send.renderResult(failed, { expanded: false }, h.theme, { keyHint: () => "", isError: true }).render(200).join("\\n"), /Agent not found/); h.shutdown();
});

test("settings validate types with honest defaults and are re-read each call", async () => {
  const h = harness(); h.config({ maxConcurrent: -2, defaultModel: 3, budgets: true, autoModel: "yes", resultFiles: 1, fileLocks: "no" });
  assert.deepEqual(settings(h.pi), { maxConcurrent: 20, defaultModel: undefined, budgets: "off", autoModel: false, resultFiles: false, fileLocks: true });
  h.config({ maxConcurrent: 1 }); await h.agent(); await assert.rejects(h.agent(), /run 1 subagents/);
  h.config({ maxConcurrent: 2 }); await h.agent(); assert.equal(h.pending.length, 2);
  for (const pending of h.pending) pending.resolve(response()); await flush(); h.shutdown();
});
