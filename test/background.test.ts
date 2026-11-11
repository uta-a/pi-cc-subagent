import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { capacityError, RESULT_MESSAGE_TYPE } from "../src/background.ts";
import { emptyUsage, type Details } from "../src/state.ts";
import { harness, response, flush } from "./helpers.ts";

const idOf = (result: { details?: Details }) => result.details!.runs[0].id;
const textOf = (h: ReturnType<typeof harness>, index = 0) => String(h.sent[index].message.content);

test("background is default; each call has a cryptographic ID, frozen receipt and one followUp", async () => {
  const h = harness();
  const a = await h.agent({ name: "researcher" }), b = await h.agent({ subagent_type: "Plan" });
  assert.match(idOf(a), /^a[0-9a-f]{16}$/); assert.notEqual(idOf(a), idOf(b));
  assert.equal(h.pending.length, 2); assert.equal(a.usage, undefined);
  assert.equal(a.content[0].text, `Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: ${idOf(a)} (internal ID - do not mention to user. Use SendMessage with to: '${idOf(a)}', summary: '<5-10 word recap>' to continue this agent.)\nThe agent is working in the background. You will be notified automatically when it completes. You know nothing about its results until that notification arrives — do not report, assume, or predict them; continue other work or respond to the user in the meantime.\nIn your own words, briefly tell the user what you launched — do not echo this tool result. Agent results will arrive in a subsequent message. If the user asks for progress, say the agent is still running.`);
  h.pending[1].resolve(response("Plan answer")); await flush();
  assert.equal(h.sent.length, 1); assert.match(textOf(h), /<result>Plan answer<\/result>/);
  h.pending[0].resolve(response("Code answer")); await flush();
  assert.equal(h.sent.length, 2); assert.equal(a.details!.runs[0].status, "running");
  assert.deepEqual(h.sent[0].options, { deliverAs: "followUp", triggerTurn: true });
  assert.equal(h.sent[0].message.customType, RESULT_MESSAGE_TYPE); assert.equal(h.sent[0].message.display, true);
  assert.match(textOf(h), /^<system-reminder>\n\[SYSTEM NOTIFICATION - NOT USER INPUT\]/);
  assert.match(textOf(h), /<status>completed<\/status>\n<summary>Agent "Find code" finished<\/summary>/);
  assert.match(textOf(h), /<subagent_tokens>110<\/subagent_tokens>/); assert.equal(h.writes.at(-1), undefined);
  h.shutdown();
});

test("false waits and foreground formats include usage except Explore/Plan", async () => {
  for (const type of ["general-purpose", "Explore", "Plan"]) {
    const h = harness(); let settled = false;
    const call = h.agent({ subagent_type: type, run_in_background: false }).then(result => { settled = true; return result; });
    await flush(); assert.equal(settled, false);
    h.pending[0].resolve(response("answer")); const result = await call;
    if (type !== "general-purpose") assert.equal(result.content[0].text, "answer");
    else assert.match(result.content[0].text, new RegExp(`^answer\\nagentId: ${idOf(result)} .*\\n<usage>subagent_tokens: 110\\ntool_uses: 0\\nduration_ms: \\d+</usage>$`));
    assert.equal(result.usage!.totalTokens, 110); assert.equal(h.sent.length, 0); h.shutdown();
  }
});
test("empty output completes with CC placeholder; foreground errors retain partial text", async () => {
  for (const failed of [false, true]) {
    const h = harness(); const call = h.agent({ run_in_background: false });
    h.pending[0].resolve(failed ? { ...response("partial"), stopReason: "error", errorMessage: "Unavailable" } : response(""));
    const result = await call;
    assert.match(result.content[0].text, failed ? /^Unavailable\n\npartial$/ : /^\(Subagent completed but returned no output\.\)\nagentId:/);
    assert.equal(result.isError, failed); h.shutdown();
  }
});
test("background resume cannot mutate the original foreground usage receipt", async () => {
  const h = harness(); const call = h.agent({ run_in_background: false }); h.pending[0].resolve(response()); const result = await call;
  await h.call("SendMessage", { to: idOf(result), message: "continue" }); h.pending[1].resolve(response()); await flush();
  assert.equal(result.usage!.totalTokens, 110); assert.equal((h.sent[0].message.details as Details).runs[0].usage.totalTokens, 220); h.shutdown();
});

