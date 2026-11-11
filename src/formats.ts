import type { Run } from "./state.ts";
import { ASYNC_LAUNCH } from "./cc-texts.ts";

export const MAX_RESULT_CHARS = 100_000;
const TRUNCATED = "\n[Output truncated]";
const prefix = (text: string, length: number) => text.slice(0, Math.max(0, length)).replace(/[\uD800-\uDBFF]$/, "");
export function capResult(text: string, limit = MAX_RESULT_CHARS): string {
  if (text.length <= limit) return text;
  return limit < TRUNCATED.length ? prefix(text, limit) : prefix(text, limit - TRUNCATED.length) + TRUNCATED;
}
export function launchText(run: Run): string {
  return ASYNC_LAUNCH.replaceAll("${agentId}", run.id);
}
export function foregroundText(run: Run): string {
  const text = [run.error, run.resultText ?? run.output].filter(Boolean).join("\n\n");
  if (run.status !== "completed") return capResult(text);
  const body = text || "(Subagent completed but returned no output.)";
  if (["Explore", "Plan"].includes(run.task.subagent_type ?? "")) return capResult(body);
  const trailer = `\nagentId: ${run.id} (use SendMessage with to: '${run.id}', summary: '<5-10 word recap>' to continue this agent)\n<usage>subagent_tokens: ${run.tokens}\ntool_uses: ${run.toolUses}\nduration_ms: ${run.durationMs}</usage>`;
  return capResult(body, MAX_RESULT_CHARS - trailer.length) + trailer;
}
// CC inserts summary and result text verbatim (no XML escaping); only the length is bounded.
const bounded = (text: string, limit: number) => text.length <= limit ? text : prefix(text, limit - TRUNCATED.length) + TRUNCATED;
export function notification(run: Run): string {
  const state = run.status === "aborted" ? "killed" : run.status === "failed" ? "failed" : "completed";
  const summary = `Agent "${run.task.description}" ` + (state === "killed" ? "was stopped" : state === "failed" ? `failed: ${run.error}`
    : run.turnLimit ? `stopped at its ${run.turnLimit}-turn limit` : "finished");
  const result = run.resultText ?? run.output;
  const tail = `<usage>\n  <subagent_tokens>${run.tokens}</subagent_tokens>\n  <tool_uses>${run.toolUses}</tool_uses>\n  <duration_ms>${run.durationMs}</duration_ms>\n</usage>\n</task-notification>\n</system-reminder>`;
  const start = `<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>\n<task-id>${run.id}</task-id>\n<status>${state}</status>\n<summary>`;
  const endSummary = "</summary>\n";
  const summaryLimit = MAX_RESULT_CHARS - start.length - endSummary.length - tail.length - (result ? 19 + TRUNCATED.length : 0);
  const head = start + bounded(summary, summaryLimit) + endSummary;
  return head + (result ? `<result>${bounded(result, MAX_RESULT_CHARS - head.length - tail.length - 19)}</result>\n` : "") + tail;
}
