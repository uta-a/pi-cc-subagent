import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { Message, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { addUsage, toolLabel, type Effort, type Run } from "./state.ts";
import { resolvePolicy } from "./policy.ts";
import { builtins, childTools, type Definition } from "./definitions.ts";
import { childSystem, userContext, type ProjectContext } from "./prompts.ts";
import { mutationPath, type FileLocks } from "./locks.ts";
import type { ResultFiles } from "./results.ts";
import type { Settings } from "./settings.ts";

export interface Conversation {
  messages: Message[];
  queue: string[];
  sessionId: string;
}
export const conversation = (): Conversation => ({ messages: [], queue: [], sessionId: `cc-subagent-${randomUUID()}` });
export interface RunnerOptions {
  context?: ProjectContext;
  locks?: FileLocks;
  results?: ResultFiles;
  label?: string;
  definition?: Definition;
  config?: Settings;
  thinking?: Effort;
  policy?: ReturnType<typeof resolvePolicy>;
  conversation?: Conversation;
}
const READ_TOOLS = ["read", "grep", "find", "ls"];
export const DEFAULT_READ_LINES = 200;
export const MAX_READ_LINES = 500;
export function boundReadArgs(args: Record<string, unknown>): Record<string, unknown> {
  const limit = args.limit;
  return { ...args, limit: typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0 ? DEFAULT_READ_LINES : Math.min(limit, MAX_READ_LINES) };
}
export function callKey(name: string, args: Record<string, unknown>, cwd: string): string {
  const normalized = { ...args };
  if (typeof normalized.path === "string") normalized.path = resolve(cwd, normalized.path.replace(/^@/, ""));
  return `${name}:${JSON.stringify(Object.keys(normalized).sort().map(key => [key, normalized[key]]))}`;
}
export function cap(text: string, bytes = 48 * 1024): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  let head = Buffer.from(text).subarray(0, bytes).toString("utf8");
  if (head.endsWith("�")) head = head.slice(0, -1);
  return head + "\n[Output truncated]";
}