test("cap 20 counts simultaneous foreground/background calls without writer cap or foreground fallback", async () => {
  const h = harness();
  const foreground = h.agent({ run_in_background: false });
  const launches = await Promise.all(Array.from({ length: 19 }, () => h.agent()));
  assert.equal(h.pending.length, 20);
  await assert.rejects(h.agent(), { message: capacityError(20) });
  await assert.rejects(h.agent({ run_in_background: false }), { message: capacityError(20) });
  h.pending[0].resolve(response()); await foreground;
  await h.agent(); assert.equal(h.pending.length, 21);
  assert.equal(new Set(launches.map(idOf)).size, 19);
  for (const pending of h.pending) pending.resolve(response()); await flush(); h.shutdown();
});
test("setting cap counts resumed agents too and rejects before appending a resume message", async () => {
  const h = harness(); h.config({ maxConcurrent: 1 });
  const first = await h.agent(); h.pending[0].resolve(response()); await flush();
  const second = await h.agent();
  await assert.rejects(h.call("SendMessage", { to: idOf(first), message: "blocked" }), { message: capacityError(1) });
  h.pending[1].resolve(response()); await flush();
  await h.call("SendMessage", { to: idOf(first), message: "resume" });
  await assert.rejects(h.agent(), { message: capacityError(1) });
  assert.doesNotMatch(JSON.stringify(h.conversations[2]), /blocked/);
  h.pending[2].resolve(response()); await flush(); assert.notEqual(idOf(first), idOf(second)); h.shutdown();
});
test("SendMessage queues user messages after the current tool round, before the next request", async () => {
  const h = harness(); const launched = await h.agent({ name: "worker" });
  const sent = await h.call("SendMessage", { to: "worker", message: "course correction" });
  assert.deepEqual(JSON.parse(sent.content[0].text), { success: true, message: 'Agent "worker" is already running; queued your message for its next turn.' });
  h.pending[0].resolve(response("", "read")); await flush();
  assert.equal(h.nested.length, 1);
  assert.equal(h.conversations[1].at(-2)!.role, "toolResult");
  assert.deepEqual(h.conversations[1].at(-1), { role: "user", content: "course correction", timestamp: h.conversations[1].at(-1)!.timestamp });
  h.pending[1].resolve(response("fixed")); await flush();
  assert.match(textOf(h), new RegExp(`<task-id>${idOf(launched)}</task-id>`)); h.shutdown();
});
test("queued messages are not lost when the current model response has no tools", async () => {
  const h = harness(); const launch = await h.agent();
  await h.call("SendMessage", { to: idOf(launch), message: "one more thing" });
  h.pending[0].resolve(response()); await flush(); assert.equal(h.pending.length, 2); assert.equal(h.sent.length, 0);
  h.pending[1].resolve(response()); await flush(); assert.equal(h.sent.length, 1); h.shutdown();
});
test("SendMessage resumes completed/failed/stopped transcripts with same ID and a new notification", async () => {
  for (const state of ["completed", "failed", "killed"]) {
    const h = harness(); const launch = await h.agent({ name: "worker" });
    if (state === "killed") await h.call("TaskStop", { task_id: "worker" });
    h.pending[0].resolve(state === "failed" ? { ...response("partial"), stopReason: "error", errorMessage: "Error" } : response("previous answer")); await flush();
    const result = await h.call("SendMessage", { to: "worker", message: "continue", summary: "recap" });
    assert.deepEqual(JSON.parse(result.content[0].text), { success: true, message: 'Agent "worker" resumed in the background; you will be notified when it completes.' });
    assert.equal(h.conversations[1].at(-1)!.role, "user"); assert.equal(h.conversations[1].at(-1)!.content, "continue");
    assert.ok(h.conversations[1].length >= h.conversations[0].length + 1);
    if (state === "completed") assert.match(JSON.stringify(h.conversations[1]), /previous answer/);
    h.pending[1].resolve(response("new answer")); await flush(); assert.equal(h.sent.length, 2);
    assert.match(textOf(h, 1), new RegExp(`<task-id>${idOf(launch)}</task-id>`));
    assert.equal((h.sent[1].message.details as Details).runs[0].id, idOf(launch)); h.shutdown();
  }
});
test("names resolve latest-wins, while raw IDs still address the older agent", async () => {
  const h = harness(); const a = await h.agent({ name: "same" }), b = await h.agent({ name: "same" });
  await h.call("SendMessage", { to: "same", message: "newest" });
  await h.call("SendMessage", { to: idOf(a), message: "oldest" });
  for (const pending of h.pending.slice()) pending.resolve(response("", "read")); await flush();
  assert.equal(h.conversations[2].at(-1)!.content, "oldest"); assert.equal(h.conversations[3].at(-1)!.content, "newest");
  assert.notEqual(idOf(a), idOf(b));
  for (const pending of h.pending) pending.resolve(response()); await flush(); h.shutdown();
});
test("SendMessage unknown and broadcast errors are exact", async () => {
  const h = harness();
  await assert.rejects(h.call("SendMessage", { to: "missing", message: "x" }), { message: 'Agent "missing" not found' });
  await assert.rejects(h.call("SendMessage", { to: "*", message: "x" }), { message: 'broadcast (to: "*") is no longer supported — send a message per recipient' }); h.shutdown();
});
test("TaskStop by ID/name/shell alias returns JSON and exactly one killed notification", async () => {
  for (const mode of ["id", "name", "shell"]) {
    const h = harness(); const launch = await h.agent({ name: "worker" });
    const result = await h.call("TaskStop", mode === "shell" ? { shell_id: idOf(launch) } : { task_id: mode === "id" ? idOf(launch) : "worker" });
    assert.deepEqual(JSON.parse(result.content[0].text), { message: `Successfully stopped task: ${idOf(launch)} (Find code)`, task_id: idOf(launch), task_type: "local_agent", command: "Find code" });
    assert.equal(h.pending[0].signal.aborted, true);
    h.pending[0].resolve(response()); await flush(); await flush(); assert.equal(h.sent.length, 1);
    assert.match(textOf(h), /<status>killed<\/status>\n<summary>Agent "Find code" was stopped<\/summary>/);
    await assert.rejects(h.call("TaskStop", { task_id: "worker" }), { message: "Task worker is not running (status: killed)" }); h.shutdown();
  }
});
test("TaskStop missing/not found/not running errors; commands stop by display label or all", async () => {
  const h = harness();
  await assert.rejects(h.call("TaskStop", {}), { message: "Missing required parameter: task_id" });
  await assert.rejects(h.call("TaskStop", { task_id: "missing" }), /not found/);
  const first = await h.agent({ subagent_type: "Explore" }); await h.agent({ subagent_type: "Explore" });
  await h.commands.get("cc-agents-stop")!("Explore-2", h.ctx); assert.equal(h.pending[1].signal.aborted, true);
  await h.commands.get("cc-agents-stop")!("", h.ctx); assert.equal(h.pending[0].signal.aborted, true);
  for (const p of h.pending) p.resolve(response()); await flush(); assert.equal(h.sent.length, 2);
  const third = await h.agent(); h.pending[2].resolve(response()); await flush();
  await assert.rejects(h.call("TaskStop", { task_id: idOf(third) }), { message: `Task ${idOf(third)} is not running (status: completed)` });
  assert.match(textOf(h), new RegExp(idOf(first))); h.shutdown();
});
test("background parent cancellation is isolated; foreground cancellation propagates", async () => {
  const h = harness(), parent = new AbortController();
  await h.agent({}, parent.signal);
  const foreground = h.agent({ run_in_background: false }, parent.signal);
  parent.abort(); assert.equal(h.pending[0].signal.aborted, false); assert.equal(h.pending[1].signal.aborted, true);
  h.pending[1].resolve(response()); assert.equal((await foreground).isError, true);
  h.pending[0].resolve(response()); await flush(); assert.equal(h.sent.length, 1); h.shutdown();
});
test("shutdown aborts work, clears registry and suppresses late notifications and UI callbacks", async () => {
  const h = harness(); await h.agent(); h.shutdown(); h.shutdown();
  const writes = h.writes.length;
  assert.equal(h.pending[0].signal.aborted, true); h.pending[0].resolve(response()); await flush();
  assert.equal(h.sent.length, 0); assert.equal(h.writes.length, writes);
  await assert.rejects(h.agent(), /shut down/);
});
test("failed XML, verbatim results and 100000-character caps preserve metadata", async () => {
  const h = harness(); await h.agent();
  h.pending[0].resolve({ ...response("<partial>&"), stopReason: "error", errorMessage: "Unavailable" }); await flush();
  assert.match(textOf(h), /<status>failed<\/status>\n<summary>Agent "Find code" failed: Unavailable<\/summary>/);
  assert.match(textOf(h), /<result><partial>&<\/result>/);
  await h.agent(); h.pending[1].resolve(response("x".repeat(120000))); await flush();
  assert.ok(textOf(h, 1).length <= 100000); assert.match(textOf(h, 1), /<\/system-reminder>$/);
  const call = h.agent({ run_in_background: false }); h.pending[2].resolve(response("x".repeat(120000)));
  const result = await call; assert.equal(result.content[0].text.length, 100000); assert.match(result.content[0].text, /agentId:.*\n<usage>/); h.shutdown();
});
test("XML truncation keeps closing tags intact", async () => {
  const h = harness(); await h.agent(); h.pending[0].resolve(response("<&>".repeat(50000))); await flush();
  const text = textOf(h); assert.ok(text.length <= 100000); assert.match(text, /\[Output truncated\]<\/result>/);
  assert.match(text, /<\/result>\n<usage>/); assert.match(text, /<\/system-reminder>$/); h.shutdown();
});
test("resume re-reads budget settings without changing its original model or effort", async () => {
  const h = harness(); const launch = await h.agent(); h.pending[0].resolve(response()); await flush();
  h.config({ budgets: "quick" }); await h.call("SendMessage", { to: idOf(launch), message: "continue" });
  assert.equal(h.choices[1].maxTokens, 2048); assert.equal(h.models[1], h.models[0]);
  h.pending[1].resolve(response()); await flush();
  h.config({ budgets: "off" }); await h.call("SendMessage", { to: idOf(launch), message: "continue again" });
  assert.equal("maxTokens" in h.choices[2], false); h.pending[2].resolve(response()); await flush(); h.shutdown();
});

