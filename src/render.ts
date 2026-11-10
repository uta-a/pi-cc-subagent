import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { active, failed, type Run } from "./state.ts";

export type Palette = Pick<Theme, "fg" | "bold">;
export interface ViewOptions {
  expanded: boolean;
  hint: string;
  rows?: number;
  now?: number;
}

// Independently implemented from observed output of the official 2.1.19 bundle.
export function formatTokens(tokens: number): string {
  return new Intl.NumberFormat("en", {
    notation: "compact", minimumFractionDigits: tokens >= 1000 ? 1 : 0, maximumFractionDigits: 1,
  }).format(tokens).toLowerCase();
}
export function formatDuration(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  let seconds = Math.round(ms / 1000);
  const days = Math.floor(seconds / 86400); seconds %= 86400;
  const hours = Math.floor(seconds / 3600); seconds %= 3600;
  const minutes = Math.floor(seconds / 60); seconds %= 60;
  if (days) return `${days}d ${hours}h ${minutes}m`;
  if (hours) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}
export function stats(run: Run): string {
  return `${run.toolUses} tool ${run.toolUses === 1 ? "use" : "uses"} · ${formatTokens(run.tokens)} tokens`;
}
export function summary(run: Run): string {
  if (run.status === "pending") return "Queued…";
  if (run.status === "aborted") return "Interrupted";
  if (run.status === "failed") return `Error: ${run.error ?? "Agent failed"}`;
  if (run.status === "completed") return `Done (${stats(run)} · ${formatDuration(run.durationMs)})`;
  return run.activities.at(-1)?.text ?? "Initializing…";
}

export function renderRuns(runs: Run[], theme: Palette, options: ViewOptions): Component {
  return {
    invalidate() {},
    render(width) {
      const lines: string[] = [];
      const dim = (s: string) => theme.fg("dim", s);
      const body = (prefix: string, text: string, wrap = false) => {
        if (!wrap) { lines.push(truncateToWidth(prefix + text, width)); return; }
        const available = Math.max(1, width - 6);
        for (const part of text.split("\n")) {
          for (const line of wrapTextWithAnsi(part, available)) lines.push(truncateToWidth(prefix + line, width));
        }
      };
      const hint = options.hint ? dim(` (${options.hint})`) : "";
      if (runs.length > 1) {
        const running = runs.some(active);
        const sameType = runs.every(r => (r.task.subagent_type ?? "general-purpose") === (runs[0].task.subagent_type ?? "general-purpose"));
        const type = sameType ? `${runs[0].task.subagent_type ?? "general-purpose"} agents` : "agents";
        lines.push(`${theme.fg(runs.some(failed) ? "error" : running ? "warning" : "success", "●")} ${running ? "Running " : ""}${theme.bold(String(runs.length))} ${type}${running ? "…" : " finished"}${hint}`);
        runs.forEach((run, i) => {
          const last = i === runs.length - 1;
          const title = sameType ? theme.bold(run.task.description) : `${theme.bold(run.task.subagent_type ?? "general-purpose")} (${run.task.description})`;
          body(`   ${last ? "└─" : "├─"} `, `${title} · ${stats(run)}`);
          body(`   ${last ? " " : "│"}  `, dim(summary(run)));
          if (options.expanded) details(run, `   ${last ? " " : "│"}  `);
        });
      } else if (runs[0]) {
        const run = runs[0];
        const type = run.task.subagent_type === "general-purpose" || !run.task.subagent_type ? "Task" : run.task.subagent_type;
        body("", `${theme.fg(failed(run) ? "error" : active(run) ? "warning" : "success", "●")} ${theme.bold(type)}(${run.task.description})${hint}`);
        if (options.expanded) details(run, "     ");
        if (active(run) && !options.expanded) {
          const compact = (options.rows ?? 40) < 16;
          if (compact) body("  ⎿  ", dim(`In progress… · ${stats(run)}`));
          else {
            const activities = run.activities.slice(-3);
            if (!activities.length) body("  ⎿  ", dim(summary(run)));
            activities.forEach((item, i) => body(i === 0 ? "  ⎿  " : "     ", theme.fg(item.error ? "error" : "dim", item.text)));
            const hidden = run.activities.length - activities.length;
            if (hidden > 0) body("     ", dim(`+${hidden} more tool ${hidden === 1 ? "use" : "uses"}${options.hint ? ` (${options.hint})` : ""}`));
          }
        } else {
          body("  ⎿  ", theme.fg(failed(run) ? "error" : "dim", summary(run)));
        }
      }
      function details(run: Run, prefix: string) {
        body(prefix, theme.fg("success", theme.bold("Prompt:")));
        body(prefix + "  ", run.task.prompt, true);
        for (const item of run.activities) body(prefix, theme.fg(item.error ? "error" : "dim", item.text), true);
        if (run.output) {
          body(prefix, theme.fg("success", theme.bold("Response:")));
          body(prefix + "  ", run.output, true);
        }
        if (run.error) body(prefix, theme.fg("error", run.error), true);
      }
      return lines.map(line => truncateToWidth(line, Math.max(0, width)));
    },
  };
}
