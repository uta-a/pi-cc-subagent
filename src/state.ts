import type { Usage } from "@earendil-works/pi-ai";

export type Profile = "quick" | "balanced" | "deep";
export type Effort = "off" | "minimal" | "low" | "medium" | "high";
export type Status = "pending" | "running" | "completed" | "failed" | "aborted";
export interface Task {
  description: string;
  prompt: string;
  subagent_type?: "Explore" | "Plan" | "general-purpose";
  /** Optional display name, e.g. "researcher"; does not change permissions or routing. */
  name?: string;
  profile?: Profile | "auto";
  model?: string;
  effort?: Effort | "auto";
}
export interface Activity {
  text: string;
  kind: "tool" | "text";
  error?: boolean;
}
export interface Run {
  task: Task;
  status: Status;
  startedAt: number;
  durationMs: number;
  toolUses: number;
  tokens: number;
  usage: Usage;
  activities: Activity[];
  output: string;
  liveText?: string;
  currentActivity?: string;
  model?: string;
  effort?: Effort;
  profile?: Profile;
  error?: string;
}
export interface Details {
  runs: Run[];
}
export function emptyUsage(): Usage {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
export function addUsage(target: Usage, usage: Usage): void {
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) target[key] += usage[key];
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) target.cost[key] += usage.cost[key];
}
export function createRun(task: Task): Run {
  return { task, status: "pending", startedAt: 0, durationMs: 0, toolUses: 0, tokens: 0, usage: emptyUsage(), activities: [], output: "" };
}
export const MAX_NAME_LENGTH = 24;
/** Single-line, bounded display name; undefined when absent or blank. */
export function customName(task: Task): string | undefined {
  const clean = task.name?.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
  return clean ? [...clean].slice(0, MAX_NAME_LENGTH).join("") : undefined;
}
export function active(run: Run): boolean {
  return run.status === "running" || run.status === "pending";
}
export function failed(run: Run): boolean {
  return run.status === "failed" || run.status === "aborted";
}
export function toolLabel(name: string, args: Record<string, unknown>): string {
  const names: Record<string, string> = { read: "Read", bash: "Bash", grep: "Search", find: "Search", ls: "List", edit: "Update", write: "Write" };
  const value = args.path ?? args.command ?? args.pattern ?? "";
  return `${names[name] ?? name}(${String(value).replace(/\s+/g, " ").trim()})`;
}