test("message renderer uses Done/Prompt/Response, never raw XML; launch renderer is a receipt", async () => {
  const h = harness(); const launch = await h.agent({ name: "worker" });
  const rendered = h.tools.get("Agent")!.renderResult(launch, { expanded: false }, h.theme, { keyHint: () => "" }).render(200).join("\n");
  assert.match(rendered, /Agent launched: worker/); assert.doesNotMatch(rendered, /Running|agentId/);
  h.pending[0].resolve(response("Final answer")); await flush();
  const renderer = h.renderers.get(RESULT_MESSAGE_TYPE)!;
  const message = { ...h.sent[0].message, role: "custom" as const, timestamp: Date.now() };
  const view = (expanded: boolean) => renderer(message, { expanded, outputPad: 0, keyHint: () => "custom-key to expand", keyText: () => "custom-key" }, h.theme)!.render(200).join("\n");
  assert.match(view(false), /Done \(0 tool uses · 110 tokens/); assert.doesNotMatch(view(false), /task-notification|Final answer/);
  assert.match(view(true), /Final answer/); assert.match(view(true), /Prompt:/); h.shutdown();
});
test("live background preview survives receipt and shows final status", async () => {
  const h = harness(); let preview!: Component & { handleInput(key: string): void; dispose(): void };
  h.ctx.ui.custom = ((factory: (tui: unknown, theme: Theme, keys: unknown, done: () => void) => typeof preview) => new Promise<void>(resolve => {
    preview = factory({ terminal: { rows: 40 }, requestRender() {} }, h.theme, { matches: () => false }, () => { preview.dispose(); resolve(); });
  })) as typeof h.ctx.ui.custom;
  await h.agent({ name: "researcher" }); const open = h.commands.get("cc-agents")!("", h.ctx);
  assert.match(preview.render(200).join("\n"), /researcher — live activity/);
  h.pending[0].resolve(response("Final findings")); await flush();
  assert.match(preview.render(200).join("\n"), /Status: completed/); assert.match(preview.render(200).join("\n"), /Final findings/);
  preview.handleInput("\r"); await open; h.shutdown();
});
test("result files are opt-in in foreground/background, restrictive and removed at shutdown", async t => {
  const dir = fs.mkdtempSync(join(process.cwd(), ".test-results-"));
  t.mock.method(os, "tmpdir", () => dir); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const resultFiles of [false, true]) for (const background of [false, true]) {
    const h = harness(); h.config({ resultFiles });
    const call = h.agent({ run_in_background: background }); h.pending[0].resolve(response("HEAD" + "x".repeat(60000)));
    const result = await call; await flush(); const text = background ? textOf(h) : result.content[0].text;
    if (resultFiles) {
      const path = text.match(/saved to: (.+) —/)![1]; assert.equal(fs.readFileSync(path, "utf8").length, 60004);
      assert.equal(fs.statSync(path).mode & 0o777, 0o600); assert.equal(fs.statSync(join(dir, "pi-cc-subagent")).mode & 0o777, 0o700);
      h.shutdown(); assert.equal(fs.existsSync(path), false);
    } else { assert.doesNotMatch(text, /saved to:/); assert.ok(text.length > 60000); h.shutdown(); }
  }
});
test("result-file failure falls back inline without losing the error", async t => {
  const dir = fs.mkdtempSync(join(process.cwd(), ".test-results-")); t.mock.method(os, "tmpdir", () => dir);
  t.mock.method(fs, "writeFileSync", () => { throw new Error("Disk full"); }); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = harness(); h.config({ resultFiles: true }); const call = h.agent({ run_in_background: false });
  h.pending[0].resolve({ ...response("x".repeat(60000)), stopReason: "error", errorMessage: "Error" });
  const result = await call; assert.match(result.content[0].text, /^Error/); assert.match(result.content[0].text, /Output truncated/); assert.doesNotMatch(result.content[0].text, /saved to:/); h.shutdown();
});
test("fileLocks default on, configurable off; foreground remains outside background locks", async () => {
  for (const fileLocks of [undefined, false]) {
    const h = harness(); h.config({ fileLocks }); await h.agent({ name: "writer" });
    h.pending[0].resolve(response("", "write")); await flush();
    const main = h.events.get("tool_call")!({ toolName: "edit", toolCallId: "main", input: { path: "shared.ts" } }, h.ctx);
    if (fileLocks === false) assert.equal(main, undefined); else assert.deepEqual(main, { block: true, reason: `${join(process.cwd(), "shared.ts")} is being modified by background agent writer; wait for its result message or stop it with /cc-agents-stop writer.` });
    h.pending[1].resolve(response()); await flush(); h.shutdown();
  }
});
test("zero-output first-request refusal retries once, later failure does not retry", async () => {
  const h = harness(); await h.agent(); const rejected = { ...response(""), stopReason: "error" as const, errorMessage: "prompt-capture: no capture", usage: emptyUsage() };
  h.pending[0].resolve(rejected); await flush();
  assert.equal(h.pending.length, 2); assert.match(String(h.conversations[1][0].content), /^PARENT SECRET SYSTEM/);
  h.pending[1].resolve(rejected); await flush(); assert.equal(h.pending.length, 2); assert.match(textOf(h), /failed/); h.shutdown();
});

