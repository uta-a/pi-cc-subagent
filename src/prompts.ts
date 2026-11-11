import fs from "node:fs";
import os from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Definition } from "./definitions.ts";
import { AUTHORITY, NOTES } from "./cc-texts.ts";

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

export function childSystem(definition: Definition, cwd: string, model: Model<Api>): string {
  let dir = resolve(cwd), git = false;
  for (;;) {
    if (fs.existsSync(join(dir, ".git"))) { git = true; break; }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const environment = `# Environment\nYou have been invoked in the following environment: \n - Primary working directory: ${cwd}\n - Is a git repository: ${git}\n - Platform: ${process.platform}\n - Shell: ${basename(process.env.SHELL ?? "unknown")}\n - OS Version: ${os.type()} ${os.release()}\nYou are powered by the model named ${model.name ?? model.id}. The exact model ID is ${model.id}.`;
  return [definition.prompt, AUTHORITY, NOTES, environment].join("\n\n");
}
const under = (path: string, dir: string) => { const rel = relative(dir, path); return !rel.startsWith("..") && !rel.startsWith("/"); };
export function userContext(definition: Definition, cwd: string, context?: ProjectContext): string {
  const files = !definition.omitClaudeMd && context?.cwd === cwd ? context.files : [];
  const label = (path: string) => under(path, cwd) ? "project instructions, checked into the codebase"
    : under(path, join(os.homedir(), ".pi")) || under(path, join(os.homedir(), ".claude"))
      ? "user's private global instructions for all projects" : "user's private project instructions, not checked in";
  const claudeMd = files.length ? `# claudeMd\nCodebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n\n${files.map(file => `Contents of ${resolve(cwd, file.path)} (${label(resolve(cwd, file.path))}):\n\n${file.content}`).join("\n\n")}\n` : "";
  const truncated = !definition.omitClaudeMd && context?.cwd === cwd && context.truncated ? "[Project context truncated at the 32 KiB whole-file budget]\n" : "";
  return `<system-reminder>\nAs you answer the user's questions, you can use the following context:\n${claudeMd}${truncated}# currentDate\nToday's date is ${new Date().toISOString().slice(0, 10)}.\n\n      Claude Code attached this context automatically; it isn't part of the user's message. It describes the user's own account and workspace, so they don't need it reported back.\n</system-reminder>`;
}
