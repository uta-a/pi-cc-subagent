import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { runAgent, conversation, type Conversation, type RunnerOptions } from "./runner.ts";
import { foregroundText, launchText, notification } from "./formats.ts";
import { FileLocks } from "./locks.ts";
import { createRun, failed, type Details, type Run, type Task } from "./state.ts";
import type { AgentStatus } from "./status.ts";
import type { Settings } from "./settings.ts";
import { LIMITS, taskProfile } from "./policy.ts";
import { childTools } from "./definitions.ts";

export const RESULT_MESSAGE_TYPE = "cc-subagent-result";
export function capacityError(max: number): string {
  return `Concurrent subagent limit reached. You can run ${max} subagents at once. Do not retry. If the user wants more concurrent subagents, ask them to increase ccSubagent.maxConcurrent.`;
}
interface Entry {
  run: Run;
  conversation: Conversation;
  options: RunnerOptions;
  controller?: AbortController;
  notify: boolean;
}
const details = (run: Run, background = false): Details => structuredClone({ runs: [run], ...(background ? { background: true } : {}) });

/** All foreground, background and resumed slots are reserved before any await. */
export class BackgroundAgents {
  private entries = new Map<string, Entry>();
  private names = new Map<string, Entry>();
  private timers = new Set<ReturnType<typeof setInterval>>();
  private closed = false;
  constructor(private readonly pi: ExtensionAPI, private readonly status: AgentStatus, private readonly locks = new FileLocks()) {}
  get size(): number { return [...this.entries.values()].filter(e => e.controller).length; }
  private capacity(max: number): void {
    if (this.closed) throw new Error("Subagent extension has shut down");
    if (this.size >= max) throw new Error(capacityError(max));
  }
  private target(to: string): Entry {
    const entry = this.entries.get(to) ?? this.names.get(to);
    if (!entry) throw new Error(`Agent "${to}" not found`);
    return entry;
  }
  launch(task: Task, ctx: ExtensionToolContext, options: RunnerOptions, background: boolean, signal?: AbortSignal, onUpdate?: (details: Details) => void) {
    this.capacity(options.config!.maxConcurrent);
    const run = createRun(task);
    const entry: Entry = { run, conversation: conversation(), options, notify: background };
    this.entries.set(run.id, entry);
    if (task.name) this.names.set(task.name, entry);
    const work = this.start(entry, ctx, background, signal, onUpdate);
    if (background) return { content: [{ type: "text" as const, text: launchText(run) }], details: details(run, true) };
    return work;
  }
  send(to: string, message: string, ctx: ExtensionToolContext, config: Settings) {
    if (to === "*") throw new Error('broadcast (to: "*") is no longer supported — send a message per recipient');
    const entry = this.target(to);
    const label = entry.run.task.name ?? entry.run.id;
    if (entry.controller?.signal.aborted) throw new Error(`Agent "${label}" is still stopping; send the message again after its notification arrives.`);
    if (entry.controller) {
      entry.conversation.queue.push(message);
      return { success: true, message: `Agent "${label}" is already running; queued your message for its next turn.` };
    }
    this.capacity(config.maxConcurrent);
    entry.options = { ...entry.options, config };
    entry.conversation.queue.push(message);
    entry.notify = true;
    void this.start(entry, ctx, true);
    return { success: true, message: `Agent "${label}" resumed in the background; you will be notified when it completes.` };
  }
  stopTask(id?: string) {
    if (!id) throw new Error("Missing required parameter: task_id");
    const entry = this.target(id);
    const settled = entry.run.status !== "running" && !entry.conversation.queue.length;
    if (!entry.controller || entry.controller.signal.aborted || settled) throw new Error(`Task ${id} is not running (status: ${entry.controller?.signal.aborted || entry.run.status === "aborted" ? "killed" : entry.run.status})`);
    entry.notify = true;
    entry.controller.abort();
    return { message: `Successfully stopped task: ${entry.run.id} (${entry.run.task.description})`, task_id: entry.run.id, task_type: "local_agent", command: entry.run.task.description };
  }
  stop(name?: string): number {
    let count = 0;
    const target = name ? this.entries.get(name) ?? this.names.get(name) : undefined;
    for (const entry of this.entries.values()) {
      if (!entry.controller || !entry.notify || entry.controller.signal.aborted) continue;
      if (name && target !== entry && this.status.name(entry.run) !== name) continue;
      entry.controller.abort();
      count++;
    }
    return count;
  }
  shutdown(): void {
    this.closed = true;
    for (const entry of this.entries.values()) entry.controller?.abort();
    this.entries.clear();
    this.names.clear();
    this.locks.shutdown();
    for (const timer of this.timers) clearInterval(timer);
    this.timers.clear();
  }
  private async start(entry: Entry, ctx: ExtensionToolContext, background: boolean, signal?: AbortSignal, onUpdate?: (details: Details) => void) {
    const { run } = entry;
    const controller = new AbortController();
    entry.controller = controller;
    const abort = () => controller.abort();
    if (!background) {
      if (signal?.aborted) abort();
      signal?.addEventListener("abort", abort, { once: true });
    }
    this.status.track(run.id, [run]);
    const options = { ...entry.options, conversation: entry.conversation };
    // Only background edit/write paths participate; bash is not intercepted.
    const writable = options.definition && childTools(ctx.tools, options.definition).some(tool => tool.name === "write" || tool.name === "edit");
    if (background && writable && options.config?.fileLocks) {
      this.locks.start(run, this.status.name(run));
      options.locks = this.locks;
    }
    if (!options.config?.resultFiles) options.results = undefined;
    // Budget mode is re-read on resume; model and effort remain the original selection.
    if (options.policy && options.config) {
      const mode = options.config.budgets;
      const profile = mode === "off" ? undefined : mode === "auto" ? taskProfile(run.task) : mode;
      options.policy = { ...options.policy, limits: profile ? LIMITS[profile] : undefined, profile };
    }
    let lastSnapshot = -Infinity, lastState = "";
    const update = () => {
      if (this.closed) return;
      this.status.publish(ctx);
      if (!background && (Date.now() - lastSnapshot >= 1000 || lastState !== run.status)) {
        lastSnapshot = Date.now(); lastState = run.status;
        onUpdate?.(details(run));
      }
    };
    const timer = setInterval(() => { if (!this.closed) this.status.publish(ctx); }, 1000);
    timer.unref();
    this.timers.add(timer);
    try {
      do {
        await runAgent(run, ctx, controller.signal, update, options);
      } while (entry.conversation.queue.length && !controller.signal.aborted && run.status === "completed");
    } catch (error) {
      run.status = controller.signal.aborted ? "aborted" : "failed";
      run.error = String(error);
    }
    // Freeze the foreground result before the slot is released; a later SendMessage may resume and reset the run.
    const result = { content: [{ type: "text" as const, text: foregroundText(run) }], details: details(run), usage: structuredClone(run.usage), isError: failed(run) };
    clearInterval(timer);
    this.timers.delete(timer);
    signal?.removeEventListener("abort", abort);
    entry.controller = undefined;
    this.locks.release(run);
    this.status.release(run.id, ctx);
    // Synchronous from here on, so no resume can interleave before the notification.
    if (!this.closed && entry.notify) {
      try {
        this.pi.sendMessage({ customType: RESULT_MESSAGE_TYPE, content: notification(run), display: true, details: details(run) }, { deliverAs: "followUp", triggerTurn: true });
      } catch (error) { ctx.ui.notify(`Agent notification: ${String(error)}`, "error"); }
    }
    return result;
  }
}
