import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createRun, type Details } from "./state.ts";
import { renderRuns } from "./render.ts";
import { demoRuns } from "./preview.ts";
import { AgentStatus } from "./status.ts";
import { AgentNavigation, safeText } from "./navigation.ts";
import { BackgroundAgents, RESULT_MESSAGE_TYPE } from "./background.ts";
import { FileLocks, mutationPath } from "./locks.ts";
import { captureContext, type ProjectContext } from "./prompts.ts";
import { ResultFiles } from "./results.ts";
import { Definitions, agentListing } from "./definitions.ts";
import { settings } from "./settings.ts";
import { resolveModel, resolvePolicy } from "./policy.ts";
import { AGENT_PROMPT, SEND_PROMPT, FIELD_DESCRIPTIONS as D } from "./cc-texts.ts";

export const agentSchema = Type.Object({
  description: Type.String({ description: D.description }),
  prompt: Type.String({ description: D.prompt }),
  subagent_type: Type.Optional(Type.String({ description: D.subagent_type })),
  model: Type.Optional(Type.Union((["sonnet", "opus", "haiku", "fable"] as const).map(value => Type.Literal(value)), { description: D.model })),
  effort: Type.Optional(Type.Union((["low", "medium", "high", "xhigh", "max"] as const).map(value => Type.Literal(value)), { description: D.effort })),
  run_in_background: Type.Optional(Type.Boolean({ description: D.run_in_background })),
  name: Type.Optional(Type.String({ description: D.name })),
}, { additionalProperties: false });

