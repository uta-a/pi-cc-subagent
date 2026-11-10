import { resolve } from "node:path";
import type { Run } from "./state.ts";

export function mutationPath(name: string, args: Record<string, unknown>, cwd: string): string | undefined {
  return (name === "write" || name === "edit") && typeof args.path === "string"
    ? resolve(cwd, args.path.replace(/^@/, "")) : undefined;
}

/** Lexical path locks, held for a background writer's entire lifetime. */
export class FileLocks {
  private owners = new Map<string, Run | "main">();
  private writers = new Map<Run, string>();
  private pendingMain = new Map<string, string>();
  private committedMain = new Set<string>();
  private closed = false;

  start(run: Run, name: string): void { if (!this.closed) this.writers.set(run, name); }

  claim(run: Run, path: string): string | undefined {
    if (this.closed) return "Session shut down; report the conflict instead of retrying.";
    const owner = this.owners.get(path);
    if (owner && owner !== run) {
      return `${path} is locked by ${owner === "main" ? "main" : `background agent ${this.writers.get(owner)}`}; report the conflict instead of retrying.`;
    }
    this.owners.set(path, run);
    return undefined;
  }

  mainCall(id: string, path: string): { block: true; reason: string } | undefined {
    if (this.closed || !this.writers.size) return;
    const owner = this.owners.get(path);
    if (owner && owner !== "main") {
      const name = this.writers.get(owner);
      return { block: true, reason: `${path} is being modified by background agent ${name}; wait for its result message or stop it with /cc-agents-stop ${name}.` };
    }
    // Reserve before execution too, closing the preflight/result race with children.
    this.owners.set(path, "main");
    this.pendingMain.set(id, path);
  }

  mainEnd(id: string, isError: boolean): void {
    const path = this.pendingMain.get(id);
    if (!path) return;
    this.pendingMain.delete(id);
    if (!isError) this.committedMain.add(path);
    if (!this.committedMain.has(path) && ![...this.pendingMain.values()].includes(path)) this.owners.delete(path);
  }

  release(run: Run): void {
    this.writers.delete(run);
    for (const [path, owner] of this.owners) if (owner === run) this.owners.delete(path);
    if (!this.writers.size) {
      this.owners.clear();
      this.pendingMain.clear();
      this.committedMain.clear();
    }
  }

  shutdown(): void {
    this.closed = true;
    this.writers.clear();
    this.owners.clear();
    this.pendingMain.clear();
    this.committedMain.clear();
  }
}
