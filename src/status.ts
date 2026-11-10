import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { rgbColor } from "@earendil-works/pi-tui";
import type { Run } from "./state.ts";
import { formatDuration, formatTokens } from "./render.ts";

export type StatusPalette = Pick<Theme, "style">;

export const STATUS_KEY = "cc-subagent";
const MAX_BADGES = 8;
const WHITE = rgbColor(255, 255, 255);
const GRAY = rgbColor(153, 153, 153);

export function agentRole(run: Run): "explore" | "plan" | "worker" {
  if (run.task.subagent_type === "Explore") return "explore";
  if (run.task.subagent_type === "Plan") return "plan";
  return "worker";
}

/** CC's footer shows live agents, not completed transcript rows. Dot labels are our adaptation. */
export function renderAgentStatus(runs: readonly Run[], theme: StatusPalette, labels?: WeakMap<Run, string>, now = Date.now(), selected: Run | null = null): string | undefined {
  const counts = new Map<string, number>();
  const named = runs.map(run => {
    const role = agentRole(run);
    const count = (counts.get(role) ?? 0) + 1;
    counts.set(role, count);
    return { run, role, label: labels?.get(run) ?? (count === 1 ? role : `${role}-${count}`) };
  });
  const running = named.filter(({ run }) => run.status === "running");
  if (!running.length) return undefined;
  const gray = (text: string) => theme.style(text, { fg: GRAY });
  const rows = [theme.style(`${selected ? "○" : "●"} main`, { fg: selected ? GRAY : WHITE, bold: !selected })];
  for (const { run, label } of running.slice(0, MAX_BADGES)) {
    const name = label.replace(/^explore/, "Explore").replace(/^plan/, "Plan");
    const description = run.task.description.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim();
    const elapsed = run.startedAt > 0 ? Math.max(0, now - run.startedAt) : 0;
    const arrow = run.activities.length ? "↓" : "↑";
    const stats = `${formatDuration(elapsed)} · ${arrow} ${formatTokens(run.tokens)} tokens`;
    // The companion footer lays out these tab-separated columns using its actual render width.
    const style = (text: string) => selected === run ? theme.style(text, { fg: WHITE, bold: true }) : gray(text);
    rows.push(`${style(`${selected === run ? "●" : "○"} ${name}  ${description}`)}\t${style(stats)}`);
  }
  if (running.length > MAX_BADGES) rows.push(gray(`+${running.length - MAX_BADGES} more`));
  return rows.join("\n");
}

/** Owns only our status key; never replaces the user's footer or other statuses. */
export class AgentStatus {
  private groups = new Map<string | symbol, readonly Run[]>();
  private labels = new WeakMap<Run, string>();
  private counts = new Map<string, number>();
  private closed = false;
  private last: string | undefined;
  selectedRun: Run | null = null;
  selecting = false;

  running(): Run[] {
    return [...this.groups.values()].flat().filter(run => run.status === "running").slice(0, MAX_BADGES);
  }

  name(run: Run): string {
    return (this.labels.get(run) ?? agentRole(run)).replace(/^explore/, "Explore").replace(/^plan/, "Plan");
  }

  move(direction: number, ctx: ExtensionContext): void {
    const rows: (Run | null)[] = [null, ...this.running()];
    const index = Math.max(0, rows.indexOf(this.selectedRun));
    this.selectedRun = rows[(index + direction + rows.length) % rows.length];
    this.selecting = true;
    this.publish(ctx);
  }

  deselect(ctx: ExtensionContext): void {
    this.selectedRun = null;
    this.selecting = false;
    this.publish(ctx);
  }

  track(id: string | symbol, runs: readonly Run[]): void {
    if (this.closed) return;
    if (!this.groups.size) this.counts.clear();
    for (const run of runs) {
      if (this.labels.has(run)) continue;
      const role = agentRole(run);
      const count = (this.counts.get(role) ?? 0) + 1;
      this.counts.set(role, count);
      this.labels.set(run, count === 1 ? role : `${role}-${count}`);
    }
    this.groups.set(id, runs);
  }

  publish(ctx: ExtensionContext): void {
    if (this.closed || ctx.mode !== "tui") return;
    const running = this.running();
    if (!running.length) { this.selectedRun = null; this.selecting = false; }
    else if (this.selectedRun && !running.includes(this.selectedRun)) this.selectedRun = null;
    const text = renderAgentStatus([...this.groups.values()].flat(), ctx.ui.theme, this.labels, Date.now(), this.selectedRun);
    if (text === this.last) return;
    this.last = text;
    ctx.ui.setStatus(STATUS_KEY, text);
  }

  release(id: string | symbol, ctx: ExtensionContext): void {
    this.groups.delete(id);
    this.publish(ctx);
  }

  shutdown(ctx: ExtensionContext): void {
    this.closed = true;
    this.groups.clear();
    this.last = undefined;
    if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
  }
}
