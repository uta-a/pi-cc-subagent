import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { Definitions, builtins, childTools, parseDefinition } from "../src/definitions.ts";
import { userContext } from "../src/prompts.ts";
import { harness, flush, response, model } from "./helpers.ts";

function file(dir: string, name: string, text: string) {
  fs.mkdirSync(join(dir, ".claude/agents"), { recursive: true }); fs.writeFileSync(join(dir, ".claude/agents", `${name}.md`), text);
}
const definition = (name: string, fields = "", body = "Custom system prompt") => `---\nname: ${name}\ndescription: Custom definition\n${fields}---\n${body}\n`;

test("built-ins retain CC key sentences and omitClaudeMd restrictions", () => {
  const [general, explore, plan] = builtins();
  assert.match(general.description, /When you are searching for a keyword or file/);
  assert.match(general.prompt, /Complete the task fully—don't gold-plate, but don't leave it half-done/);
  assert.match(general.prompt, /NEVER proactively create documentation files/);
  assert.match(explore.description, /Do NOT use it for code review, design-doc auditing/);
  assert.match(explore.prompt, /You are a file search specialist for Claude Code/); assert.match(explore.prompt, /Use bash ONLY for read-only operations/);
  assert.match(plan.prompt, /### Critical Files for Implementation/); assert.match(plan.description, /Software architect agent/);
  assert.equal(explore.omitClaudeMd, true); assert.equal(plan.omitClaudeMd, true);
});
test("frontmatter accepts scalar, quoted/comma/inline/YAML lists, boolean and integer subset", () => {
  const def = parseDefinition(`---\nname: 'researcher'\ndescription: 'Line one\\nLine two'\ntools: Read, Grep, Bash\ndisallowedTools:\n  - Write\n  - 'MultiEdit'\nmodel: "sonnet"\neffort: xhigh\nmaxTurns: 3\nbackground: true\nomitClaudeMd: false\n---\n\n Custom body \n`);
  assert.equal(def.description, "Line one\nLine two"); assert.deepEqual(def.tools, ["Read", "Grep", "Bash"]);
  assert.deepEqual(def.disallowedTools, ["Write", "MultiEdit"]); assert.equal(def.model, "sonnet"); assert.equal(def.effort, "xhigh");
  assert.equal(def.maxTurns, 3); assert.equal(def.background, true); assert.equal(def.omitClaudeMd, false); assert.equal(def.prompt, "Custom body");
  assert.deepEqual(parseDefinition(definition("a", 'tools: ["Read", Grep, \'custom_fetch\']\n')).tools, ["Read", "Grep", "custom_fetch"]);
  assert.equal(parseDefinition(definition("a", "effort: 12\n")).effort, 12);
});
test("invalid frontmatter is rejected rather than widened into all-tools", () => {
  for (const text of ["body", "---\nname: a\n---\nbody", definition("-bad"), definition("bad:name"), definition("a", "tools: true\n"), definition("a", "maxTurns: 0\n"), definition("a", "background: yes\n"), definition("a", "effort: extreme\n"), definition("a", 'model: "bad\n')]) assert.throws(() => parseDefinition(text));
});
test("tool names map only core CC names, ignore unknowns and filter recursion/ask_user", () => {
  const tools = ["read", "grep", "find", "bash", "write", "edit", "ls", "custom_fetch", "Agent", "SendMessage", "TaskStop", "mcp_ask_user", "WebFetch"].map(name => ({ name, description: name, parameters: {} }));
  const def = parseDefinition(definition("a", "tools: Read, Grep, Glob, Bash, Write, MultiEdit, LS, NotebookEdit, CUSTOM_FETCH, WebSearch, Agent, SendMessage, TaskStop, mcp_ask_user\ndisallowedTools: Edit, Write\n"));
  assert.deepEqual(childTools(tools, def).map(t => t.name), ["read", "grep", "find", "bash", "ls", "custom_fetch"]);
  assert.deepEqual(childTools(tools, { ...def, tools: ["WebFetch"] }).map(t => t.name), ["WebFetch"]);
});
test("project overrides user overrides builtins; invalid files warn once per changed load", t => {
  const root = fs.mkdtempSync(join(process.cwd(), ".test-definitions-")), home = join(root, "home"), cwd = join(root, "project");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  file(home, "explore", definition("Explore", "", "User override")); file(cwd, "explore", definition("Explore", "", "Project override"));
  file(cwd, "bad", "invalid"); file(cwd, "integer", definition("integer", "effort: 5\n"));
  const loader = new Definitions(home), notices: string[] = [], warn = (text: string) => notices.push(text);
  let defs = loader.load(cwd, warn); assert.equal(defs.find(d => d.name === "Explore")!.prompt, "Project override");
  assert.equal(notices.length, 1); assert.match(notices[0], /bad.md/); assert.match(notices[0], /integer effort ignored/);
  loader.load(cwd, warn); assert.equal(notices.length, 1);
  fs.unlinkSync(join(cwd, ".claude/agents/explore.md")); defs = loader.load(cwd, warn);
  assert.equal(defs.find(d => d.name === "Explore")!.prompt, "User override"); assert.equal(notices.length, 2);
  file(cwd, "new", definition("new")); assert.ok(loader.load(cwd, warn).some(d => d.name === "new"));
});
test("context labels distinguish project and user instructions; omitClaudeMd keeps the date", () => {
  const def = builtins()[0], cwd = join(process.cwd(), "project");
  const context = { cwd, truncated: false, files: [{ path: join(cwd, "AGENTS.md"), content: "project" }, { path: join(os.homedir(), ".pi/agent/AGENTS.md"), content: "private" }] };
  const text = userContext(def, cwd, context); assert.match(text, /project instructions, checked into the codebase/); assert.match(text, /user's private global instructions for all projects/);
  const omitted = userContext({ ...def, omitClaudeMd: true }, cwd, context); assert.doesNotMatch(omitted, /claudeMd|private/); assert.match(omitted, /currentDate/);
});
test("custom background forces background, reloads on change, omitClaudeMd/effort/tools apply", async t => {
  const cwd = fs.mkdtempSync(join(process.cwd(), ".test-definitions-")); t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  file(cwd, "worker", definition("worker", "background: true\nomitClaudeMd: true\neffort: max\ntools: Bash, Read\n"));
  const h = harness(); Object.defineProperty(h.ctx, "cwd", { value: cwd });
  h.before([{ path: join(cwd, "AGENTS.md"), content: "SECRET CONTEXT" }]);
  const launch = await h.agent({ subagent_type: "worker", run_in_background: false }); assert.equal(launch.details!.background, true);
  assert.equal(h.choices[0].reasoning, "max"); assert.match(String(h.conversations[0][0].content), /^Custom system prompt/);
  assert.doesNotMatch(JSON.stringify(h.conversations[0][1]), /SECRET CONTEXT/);
  const first = h.conversations[0][0]; if (first.role === "system") assert.deepEqual(first.toolsAdded!.map(t => t.name), ["read", "bash"]);
  h.pending[0].resolve(response()); await flush();
  file(cwd, "worker", definition("worker", "background: false\neffort: low\n", "Changed prompt"));
  const call = h.agent({ subagent_type: "worker", run_in_background: false }); assert.match(String(h.conversations[1][0].content), /^Changed prompt/); assert.equal(h.choices[1].reasoning, "low");
  h.pending[1].resolve(response()); assert.equal((await call).details!.background, undefined); h.shutdown();
});
test("custom definition models resolve alias/full/bare IDs and unknown models fail before launch", async t => {
  const cwd = fs.mkdtempSync(join(process.cwd(), ".test-definitions-")); t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const sonnet = model("claude-sonnet-4-6");
  for (const requested of ["sonnet", "test/claude-sonnet-4-6", "claude-sonnet-4-6", "missing/id"]) {
    file(cwd, "modeled", definition("modeled", `model: ${requested}\neffort: 12\n`));
    const h = harness(); Object.defineProperty(h.ctx, "cwd", { value: cwd }); h.available([h.ctx.model!, sonnet]);
    if (requested === "missing/id") { await assert.rejects(h.agent({ subagent_type: "modeled" }), /unavailable/); assert.equal(h.pending.length, 0); }
    else {
      await h.agent({ subagent_type: "modeled" }); assert.equal(h.models[0], sonnet); assert.equal(h.choices[0].reasoning, "high");
      assert.match(h.notices[0], /integer effort ignored/); h.pending[0].resolve(response()); await flush();
    }
    h.shutdown();
  }
});

test("custom maxTurns notifies with completed limit summary and can resume same transcript", async t => {
  const cwd = fs.mkdtempSync(join(process.cwd(), ".test-definitions-")); t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  file(cwd, "limited", definition("limited", "maxTurns: 1\n"));
  const h = harness(); Object.defineProperty(h.ctx, "cwd", { value: cwd });
  const launch = await h.agent({ subagent_type: "limited" }); h.pending[0].resolve(response("", "read")); await flush();
  const text = String(h.sent[0].message.content); assert.match(text, /<status>completed<\/status>/);
  assert.match(text, /Agent "Find code" stopped at its 1-turn limit/); assert.match(text, /NOTE: this agent stopped at its 1-turn limit/);
  await h.call("SendMessage", { to: launch.details!.runs[0].id, message: "continue" });
  assert.equal(h.conversations[1].at(-2)!.role, "toolResult"); assert.equal(h.conversations[1].at(-1)!.content, "continue");
  h.pending[1].resolve(response("finished")); await flush(); assert.equal(h.sent.length, 2); h.shutdown();
});
