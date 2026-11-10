import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { cap, runAgent, type RunnerOptions } from "./runner.ts";
import { resultsText } from "./results.ts";
import { FileLocks } from "./locks.ts";
import { createRun, type Details, type Run, type Task } from "./state.ts";
import type { AgentStatus } from "./status.ts";

export const MAX_BACKGROUND_AGENTS = 4;
export const MAX_BACKGROUND_WRITERS = 2;
const writable = (task: Task) => task.subagent_type !== "Explore" && task.subagent_type !== "Plan";
export const RESULT_MESSAGE_TYPE = "cc-subagent-result";

/** Background capacity is reserved atomically per call; no waiting queue. */
export class BackgroundAgents {
  private jobs = new Map<Run, AbortController>();
  private timers = new Set<ReturnType<typeof setInterval>>();
  private closed = false;
  constructor(private readonly pi: ExtensionAPI, private readonly status: AgentStatus, private readonly locks = new FileLocks()) {}

  get size(): number { return this.jobs.size; }

  hasCapacity(tasks: Task[]): boolean {
    const writers = [...this.jobs.keys()].filter(run => writable(run.task)).length;
    return !this.closed && this.jobs.size + tasks.length <= MAX_BACKGROUND_AGENTS
      && writers + tasks.filter(writable).length <= MAX_BACKGROUND_WRITERS;
  }

  launch(tasks: Task[], ctx: ExtensionToolContext, options: RunnerOptions = {}) {
    if (this.closed) throw new Error("Subagent extension has shut down");
    if (!this.hasCapacity(tasks)) {
      throw new Error(`Background capacity exceeded: at most ${MAX_BACKGROUND_AGENTS} agents and ${MAX_BACKGROUND_WRITERS} writable agents across all calls (${this.jobs.size} active). Nothing started; retry when agents finish.`);
    }
    const runs = tasks.map(createRun);
    const key = Symbol("background");
    this.status.track(key, runs);
    // Reserve all slots before starting any model request. Never inherit the parent signal.
    for (const run of runs) {
      this.jobs.set(run, new AbortController());
      if (writable(run.task)) this.locks.start(run, this.status.name(run));
    }
    const update = () => { if (!this.closed) this.status.publish(ctx); };
    const timer = setInterval(update, 1000);
    timer.unref();
    this.timers.add(timer);
    const work = runs.map(async run => {
      const controller = this.jobs.get(run)!;
      try {
        await runAgent(run, ctx, controller.signal, update, { ...options, label: this.status.name(run), locks: writable(run.task) ? this.locks : undefined });
      } catch (error) {
        // Also settle unexpected runner/UI failures without losing the other results.
        run.status = controller.signal.aborted ? "aborted" : "failed";
        run.error = controller.signal.aborted ? "Interrupted" : cap(String(error), 2048);
      } finally {
        this.jobs.delete(run);
        this.locks.release(run);
      }
    });
    void this.finish(work, runs, key, timer, ctx).catch(error => {
      if (!this.closed) ctx.ui.notify(`Background agents: ${String(error)}`, "error");
    });
    return {
      content: [{ type: "text" as const, text: `Launched background agents:\n${runs.map(run => `- ${this.status.name(run)}: ${run.task.description}`).join("\n")}\nResults will be delivered later as a message. Avoid editing the same files as background writers; wait for their result message and do not relaunch their work.` }],
      // This is a launch receipt, not a live transcript. The renderer must not imply it is still running.
      details: structuredClone({ runs, background: true }) satisfies Details,
    };
  }

  stop(name?: string): number {
    let count = 0;
    for (const [run, controller] of this.jobs) {
      if (name && this.status.name(run) !== name) continue;
      controller.abort();
      count++;
    }
    return count;
  }

  shutdown(): void {
    this.closed = true;
    this.stop();
    this.locks.shutdown();
    for (const timer of this.timers) clearInterval(timer);
    this.timers.clear();
  }

  private async finish(work: Promise<void>[], runs: Run[], key: symbol, timer: ReturnType<typeof setInterval>, ctx: ExtensionToolContext): Promise<void> {
    try {
      await Promise.all(work);
    } finally {
      clearInterval(timer);
      this.timers.delete(timer);
      this.status.release(key, ctx);
    }
    if (this.closed) return;
    this.pi.sendMessage({
      customType: RESULT_MESSAGE_TYPE,
      content: resultsText(runs),
      display: true,
      details: structuredClone({ runs }) satisfies Details,
    }, { deliverAs: "followUp", triggerTurn: true });
  }
}
