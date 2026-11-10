import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { resolve } from "node:path";
import { addUsage, toolLabel, type Run } from "./state.ts";
import { choosePolicy, LIMITS } from "./policy.ts";

const READ_TOOLS = ["read", "grep", "find", "ls"];
const WRITE_TOOLS = [...READ_TOOLS, "bash", "write", "edit"];
const MUTATING_TOOLS = new Set(["bash", "write", "edit"]);
export const DEFAULT_READ_LINES = 200;
export const MAX_READ_LINES = 500;

/** Children never read a whole file by default; read's continuation hint points at the next offset. */
export function boundReadArgs(args: Record<string, unknown>): Record<string, unknown> {
  const limit = args.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) return { ...args, limit: DEFAULT_READ_LINES };
  return limit > MAX_READ_LINES ? { ...args, limit: MAX_READ_LINES } : args;
}

/** Stable identity of a read-only call: same tool, same resolved path, same arguments. */
export function callKey(name: string, args: Record<string, unknown>, cwd: string): string {
  const normalized: Record<string, unknown> = { ...args };
  if (typeof normalized.path === "string") normalized.path = resolve(cwd, normalized.path.replace(/^@/, ""));
  return `${name}:${JSON.stringify(Object.keys(normalized).sort().map(key => [key, normalized[key]]))}`;
}
export const MAX_TURNS = LIMITS.balanced.turns;
const MAX_ACTIVITIES = 80;
const MAX_TEXT = 48 * 1024;
export function cap(text: string, bytes = MAX_TEXT): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  let head = Buffer.from(text).subarray(0, bytes).toString("utf8");
  if (head.endsWith("�")) head = head.slice(0, -1);
  return head + "\n[Output truncated]";
}