/** Session transcripts stay outside serializable UI snapshots. */
export async function runAgent(run: Run, ctx: ExtensionToolContext, signal: AbortSignal, update: () => void, options: RunnerOptions = {}): Promise<void> {
  run.startedAt = Date.now();
  run.status = "running";
  run.output = "";
  run.error = undefined;
  run.resultText = undefined;
  run.turnLimit = undefined;
  const history = options.conversation ?? conversation();
  const messages = history.messages;
  const outputStart = run.usage.output;
  const toolsStart = run.toolUses;
  const activity = (text: string, kind: "tool" | "text", error = false) => {
    run.activities.push({ text: cap(text, 1024), kind, error });
    if (run.activities.length > 80) run.activities.shift();
    update();
  };
  const drain = () => {
    for (const content of history.queue.splice(0)) messages.push({ role: "user", content, timestamp: Date.now() });
  };
  const repair = (reason: string) => {
    const index = messages.findLastIndex(m => m.role === "assistant");
    const answered = new Set(messages.slice(index + 1).filter(m => m.role === "toolResult").map(m => m.toolCallId));
    const last = messages[index];
    if (last?.role !== "assistant") return;
    for (const call of last.content.filter(p => p.type === "toolCall")) {
      if (!answered.has(call.id)) messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: reason }], isError: true, timestamp: Date.now() });
    }
  };
  update();
  try {
    signal.throwIfAborted();
    if (!ctx.model) throw new Error("Select a Pi model before running a subagent.");
    const definition = options.definition ?? builtins().find(d => d.name === (run.task.subagent_type ?? "general-purpose"));
    if (!definition) throw new Error(`Unknown agent type: ${run.task.subagent_type}`);
    const config = options.config ?? { maxConcurrent: 20, budgets: "off", autoModel: false, resultFiles: false, fileLocks: true };
    const available = ctx.modelRegistry.getAvailable?.() ?? [ctx.model];
    const scoped = ctx.scopedModels?.length ? available.filter(model => ctx.scopedModels.some(entry => entry.model.provider === model.provider && entry.model.id === model.id)) : available;
    const { model, effort, profile, limits } = options.policy ?? resolvePolicy(run.task, definition, config, ctx.model, available, options.thinking ?? ctx.thinkingLevel ?? "off", scoped);
    run.model = `${model.provider}/${model.id}`;
    run.effort = effort;
    run.profile = profile;
    const tools = childTools(ctx.tools, definition);
    const toolsByName = new Set(tools.map(t => t.name));
    const fresh = messages.length === 0;
    const system = childSystem(definition, ctx.cwd, model);
    if (fresh) messages.push(
      { role: "system", content: system, toolsAdded: tools, timestamp: Date.now() },
      { role: "user", content: [{ type: "text", text: userContext(definition, ctx.cwd, options.context) }, { type: "text", text: run.task.prompt }], timestamp: Date.now() },
    );
    let retried = false;
    const seen = new Set<string>();
    let budget: string | undefined;
    for (let turn = 0; ; turn++) {
      signal.throwIfAborted();
      drain();
      const remaining = limits ? limits.output - (run.usage.output - outputStart) : Infinity;
      if (remaining <= 0) { budget = "output budget"; break; }
      run.currentActivity = "Waiting for model response…";
      run.liveText = "";
      const request: SimpleStreamOptions = { signal, sessionId: history.sessionId, reasoning: effort === "off" ? undefined : effort };
      if (limits) {
        request.maxTokens = Math.min(limits.response, remaining, model.maxTokens || limits.response);
        if (request.maxTokens < 2048) request.reasoning = undefined;
        const thinking = Math.max(0, Math.min(2048, request.maxTokens - 1024));
        request.thinkingBudgets = { minimal: Math.min(1024, thinking), low: thinking, medium: thinking, high: thinking };
      }
      const stream = ctx.modelRegistry.streamSimple(model, { messages }, request);
      let lastUpdate = 0;
      for await (const event of stream) {
        signal.throwIfAborted();
        if (event.type === "text_delta") {
          run.liveText = cap(run.liveText + event.delta, 8 * 1024);
          run.currentActivity = "Writing response…";
          if (Date.now() - lastUpdate >= 1000) { lastUpdate = Date.now(); update(); }
        }
      }
      const message = await stream.result();
      addUsage(run.usage, message.usage);
      run.tokens = message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
      signal.throwIfAborted();
      const text = message.content.filter(p => p.type === "text").map(p => p.text).join("\n");
      if (message.stopReason === "error") {
        if (fresh && turn === 0 && !retried && message.usage.output === 0 && !text && !message.content.some(p => p.type === "toolCall")) {
          retried = true;
          const head = messages[0];
          if (head.role === "system") head.content = `${ctx.getSystemPrompt()}\n\n${system}`;
          activity("Provider rejected the child prompt; retrying with the full parent prompt", "text");
          turn--;
          continue;
        }
        // Pi drops errored assistant messages when sending, so keeping it (and repairing its tool calls) would orphan results on resume.
        if (text) run.output = text;
        throw new Error(message.errorMessage || "Model request failed");
      }
      if (message.stopReason === "aborted") throw new Error("Interrupted");
      messages.push(message);
      if (text) run.output = text;
      update();
      const calls = message.content.filter(p => p.type === "toolCall");
      if (calls.length && definition.maxTurns && turn + 1 >= definition.maxTurns) {
        repair(`Agent stopped at its ${definition.maxTurns}-turn limit; SendMessage to task-id to continue.`);
        run.turnLimit = definition.maxTurns;
        run.output = `NOTE: this agent stopped at its ${definition.maxTurns}-turn limit; SendMessage to task-id to continue.\n\n${text}`;
        run.status = "completed";
        return;
      }
      if (limits && run.usage.output - outputStart >= limits.output) budget = "output budget";
      if (limits && calls.length && turn + 1 >= limits.turns) budget ??= "turn budget";
      if (!calls.length && !budget) {
        if (message.stopReason === "length") throw new Error("Model output limit reached before completion");
        if (message.stopReason === "deferred") throw new Error("Deferred model responses are not supported");
        if (history.queue.length) continue;
        run.output = text;
        run.status = "completed";
        return;
      }
      if (text.trim()) activity(text, "text");
      for (const call of calls) {
        signal.throwIfAborted();
        if (limits && run.toolUses - toolsStart >= limits.toolUses) budget ??= "tool budget";
        if (budget) { repair(`Budget reached; no more tools. ${budget}; report completed work and what is incomplete.`); break; }
        run.toolUses++;
        const label = toolLabel(call.name, call.arguments);
        run.currentActivity = label;
        activity(label, "tool");
        const allowed = toolsByName.has(call.name) && !call.argumentsError;
        const args = limits && allowed && call.name === "read" ? boundReadArgs(call.arguments) : call.arguments;
        const key = limits && allowed && READ_TOOLS.includes(call.name) ? callKey(call.name, args, ctx.cwd) : undefined;
        const duplicate = key !== undefined && seen.has(key);
        const path = allowed ? mutationPath(call.name, args, ctx.cwd) : undefined;
        const conflict = path ? options.locks?.claim(run, path) : undefined;
        const error = !toolsByName.has(call.name) ? `Tool not allowed: ${call.name}` : call.argumentsError ?? conflict;
        const result = error ? { content: [{ type: "text" as const, text: error }], isError: true }
          : duplicate ? { content: [{ type: "text" as const, text: `Skipped: an identical ${call.name} call already returned its result earlier in this conversation. Reuse that result.` }], isError: false }
          : await ctx.executeTool(call.name, args, { signal }).then(outcome => ({ ...outcome.result, isError: outcome.isError }));
        if (duplicate) activity(`${label} — duplicate skipped`, "tool");
        else if (key && !result.isError) seen.add(key);
        if (allowed && ["bash", "write", "edit"].includes(call.name)) seen.clear();
        if (result.isError) activity(`${label} — failed`, "tool", true);
        const content = result.content.map(part => limits && part.type === "text" ? { ...part, text: cap(part.text, limits.toolBytes) } : part);
        messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content, isError: !!result.isError, timestamp: Date.now() });
      }
      if (limits && run.toolUses - toolsStart >= limits.toolUses) budget ??= "tool budget";
      if (budget) break;
    }
    signal.throwIfAborted();
    run.error = `Budget reached (${budget}); partial report below`;
    drain();
    messages.push({ role: "user", content: `Budget reached (${budget}); no more tools. Give your concise report now, including completed work, validation actually run, and what is incomplete.`, timestamp: Date.now() });
    try {
      run.currentActivity = "Writing partial report…";
      update();
      const stream = ctx.modelRegistry.streamSimple(model, { messages }, { signal, sessionId: history.sessionId, toolChoice: "none", maxTokens: Math.min(1024, model.maxTokens || 1024) });
      for await (const _event of stream) signal.throwIfAborted();
      const message = await stream.result();
      signal.throwIfAborted();
      addUsage(run.usage, message.usage);
      run.tokens = message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
      if (message.stopReason === "aborted") throw new Error("Interrupted");
      if (message.stopReason !== "error") {
        messages.push(message);
        run.output = message.content.filter(p => p.type === "text").map(p => p.text).join("\n");
        repair("Budget reached; no more tools.");
      }
    } catch (error) { if (signal.aborted) throw error; }
    run.status = "failed";
  } catch (error) {
    run.status = signal.aborted || String(error).includes("Interrupted") ? "aborted" : "failed";
    run.error = signal.aborted ? "Interrupted" : error instanceof Error ? error.message : String(error);
    repair(run.error);
  } finally {
    run.resultText = options.results ? options.results.format(run.output, options.label ?? run.task.name ?? run.task.subagent_type ?? "worker") : run.output;
    run.output = cap(run.output);
    run.durationMs += Date.now() - run.startedAt;
    run.currentActivity = run.status;
    run.liveText = undefined;
    update();
  }
}
