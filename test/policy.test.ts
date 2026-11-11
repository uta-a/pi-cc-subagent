import { test } from "node:test";
import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import { choosePolicy, LIMITS, taskProfile, resolveModel, resolvePolicy } from "../src/policy.ts";
import { builtins } from "../src/definitions.ts";
import { harness, response, flush } from "./helpers.ts";
import type { Task } from "../src/state.ts";

const model = (id: string, provider = "test", reasoning = true) => ({ id, provider, reasoning, maxTokens: 32768 } as Model<Api>);
const task = (extra: Partial<Task> = {}): Task => ({ description: "task", prompt: "task", ...extra });
const haiku = model("claude-haiku-5-5"), sonnet = model("claude-sonnet-5-5"), opus = model("claude-opus-5-5");

test("task classification uses intent without an extra model call", () => {
  assert.equal(taskProfile(task({ subagent_type: "Explore" })), "quick");
  assert.equal(taskProfile(task({ subagent_type: "Plan" })), "deep");
  assert.equal(taskProfile(task()), "balanced");
  assert.equal(taskProfile(task({ prompt: "review race conditions" })), "deep");
  assert.equal(taskProfile(task({ prompt: "rename a typo" })), "quick");
  assert.equal(taskProfile(task({ profile: "balanced", subagent_type: "Plan" })), "balanced");
});
test("model and effort adapt to exploration, implementation and hard design", () => {
  const available = [opus, sonnet, haiku];
  const quick = choosePolicy(task({ subagent_type: "Explore" }), opus, available);
  assert.equal(quick.model, haiku); assert.equal(quick.effort, "minimal");
  const balanced = choosePolicy(task(), opus, available);
  assert.equal(balanced.model, sonnet); assert.equal(balanced.effort, "low");
  const deep = choosePolicy(task({ subagent_type: "Plan" }), sonnet, available);
  assert.equal(deep.model, opus); assert.equal(deep.effort, "medium");
});
test("routing prefers the current provider and current-generation IDs", () => {
  const old = model("claude-haiku-4-5"), other = model("claude-haiku-5-5", "other");
  assert.equal(choosePolicy(task({ profile: "quick" }), opus, [other, old, haiku]).model, haiku);
});
test("explicit model and effort overrides are honored without silent fallback", () => {
  const policy = choosePolicy(task({ model: "test/claude-opus-5-5", effort: "high" }), sonnet, [opus, sonnet]);
  assert.equal(policy.model, opus); assert.equal(policy.effort, "high");
  assert.throws(() => choosePolicy(task({ model: "missing/no-model" }), sonnet, [sonnet]), /unavailable/);
  assert.throws(() => choosePolicy(task({ model: opus.id }), sonnet, [opus, model(opus.id, "other")]), /ambiguous/);
});
test("inherit and unavailable cheap tiers keep the parent, not invented model names", () => {
  assert.equal(choosePolicy(task({ model: "inherit", profile: "quick" }), opus, [haiku, opus]).model, opus);
  const gpt = model("gpt-6.1-sol", "openai-codex");
  assert.equal(choosePolicy(task(), gpt, [gpt, opus, sonnet]).model, gpt);
  assert.equal(choosePolicy(task({ profile: "quick" }), gpt, [gpt]).model, gpt);
});
test("aliases prefer parent provider, then anthropic, then others, newest numeric ID within provider", () => {
  const old = model("claude-sonnet-4-9"), newer = model("claude-sonnet-4-10"), anth = model("claude-sonnet-5", "anthropic"), other = model("claude-sonnet-9", "other");
  assert.equal(resolveModel("sonnet", opus, [other, anth, old, newer]), newer);
  assert.equal(resolveModel("sonnet", opus, [other, anth]), anth);
  assert.equal(resolveModel("sonnet", opus, [other]), other);
  for (const alias of ["opus", "haiku", "fable"]) {
    const candidate = model(`claude-${alias}-4`); assert.equal(resolveModel(alias, sonnet, [candidate]), candidate);
  }
  assert.throws(() => resolveModel("fable", opus, [opus]), /unavailable/);
  assert.throws(() => resolveModel("missing/id", opus, [opus]), /unavailable/);
  assert.equal(resolveModel("test/claude-opus-5-5", sonnet, [opus]), opus);
  assert.equal(resolveModel(opus.id, sonnet, [opus]), opus);
});
test("model precedence and effort inheritance are independent of old routing unless opted in", () => {
  const config = { maxConcurrent: 20, budgets: "off" as const, autoModel: false, resultFiles: false, fileLocks: true };
  const def = builtins()[0], available = [opus, sonnet, haiku];
  const policy = (extra: Partial<Task> = {}, definition = def, settings = config) => resolvePolicy(task(extra), definition, settings, opus, available, "xhigh");
  assert.equal(policy().model, opus); assert.equal(policy().effort, "xhigh"); assert.equal(policy().limits, undefined);
  assert.equal(policy({}, def, { ...config, defaultModel: "haiku" } as typeof config).model, haiku);
  assert.equal(policy({}, { ...def, model: "sonnet" }, { ...config, defaultModel: "haiku" } as typeof config).model, sonnet);
  assert.equal(policy({ model: "haiku" }, { ...def, model: "sonnet" }).model, haiku);
  assert.equal(policy({}, { ...def, effort: "max" }).effort, "max"); assert.equal(policy({ effort: "low" }, { ...def, effort: "max" }).effort, "low");
  assert.equal(policy({}, { ...def, effort: 7 }).effort, "xhigh");
  assert.equal(policy({ subagent_type: "Explore" }, def, { ...config, autoModel: true }).model, haiku);
  assert.equal(policy({ model: "sonnet", subagent_type: "Explore" }, def, { ...config, autoModel: true }).model, sonnet);
});
test("Agent inherits Pi thinking level, supports CC effort levels and rejects unresolved aliases before launch", async () => {
  for (const effort of [undefined, "low", "medium", "high", "xhigh", "max"]) {
    const h = harness(); h.thinking("xhigh"); await h.agent({ effort });
    assert.equal(h.choices[0].reasoning, effort ?? "xhigh"); h.pending[0].resolve(response()); await flush(); h.shutdown();
  }
  const h = harness(); await assert.rejects(h.agent({ model: "fable" }), /unavailable/); assert.equal(h.pending.length, 0);
  h.ctx.model!.reasoning = false; await h.agent({ effort: "max" }); assert.equal(h.choices[0].reasoning, undefined);
  h.pending[0].resolve(response()); await flush(); h.shutdown();
});
test("settings defaultModel/autoModel select models only when enabled", async () => {
  for (const autoModel of [false, true]) {
    const h = harness(); h.available([h.ctx.model!, haiku]); h.config({ autoModel }); await h.agent({ subagent_type: "Explore" });
    assert.equal(h.models[0], autoModel ? haiku : h.ctx.model); h.pending[0].resolve(response()); await flush(); h.shutdown();
  }
  const h = harness(); h.available([h.ctx.model!, sonnet]); h.config({ defaultModel: "test/claude-sonnet-5-5" }); await h.agent();
  assert.equal(h.models[0], sonnet); h.pending[0].resolve(response()); await flush(); h.shutdown();
});

test("non-reasoning models disable effort and quick tasks have tighter limits", () => {
  const fixed = model("plain", "test", false);
  assert.equal(choosePolicy(task({ effort: "high" }), fixed, [fixed]).effort, "off");
  assert.ok(LIMITS.quick.turns < LIMITS.balanced.turns && LIMITS.balanced.turns < LIMITS.deep.turns);
  assert.ok(LIMITS.quick.toolUses < LIMITS.deep.toolUses);
  assert.ok(LIMITS.quick.output < LIMITS.deep.output);
});
