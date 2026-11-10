import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { cap, runAgent } from "./runner.ts";
import { createRun, type Details, type Run, type Task } from "./state.ts";
import type { AgentStatus } from "./status.ts";

export const MAX_BACKGROUND_AGENTS = 4;
export const RESULT_MESSAGE_TYPE = "cc-subagent-result";

/** Background capacity is reserved atomically per call; no waiting queue. */
export class BackgroundAgents {
  private jobs = new Map<Run, AbortController>();
  private timers = new Set<ReturnType<typeof setInterval>>();
  private closed = false;
  constructor(private readonly pi: ExtensionAPI, private readonly status: AgentStatus) {}

  get size(): number { return this.jobs.size; }

  hasCapacity(count: number): boolean { return !this.closed && this.jobs.size + count <= MAX_BACKGROUND_AGENTS; }

  launch(tasks: Task[], ctx: ExtensionToolContext) {
    if (this.closed) throw new Error("Subagent extension has shut down");
    if (tasks.some(task => task.subagent_type !== "Explore" && task.subagent_type !== "Plan")) {
      throw new Error("Background execution requires every task to be read-only (subagent_type Explore or Plan).");
    }
    if (this.jobs.size + tasks.length > MAX_BACKGROUND_AGENTS) {
      throw new Error(`Background capacity exceeded: at most ${MAX_BACKGROUND_AGENTS} agents across all calls (${this.jobs.size} active). Nothing started; retry when agents finish.`);
    }
    const runs = tasks.map(createRun);
    const key = Symbol("background");
    this.status.track(key, runs);
    // Reserve all slots before starting any model request. Never inherit the parent signal.
    for (const run of runs) this.jobs.set(run, new AbortController());
    const update = () => { if (!this.closed) this.status.publish(ctx); };
    const timer = setInterval(update, 1000);
    timer.unref();
    this.timers.add(timer);
    const work = runs.map(async run => {
      const controller = this.jobs.get(run)!;
      try {
        await runAgent(run, ctx, controller.signal, update);
      } catch (error) {
        // Also settle unexpected runner/UI failures without losing the other results.
        run.status = controller.signal.aborted ? "aborted" : "failed";
        run.error = controller.signal.aborted ? "Interrupted" : cap(String(error), 2048);
      } finally {
        this.jobs.delete(run);
      }
    });
    void this.finish(work, runs, key, timer, ctx).catch(error => {
      if (!this.closed) ctx.ui.notify(`Background agents: ${String(error)}`, "error");
    });
    return {
      content: [{ type: "text" as const, text: `Launched background agents:\n${runs.map(run => `- ${this.status.name(run)}: ${run.task.description}`).join("\n")}\nResults will be delivered later as a message.` }],
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
      content: cap(runs.map(run => `## ${run.task.description} [${run.status}]\n${run.error ?? run.output}`).join("\n\n")),
      display: true,
      details: structuredClone({ runs }) satisfies Details,
    }, { deliverAs: "followUp", triggerTurn: true });
  }
}
