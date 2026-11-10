import type { Task } from "./state.ts";

export const MAX_CONTEXT_BYTES = 32 * 1024;
export interface ProjectContext {
  cwd: string;
  files: { path: string; content: string }[];
  truncated: boolean;
}

/** Keep a whole-file prefix, including path bytes, without retaining the source array. */
export function captureContext(files: { path: string; content: string }[] | undefined, cwd: string): ProjectContext | undefined {
  try {
    if (!files?.length) return;
    const captured: ProjectContext = { cwd, files: [], truncated: false };
    let bytes = 0;
    for (const file of files) {
      const size = Buffer.byteLength(file.path) + Buffer.byteLength(file.content);
      if (bytes + size > MAX_CONTEXT_BYTES) { captured.truncated = true; break; }
      captured.files.push({ path: file.path, content: file.content });
      bytes += size;
    }
    return captured;
  } catch { return undefined; }
}

export function roleContract(type: Task["subagent_type"]): string {
  if (type === "Explore") return "Start from paths/symbols in the task; use find/grep narrowly before reading, and read only needed ranges. Quote at most about 5 lines of code. Report: ## Findings (bullets with path:line ranges), ## Start here, ## Gaps.";
  if (type === "Plan") return "Stay read-only. Report: ## Recommendation, ## Steps, ## Risks, ## Open questions.";
  return "Report: ## Changed files, ## Validation (commands run and results), ## Open risks, ## Next step. Never claim success if you did not make the required edits or validation failed. If a decision is not approved by the task, stop and report ## Needs decision with options instead of guessing.";
}

export function usesProjectPrompt(type: Task["subagent_type"], cwd: string, context?: ProjectContext): context is ProjectContext {
  return (type === "Explore" || type === "Plan") && !!context?.files.length && context.cwd === cwd;
}

export function promptBase(type: Task["subagent_type"], cwd: string, parent: () => string, context?: ProjectContext): string {
  if (!usesProjectPrompt(type, cwd, context)) return parent();
  return `You are a read-only ${type} subagent assisting a coding agent.\nWorking directory: ${cwd}\nToday's date: ${new Date().toISOString().slice(0, 10)}\n<project_context>\n${context.files.map(file => `File: ${file.path}\n${file.content}`).join("\n\n")}\n${context.truncated ? "[Project context truncated at the 32 KiB whole-file budget]\n" : ""}</project_context>`;
}