/** Isolated conversation; tools retain the parent's validation and permission hooks. */
export async function runAgent(
  run: Run, ctx: ExtensionToolContext, signal: AbortSignal, update: () => void,
): Promise<void> {
  run.startedAt = Date.now();
  run.status = "running";
  update();
  const activity = (text: string, kind: "tool" | "text", error = false) => {
    run.activities.push({ text: cap(text, 1024), kind, error });
    if (run.activities.length > MAX_ACTIVITIES) run.activities.shift();
    update();
  };
  try {
    signal.throwIfAborted();
    if (!ctx.model) throw new Error("Select a Pi model before running a subagent.");
    const available = ctx.modelRegistry.getAvailable?.() ?? [ctx.model];
    const scoped = ctx.scopedModels?.length ? available.filter(model => ctx.scopedModels.some(entry => entry.model.provider === model.provider && entry.model.id === model.id)) : available;
    const { model, effort, profile, limits } = choosePolicy(run.task, ctx.model, run.task.model && !["auto", "inherit"].includes(run.task.model) ? available : scoped);
    run.model = `${model.provider}/${model.id}`;
    run.effort = effort;
    run.profile = profile;
    const readOnly = run.task.subagent_type === "Explore" || run.task.subagent_type === "Plan";
    const allowed = new Set(readOnly ? READ_TOOLS : WRITE_TOOLS);
    const tools = ctx.tools.filter(t => allowed.has(t.name));
    const toolsByName = new Set(tools.map(t => t.name));
    const system = `${ctx.getSystemPrompt()}\n\n<subagent>\nYou are an isolated ${run.task.subagent_type ?? "general-purpose"} subagent. Work only on the delegated task. Return findings to the supervisor, not directly to the user. Do not delegate further or manage the parent's TODO list. Only these tools are available: ${[...toolsByName].join(", ")}. ${readOnly ? "Read-only task: do not change files or execute commands." : "Coordinate edits through the supervisor; do not change unrelated files."}\nUse find/grep to locate relevant files before reading unknown paths. Read small ranges and batch independent read-only searches in one model turn. Avoid repeated reads and broad scans. read returns at most ${DEFAULT_READ_LINES} lines unless you pass limit (max ${MAX_READ_LINES}); use offset to continue only when needed. Identical read-only calls are not re-executed. Do not rerun passing checks unless the relevant files changed. Return a concise result with evidence and blockers, without narrating every step. Finish as soon as the delegated task is satisfied. Budget: ${limits.turns} model turns and ${limits.toolUses} tool calls.\nWorking directory: ${ctx.cwd}\n</subagent>`;
    const messages: Message[] = [
      { role: "system", content: system, toolsAdded: tools, timestamp: Date.now() },
      { role: "user", content: run.task.prompt, timestamp: Date.now() },
    ];
    const sessionId = `cc-subagent-${crypto.randomUUID()}`;
    // Successful read-only calls; cleared after anything that may change files.
    const seen = new Set<string>();
    for (let turn = 0; turn < limits.turns; turn++) {
      signal.throwIfAborted();
      const remainingOutput = limits.output - run.usage.output;
      if (remainingOutput <= 0) throw new Error(`Agent reached its ${limits.output}-token output budget`);
      run.currentActivity = "Waiting for model response…";
      run.liveText = "";
      const maxTokens = Math.min(limits.response, remainingOutput, model.maxTokens || limits.response);
      const thinkingBudget = Math.max(0, Math.min(2048, maxTokens - 1024));
      const requestEffort = maxTokens < 2048 ? "off" : effort;
      run.effort = requestEffort;
      const stream = ctx.modelRegistry.streamSimple(model, { messages }, {
        signal, sessionId,
        reasoning: requestEffort === "off" ? undefined : requestEffort,
        thinkingBudgets: { minimal: Math.min(1024, thinkingBudget), low: thinkingBudget, medium: thinkingBudget, high: thinkingBudget },
        maxTokens,
      });
      // Keep streamed text separate from the final result for the live agent viewer.
      let lastUpdate = 0;
      for await (const event of stream) {
        if (event.type === "text_delta") {
          run.liveText = cap(run.liveText + event.delta, 8 * 1024);
          run.currentActivity = "Writing response…";
          if (Date.now() - lastUpdate >= 1000) { lastUpdate = Date.now(); update(); }
        }
      }
      const message = await stream.result();
      addUsage(run.usage, message.usage);
      // Claude's row uses the latest request's context+output, not cumulative billed tokens.
      run.tokens = message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
      messages.push(message);
      update();
      signal.throwIfAborted();
      if (message.stopReason === "aborted") { run.status = "aborted"; throw new Error("Interrupted"); }
      if (message.stopReason === "error") throw new Error(message.errorMessage || "Model request failed");
      const calls = message.content.filter(p => p.type === "toolCall");
      const text = message.content.filter(p => p.type === "text").map(p => p.text).join("\n");
      if (!calls.length) {
        if (message.stopReason === "length") throw new Error("Model output limit reached before completion");
        if (message.stopReason === "deferred") throw new Error("Deferred model responses are not supported");
        if (!text.trim()) throw new Error("Agent returned no response");
        run.output = cap(text);
        run.status = "completed";
        return;
      }
      if (text.trim()) activity(text, "text");
      for (const call of calls) {
        signal.throwIfAborted();
        if (run.toolUses >= limits.toolUses) throw new Error(`Agent reached its ${limits.toolUses}-call tool budget`);
        run.toolUses++;
        const label = toolLabel(call.name, call.arguments);
        run.currentActivity = label;
        activity(label, "tool");
        const allowed = toolsByName.has(call.name) && !call.argumentsError;
        const args = allowed && call.name === "read" ? boundReadArgs(call.arguments) : call.arguments;
        const key = allowed && READ_TOOLS.includes(call.name) ? callKey(call.name, args, ctx.cwd) : undefined;
        const duplicate = key !== undefined && seen.has(key);
        // Local allowlist is enforced even if a model invents an unavailable tool.
        const result = !toolsByName.has(call.name)
          ? { content: [{ type: "text" as const, text: `Tool not allowed: ${call.name}` }], isError: true }
          : call.argumentsError
            ? { content: [{ type: "text" as const, text: call.argumentsError }], isError: true }
            : duplicate
              // Nothing new is disclosed, so skipping the parent hooks here grants no extra access.
              ? { content: [{ type: "text" as const, text: `Skipped: an identical ${call.name} call already returned its result earlier in this conversation, and this agent has not changed any files since. Reuse that result.` }], isError: false }
              : await ctx.executeTool(call.name, args, { signal }).then(outcome => ({ ...outcome.result, isError: outcome.isError }));
        if (duplicate) activity(`${label} — duplicate skipped`, "tool");
        else if (key && !result.isError) seen.add(key);
        if (allowed && MUTATING_TOOLS.has(call.name)) seen.clear();
        if (result.isError) activity(`${label} — failed`, "tool", true);
        // Keep child context bounded; original result remains handled by the host.
        const content = result.content.map(part => part.type === "text" ? { ...part, text: cap(part.text, limits.toolBytes) } : part);
        messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content, isError: !!result.isError, timestamp: Date.now() });
      }
    }
    throw new Error(`Agent exceeded ${limits.turns} model turns`);
  } catch (error) {
    run.status = signal.aborted || run.status === "aborted" ? "aborted" : "failed";
    run.error = signal.aborted ? "Interrupted" : cap(error instanceof Error ? error.message : String(error), 2048);
  } finally {
    run.durationMs = Date.now() - run.startedAt;
    run.currentActivity = run.status;
    run.liveText = undefined;
    update();
  }
}

export async function pooled<T>(items: T[], concurrency: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}
