import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { addUsage, createRun, emptyUsage, failed, type Details, type Task } from "./state.ts";
import { cap, pooled, runAgent } from "./runner.ts";
import { renderRuns } from "./render.ts";
import { demoRuns } from "./preview.ts";
import { AgentStatus } from "./status.ts";
import { AgentNavigation } from "./navigation.ts";

const routingProperties = {
  model: Type.Optional(Type.String({ description: "Available provider/model ID; auto (default) routes by task, inherit keeps the parent model" })),
  effort: Type.Optional(Type.Union((["auto", "off", "minimal", "low", "medium", "high"] as const).map(value => Type.Literal(value)), { description: "Reasoning effort for this task; auto adapts to the profile" })),
  profile: Type.Optional(Type.Union((["auto", "quick", "balanced", "deep"] as const).map(value => Type.Literal(value)), { description: "Task complexity/cost profile; auto uses task type and risk keywords" })),
};
const taskProperties = {
  ...routingProperties,
  description: Type.String({ minLength: 1, maxLength: 120, description: "Short task description (3–5 words)" }),
  prompt: Type.String({ minLength: 1, maxLength: 50000, description: "Self-contained task; the agent does not see parent conversation history" }),
  subagent_type: Type.Optional(Type.Union([Type.Literal("Explore"), Type.Literal("Plan"), Type.Literal("general-purpose")], { description: "Explore and Plan are read-only; general-purpose can edit files and run bash" })),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: "Optional short display name such as researcher or reviewer (shown up to 24 characters); defaults to the agent type" })),
};
const schema = Type.Object({
  description: Type.Optional(taskProperties.description),
  prompt: Type.Optional(taskProperties.prompt),
  subagent_type: taskProperties.subagent_type,
  name: taskProperties.name,
  ...routingProperties,
  tasks: Type.Optional(Type.Array(Type.Object(taskProperties), { minItems: 1, maxItems: 8, description: "Independent tasks to execute in parallel (up to 4 concurrently)" })),
});

