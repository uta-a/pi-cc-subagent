import { test } from "node:test";
import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import { choosePolicy, LIMITS, taskProfile } from "../src/policy.ts";
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
test("non-reasoning models disable effort and quick tasks have tighter limits", () => {
  const fixed = model("plain", "test", false);
  assert.equal(choosePolicy(task({ effort: "high" }), fixed, [fixed]).effort, "off");
  assert.ok(LIMITS.quick.turns < LIMITS.balanced.turns && LIMITS.balanced.turns < LIMITS.deep.turns);
  assert.ok(LIMITS.quick.toolUses < LIMITS.deep.toolUses);
  assert.ok(LIMITS.quick.output < LIMITS.deep.output);
});