export default function ccSubagent(pi: ExtensionAPI): void {
  const status = new AgentStatus();
  const navigation = new AgentNavigation(status);
  const locks = new FileLocks();
  const results = new ResultFiles();
  const background = new BackgroundAgents(pi, status, locks);
  const definitions = new Definitions();
  const childCallRoots = new Set<string>();
  const load = (ctx: ExtensionContext, force = false) => definitions.load(ctx.cwd, message => ctx.ui.notify(message, "warning"), force);
  let context: ProjectContext | undefined;
  let disposed = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const demoKey = Symbol("demo");
  let demoTimer: ReturnType<typeof setTimeout> | undefined;
  const clearDemo = (ctx: ExtensionContext) => {
    if (demoTimer) clearTimeout(demoTimer);
    demoTimer = undefined;
    status.release(demoKey, ctx);
  };
  pi.on("session_start", (_event, ctx) => {
    load(ctx, true);
    const timer = setTimeout(() => { timers.delete(timer); if (!disposed) navigation.attach(ctx); }, 0);
    timers.add(timer);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    disposed = true;
    background.shutdown();
    results.shutdown();
    context = undefined;
    childCallRoots.clear();
    navigation.shutdown();
    if (demoTimer) clearTimeout(demoTimer);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    status.shutdown(ctx);
  });
  pi.on("before_agent_start", (event, ctx) => {
    context = captureContext(event.systemPromptOptions?.contextFiles, event.systemPromptOptions?.cwd ?? ctx.cwd);
    clearDemo(ctx);
    navigation.attach(ctx);
    const active = new Set(pi.getActiveTools());
    const config = settings(pi);
    const available = ctx.modelRegistry.getAvailable();
    // Same order as an Agent call without a model argument; rebuilt every turn, so it follows /model changes.
    const modelOf = (def: { model?: string }) => {
      if (!ctx.model) return "inherit (no main model selected)";
      if (!def.model && config.autoModel) return "auto (chosen per task)";
      const spec = def.model ?? config.defaultModel;
      try { const model = resolveModel(spec, ctx.model, available); return `${model.provider}/${model.id}`; }
      catch { return `unavailable (${spec})`; }
    };
    const listing = agentListing(load(ctx), pi.getAllTools().filter(tool => active.has(tool.name)), modelOf);
    // A section (not a returned systemPrompt): Pi patches only changed sections, and pi-claude-bridge forwards sections but drops replaced prompts.
    const sections = event.systemPromptOptions?.sections;
    const text = `${listing}\nWhen you launch multiple agents for independent work, send them in a single message with multiple Agent calls.`;
    if (sections) sections["system-reminder"] = text;
    else return { systemPrompt: `${event.systemPrompt}\n\n<system-reminder>\n${text}\n</system-reminder>` };
  });
  const fromChild = (parent: string | undefined) => parent !== undefined && [...childCallRoots].some(root => parent === root || parent.startsWith(`${root}/`));
  pi.on("tool_call", (event, ctx) => {
    if (fromChild(event.parentToolCallId)) {
      if (["Agent", "SendMessage", "TaskStop"].includes(event.toolName)) return { block: true, reason: "Subagents cannot call Agent, SendMessage or TaskStop." };
      // Child write/edit calls are claimed by the runner itself.
      return;
    }
    // Top-level main calls and nested calls made by main's own tools count as main.
    if (!settings(pi).fileLocks) return;
    const path = mutationPath(event.toolName, event.input, ctx.cwd);
    if (path) return locks.mainCall(event.toolCallId, path);
  });
  pi.on("tool_execution_end", event => {
    if (!fromChild(event.parentToolCallId)) locks.mainEnd(event.toolCallId, event.isError);
  });
  pi.registerTool({
    name: "Agent", label: "Agent", description: AGENT_PROMPT,
    promptSnippet: "Launch a new agent", parameters: agentSchema, renderShell: "self",
    async execute(id, params, signal, onUpdate, ctx) {
      if (disposed) throw new Error("Subagent extension has shut down");
      const active = load(ctx);
      const type = params.subagent_type ?? "general-purpose";
      const definition = active.find(def => def.name === type);
      if (!definition) throw new Error(`Agent type "${type}" not found. Available types: ${active.map(def => def.name).join(", ")}`);
      if (!ctx.model) throw new Error("Select a Pi model before running a subagent.");
      const config = settings(pi);
      const task = { ...params, subagent_type: type };
      const available = ctx.modelRegistry.getAvailable();
      const scoped = ctx.scopedModels?.length ? available.filter(model => ctx.scopedModels.some(entry => entry.model.provider === model.provider && entry.model.id === model.id)) : available;
      const policy = resolvePolicy(task, definition, config, ctx.model, available, pi.getThinkingLevel(), scoped);
      clearDemo(ctx);
      navigation.attach(ctx);
      childCallRoots.add(id);
      return background.launch(task, ctx, { context, results, definition, config, policy }, definition.background === true || params.run_in_background !== false, signal,
        details => onUpdate?.({ content: [{ type: "text", text: "Agent in progress" }], details }));
    },
    renderCall() { return new Container(); },
    renderResult(result, { expanded }, theme, renderer) {
      const details = result.details as Details | undefined;
      if (details?.background) return new Text(`Agent launched: ${safeText(details.runs[0].task.name ?? details.runs[0].task.subagent_type ?? "general-purpose")} (${safeText(details.runs[0].task.description)})`, 0, 0);
      if (!details?.runs?.length) return new Text(result.content.filter(p => p.type === "text").map(p => p.text).join("\n"), 0, 0);
      return renderRuns(details.runs, theme, { expanded, hint: renderer.keyHint("app.tools.expand", "to expand"), rows: process.stdout.rows });
    },
  });
  pi.registerTool({
    name: "SendMessage", label: "SendMessage", description: SEND_PROMPT, promptSnippet: "Send a message to another agent",
    parameters: Type.Object({ to: Type.String(), message: Type.String(), summary: Type.Optional(Type.String()) }, { additionalProperties: false }),
    async execute(id, params, _signal, _onUpdate, ctx) {
      childCallRoots.add(id);
      return { content: [{ type: "text", text: JSON.stringify(background.send(params.to, params.message, ctx, settings(pi))) }], details: undefined };
    },
    renderCall(args) { return new Text(safeText(`SendMessage → ${args.to ?? ""}: ${args.summary ?? args.message?.split("\n")[0] ?? ""}`).replaceAll("\n", " "), 0, 0); },
    renderResult(result, _options, _theme, renderer) {
      return renderer.isError ? new Text(result.content.filter(p => p.type === "text").map(p => p.text).join("\n"), 0, 0) : new Container();
    },
  });
  pi.registerTool({
    name: "TaskStop", label: "Stop Task", description: "Stop a running background task by ID",
    parameters: Type.Object({ task_id: Type.Optional(Type.String()), shell_id: Type.Optional(Type.String({ description: "Deprecated alias for task_id" })) }, { additionalProperties: false }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: JSON.stringify(background.stopTask(params.task_id ?? params.shell_id)) }], details: undefined };
    },
    renderCall(args) { return new Text(safeText(`Stop Task ${args.task_id ?? args.shell_id ?? ""}`).replaceAll("\n", " "), 0, 0); },
    renderResult(result, _options, _theme, renderer) {
      return renderer.isError ? new Text(result.content.filter(p => p.type === "text").map(p => p.text).join("\n"), 0, 0) : new Container();
    },
  });
  pi.registerMessageRenderer(RESULT_MESSAGE_TYPE, (message, options, theme) => {
    const details = message.details as Details;
    return renderRuns(details.runs, theme, { expanded: options.expanded, hint: options.keyHint("app.tools.expand", "to expand"), rows: process.stdout.rows });
  });
  pi.registerCommand("cc-agents-stop", {
    description: "Stop background agents: /cc-agents-stop [id or name] (no argument stops all)",
    handler: async (args, ctx) => {
      const count = background.stop(args.trim() || undefined);
      ctx.ui.notify(count ? `Stopping ${count} background agent(s)` : "No matching background agents", "info");
    },
  });
  pi.registerCommand("cc-agent", {
    description: "Delegate a task: /cc-agent [agent type] <task>",
    handler: async (args, ctx) => {
      const match = args.trim().match(/^(?:(\S+)\s+)?([\s\S]+)$/);
      if (!match) { ctx.ui.notify("Usage: /cc-agent [agent type] <task>", "info"); return; }
      const known = load(ctx).some(def => def.name === match[1]);
      const prompt = known ? match[2] : args.trim();
      const task = { subagent_type: known ? match[1] : "general-purpose", description: prompt.slice(0, 80), prompt };
      pi.sendUserMessage(`Call Agent with these arguments, then summarize the result when it arrives:\n${JSON.stringify(task)}`, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
    },
  });
  pi.registerEntryRenderer("cc-subagent-preview", (entry, options, theme) => renderRuns((entry.data as Details).runs, theme, { expanded: options.expanded, hint: options.keyHint("app.tools.expand", "to expand") }));
  pi.registerCommand("cc-agents", {
    description: "View live subagent activity (↑↓ switch; main/Enter/Esc returns)",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("Agent view requires interactive mode", "warning"); return; }
      navigation.attach(ctx);
      if (!status.selectedRun) {
        if (!status.running().length) { ctx.ui.notify("No running subagents", "info"); return; }
        if (!status.selecting) status.move(1, ctx);
        status.move(1, ctx);
      }
      await navigation.open(ctx);
    },
  });
  pi.registerCommand("cc-subagent-status-demo", {
    description: "Preview the main/Explore status list for 10 seconds (no model calls)",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("Demo requires interactive mode", "warning"); return; }
      if (args.trim() && args.trim() !== "off") { ctx.ui.notify("Usage: /cc-subagent-status-demo [off]", "info"); return; }
      if (args.trim() === "off") { clearDemo(ctx); return; }
      if (!ctx.isIdle() || background.size) { ctx.ui.notify("Status demo is unavailable while agents are running", "warning"); return; }
      clearDemo(ctx);
      navigation.attach(ctx);
      const run = createRun({ description: "ホームの git リポジトリ概要調査", prompt: "[demo]", subagent_type: "Explore" });
      Object.assign(run, { status: "running", startedAt: Date.now() - 6000, tokens: 26400 });
      run.activities.push({ kind: "tool", text: "List repositories" });
      status.track(demoKey, [run]);
      status.publish(ctx);
      demoTimer = setTimeout(() => clearDemo(ctx), 10_000);
      demoTimer.unref();
    },
  });
  pi.registerCommand("cc-subagent-demo", {
    description: "Show synthetic Claude Code-style subagent rows without making model calls",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("Demo requires interactive mode", "warning"); return; }
      for (const runs of demoRuns()) pi.appendEntry("cc-subagent-preview", { runs });
    },
  });
}