test("a foreground result is frozen before its slot can be resumed", async () => {
  for (let steps = 0; steps < 12; steps++) {
    const h = harness(); const call = h.agent({ run_in_background: false }); h.pending[0].resolve(response("original answer"));
    for (let i = 0; i < steps; i++) await Promise.resolve();
    const result = await call;
    await h.call("SendMessage", { to: idOf(result), message: "continue" }).catch(() => undefined);
    assert.match(result.content[0].text, /^original answer\nagentId:/); assert.equal(result.isError, false); h.shutdown();
  }
});
test("SendMessage to a stopping agent is refused instead of silently queued", async () => {
  const h = harness(); const launch = await h.agent();
  await h.call("TaskStop", { task_id: idOf(launch) });
  await assert.rejects(h.call("SendMessage", { to: idOf(launch), message: "more" }), /still stopping/);
  // The mock stream ignores abort; a real provider ends it as aborted.
  h.pending[0].resolve({ ...response(), stopReason: "aborted" }); await flush(); assert.equal(h.sent.length, 1); assert.match(textOf(h), /<status>killed<\/status>/); h.shutdown();
});
test("TaskStop success always matches a killed notification, even right after completion", async () => {
  for (let steps = 0; steps < 12; steps++) {
    const h = harness(); const launch = await h.agent(); h.pending[0].resolve(response());
    for (let i = 0; i < steps; i++) await Promise.resolve();
    const stopped = await h.call("TaskStop", { task_id: idOf(launch) }).then(() => true, () => false);
    await flush(); assert.equal(h.sent.length, 1);
    assert.match(textOf(h), stopped ? /<status>killed<\/status>/ : /<status>completed<\/status>/); h.shutdown();
  }
});
test("main's nested write/edit (through its own wrapper tools) respects background writer locks", async () => {
  const h = harness(); await h.agent({ name: "writer" });
  h.pending[0].resolve(response("", "write")); await flush();
  const path = join(h.ctx.cwd, "shared.ts");
  const blocked = h.events.get("tool_call")!({ toolName: "edit", toolCallId: "wrap/1", parentToolCallId: "wrap", input: { path } }, h.ctx) as { block: boolean; reason: string };
  assert.equal(blocked.block, true); assert.match(blocked.reason, /background agent writer/);
  h.pending[1].resolve(response()); await flush(); h.shutdown();
});
test("non-string budgets settings are ignored", async () => {
  const h = harness(); h.config({ budgets: ["quick"] });
  const call = h.agent({ run_in_background: false }); h.pending[0].resolve(response()); await call;
  assert.equal("maxTokens" in h.choices[0], false); h.shutdown();
});