export default function ccSubagent(pi: ExtensionAPI): void {
  const controllers = new Set<AbortController>();
  const status = new AgentStatus();
  const navigation = new AgentNavigation(status);
  pi.on("session_start", (_event, ctx) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!disposed) navigation.attach(ctx);
    }, 0);
    timers.add(timer);
  });
  const timers = new Set<ReturnType<typeof setInterval>>();
  const demoKey = Symbol("demo");
  let disposed = false;
  let demoTimer: ReturnType<typeof setTimeout> | undefined;
  const clearDemo = (ctx: ExtensionContext) => {
    if (demoTimer) clearTimeout(demoTimer);
    demoTimer = undefined;
    status.release(demoKey, ctx);
  };
  pi.on("session_shutdown", (_event, ctx) => {
    disposed = true;
    navigation.shutdown();
    if (demoTimer) clearTimeout(demoTimer);
    demoTimer = undefined;
    for (const timer of timers) clearInterval(timer);
    timers.clear();
    status.shutdown(ctx);
    for (const controller of controllers) controller.abort();
    controllers.clear();
  });
  pi.on("before_agent_start", (_event, ctx) => {
    clearDemo(ctx);
    navigation.attach(ctx);
  });
  pi.registerTool({
    name: "cc_subagent",
    label: "Agent",
    description: "Delegate an explicitly authorized task to isolated Pi subagents. Supply description + prompt OR tasks (max 8, concurrency 4). Adapts model and reasoning effort per task; model, effort and profile can be overridden. Preserves parent system instructions and permission checks, with bounded tool calls/output/turns. Explore/Plan are read-only; general-purpose can edit and run commands. Only core tools are exposed. No background execution or recursive delegation. Output is capped at 48 KiB per child and 48 KiB total.",
    promptSnippet: "Run isolated subagents with Claude Code-style progress display",
    promptGuidelines: [
      "Use cc_subagent only when the user has authorized delegation; complexity alone is not authorization.",
      "Give cc_subagent a self-contained prompt and short description; optionally set a short name (e.g. researcher, reviewer) to label it in the agent list.",
      "Use cc_subagent tasks for independent parallel work. Never assign overlapping file edits to parallel agents.",
      "Choose cc_subagent model/effort/profile for each task: quick/minimal for targeted exploration, balanced/low for normal edits, deep/medium for difficult design or high-risk work. Avoid extra reviewers or repeated scans for trivial tasks. Leave model auto unless a specific available model is justified.",
    ],
    parameters: schema,
    renderShell: "self",
    async execute(id, params, signal, onUpdate, ctx) {
      if (disposed) throw new Error("Subagent extension has shut down");
      const hasSingle = params.description !== undefined || params.prompt !== undefined || params.subagent_type !== undefined || params.name !== undefined || params.model !== undefined || params.effort !== undefined || params.profile !== undefined;
      if ((params.tasks !== undefined && hasSingle) || (!params.tasks && (!params.description || !params.prompt))) {
        throw new Error("Provide description + prompt OR tasks, not both.");
      }
      const tasks: Task[] = params.tasks ?? [{ description: params.description!, prompt: params.prompt!, subagent_type: params.subagent_type, name: params.name, model: params.model, effort: params.effort, profile: params.profile }];
      if (tasks.some(t => !t.description.trim() || !t.prompt.trim())) throw new Error("Task descriptions and prompts must not be blank.");
      clearDemo(ctx);
      navigation.attach(ctx);
      const runs = tasks.map(createRun);
      const key = Symbol(id);
      status.track(key, runs);
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal?.aborted) abort();
      signal?.addEventListener("abort", abort, { once: true });
      controllers.add(controller);
      const snapshot = (): Details => structuredClone({ runs });
      let lastSnapshotAt = -Infinity;
      let lastSnapshotState = "";
      const update = () => {
        if (disposed) return;
        status.publish(ctx);
        const now = Date.now();
        const state = runs.map(run => run.status).join(",");
        if (now - lastSnapshotAt < 1000 && state === lastSnapshotState) return;
        lastSnapshotAt = now;
        lastSnapshotState = state;
        onUpdate?.({ content: [{ type: "text", text: "Subagents in progress" }], details: snapshot() });
      };
      // Footer time updates do not clone or resend the child transcript.
      const timer = setInterval(() => { if (!disposed) status.publish(ctx); }, 1000);
      timers.add(timer);
      timer.unref();
      try {
        update();
        await pooled(runs, 4, async run => {
          if (controller.signal.aborted) {
            run.status = "aborted"; run.error = "Interrupted before starting"; update(); return;
          }
          await runAgent(run, ctx, controller.signal, update);
        });
        const usage = emptyUsage();
        for (const run of runs) addUsage(usage, run.usage);
        return {
          content: [{ type: "text" as const, text: cap(runs.map(run => `## ${run.task.description} [${run.status}]\n${run.error ?? run.output}`).join("\n\n")) }],
          details: snapshot(),
          usage,
          isError: runs.some(failed),
        };
      } finally {
        clearInterval(timer);
        timers.delete(timer);
        signal?.removeEventListener("abort", abort);
        controllers.delete(controller);
        status.release(key, ctx);
      }
    },
    renderCall() { return new Container(); },
    renderResult(result, { expanded }, theme, context) {
      const details = result.details as Details | undefined;
      if (!details?.runs?.length) {
        return new Text(result.content.filter(p => p.type === "text").map(p => p.text).join("\n"), 0, 0);
      }
      return renderRuns(details.runs, theme, {
        expanded,
        hint: context.keyHint("app.tools.expand", "to expand"),
        rows: process.stdout.rows,
      });
    },
  });
  pi.registerCommand("cc-agent", {
    description: "Delegate a task: /cc-agent [Explore|Plan|general-purpose] <task>",
    handler: async (args, ctx) => {
      const match = args.trim().match(/^(?:(Explore|Plan|general-purpose)\s+)?([\s\S]+)$/);
      if (!match) { ctx.ui.notify("Usage: /cc-agent [Explore|Plan|general-purpose] <task>", "info"); return; }
      const task = { subagent_type: match[1] ?? "general-purpose", description: match[2].slice(0, 80), prompt: match[2] };
      pi.sendUserMessage(`I authorize delegation of this task. Call cc_subagent with these arguments, then summarize the result:\n${JSON.stringify(task)}`, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
    },
  });
  pi.registerEntryRenderer("cc-subagent-preview", (entry, options, theme) => {
    const details = entry.data as Details;
    return renderRuns(details.runs, theme, { expanded: options.expanded, hint: options.keyHint("app.tools.expand", "to expand") });
  });
  pi.registerCommand("cc-agents", {
    description: "View live subagent activity (↑↓ switch; main/Enter/Esc returns)",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("Agent view requires interactive mode", "warning"); return; }
      navigation.attach(ctx);
      if (!status.selectedRun) {
        if (!status.running().length) { ctx.ui.notify("No running subagents", "info"); return; }
        if (!status.selecting) status.move(1, ctx); // chat → main
        status.move(1, ctx); // main → first child
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
      if (!ctx.isIdle() || controllers.size) { ctx.ui.notify("Status demo is unavailable while agents are running", "warning"); return; }
      clearDemo(ctx);
      navigation.attach(ctx);
      const runs = [createRun({ description: "ホームの git リポジトリ概要調査", prompt: "[demo]", subagent_type: "Explore" })];
      Object.assign(runs[0], { status: "running", startedAt: Date.now() - 6000, tokens: 26400 });
      runs[0].activities.push({ kind: "tool", text: "List repositories" });
      status.track(demoKey, runs);
      status.publish(ctx);
      ctx.ui.notify("Synthetic status demo: main / Explore (10s)", "info");
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
