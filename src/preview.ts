import { createRun, type Run } from "./state.ts";

/** Synthetic fixtures, never represented as real agent results. */
export function demoRuns(): Run[][] {
  const done = createRun({ subagent_type: "Explore", description: "Find authentication flow [demo]", prompt: "Find the authentication entry point and summarize the session lifecycle." });
  Object.assign(done, { status: "completed", toolUses: 7, tokens: 12400, durationMs: 23400, output: "Authentication starts in src/auth.ts. Session validation is handled by middleware." });
  done.activities = [{ kind: "tool", text: "Search(auth)" }, { kind: "tool", text: "Read(src/auth.ts)" }];
  const running = structuredClone(done);
  Object.assign(running, { status: "running", output: "", durationMs: 0 });
  running.activities.push({ kind: "tool", text: "Read(src/session.ts)" }, { kind: "tool", text: "Search(validateSession)" });
  const second = createRun({ subagent_type: "Explore", description: "Inspect test coverage [demo]", prompt: "Inspect authentication tests." });
  Object.assign(second, { status: "running", toolUses: 3, tokens: 8200 });
  second.activities.push({ kind: "tool", text: "Read(test/auth.test.ts)" });
  const error = createRun({ subagent_type: "Plan", description: "Interrupted task [demo]", prompt: "Plan a refactor." });
  Object.assign(error, { status: "aborted", error: "Interrupted" });
  return [[running], [done], [running, second], [error]];
}
