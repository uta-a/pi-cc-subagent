import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { Tool } from "@earendil-works/pi-ai";
import { GENERAL_PROMPT, GENERAL_DESCRIPTION, EXPLORE_PROMPT, EXPLORE_DESCRIPTION, PLAN_PROMPT, PLAN_DESCRIPTION } from "./cc-texts.ts";

export interface Definition {
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  effort?: string | number;
  maxTurns?: number;
  background?: boolean;
  omitClaudeMd?: boolean;
}
export function builtins(): Definition[] {
  return [
    { name: "general-purpose", description: GENERAL_DESCRIPTION, prompt: GENERAL_PROMPT },
    { name: "Explore", description: EXPLORE_DESCRIPTION, prompt: EXPLORE_PROMPT, disallowedTools: ["edit", "write"], omitClaudeMd: true },
    { name: "Plan", description: PLAN_DESCRIPTION, prompt: PLAN_PROMPT, disallowedTools: ["edit", "write"], omitClaudeMd: true },
  ];
}
const core: Record<string, string> = { read: "read", grep: "grep", glob: "find", bash: "bash", edit: "edit", write: "write", ls: "ls", multiedit: "edit" };
const mapped = (name: string) => name.toLowerCase() === "notebookedit" ? "" : core[name.toLowerCase()] ?? name.toLowerCase();
export function childTools<T extends Tool>(tools: readonly T[], definition: Definition): T[] {
  const allow = definition.tools?.map(mapped);
  const deny = definition.disallowedTools?.map(mapped) ?? [];
  return tools.filter(tool => {
    const name = tool.name.toLowerCase();
    return !["agent", "sendmessage", "taskstop"].includes(name) && !name.includes("ask_user")
      && (!allow || allow.includes("*") || allow.includes(name)) && !deny.includes(name) && !deny.includes("*");
  });
}
/** CC's listing line, plus a Pi addition: the provider/model each agent runs on. */
export function agentListing(definitions: readonly Definition[], tools: readonly Tool[], modelOf?: (definition: Definition) => string): string {
  return "Available agent types for the Agent tool:\n" + definitions.map(def => {
    const allowed = def.tools && !def.tools.includes("*");
    const disallowed = tools.filter(tool => def.disallowedTools?.map(mapped).includes(tool.name.toLowerCase())).map(t => t.name);
    const summary = allowed ? childTools(tools, def).map(t => t.name).join(", ") || "None"
      : disallowed.length ? `All tools except ${disallowed.join(", ")}` : "All tools";
    return `- ${def.name}: ${def.description.replace(/\s+/g, " ")} (Tools: ${summary})${modelOf ? ` (Model: ${modelOf(def)})` : ""}`;
  }).join("\n");
}

function scalar(text: string): unknown {
  text = text.trim();
  if (text.startsWith('"')) return JSON.parse(text);
  if (text.startsWith("'")) {
    if (!text.endsWith("'")) throw new Error("Unclosed quote");
    return text.slice(1, -1).replace(/''/g, "'");
  }
  text = text.replace(/\s+#.*$/, "").trim();
  if (text === "true" || text === "false") return text === "true";
  if (/^-?\d+$/.test(text)) return Number(text);
  if (text.startsWith("[")) {
    if (!text.endsWith("]")) throw new Error("Unclosed list");
    return text.slice(1, -1).split(/,(?=(?:[^'\"]|'[^']*'|\"[^\"]*\")*$)/).filter(s => s.trim()).map(scalar);
  }
  return text;
}
export function parseDefinition(text: string): Definition {
  const match = text.replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) throw new Error("Missing YAML frontmatter");
  const fields: Record<string, unknown> = {};
  let list: string | undefined;
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && list) { (fields[list] as unknown[]).push(scalar(item[1])); continue; }
    const field = line.match(/^([\w]+):\s*(.*)$/);
    if (!field) throw new Error("Unsupported YAML line");
    list = field[2].trim() ? undefined : field[1];
    fields[field[1]] = list ? [] : scalar(field[2]);
  }
  if (typeof fields.name !== "string" || !fields.name.trim() || /^-|:/.test(fields.name)) throw new Error("Invalid name");
  if (typeof fields.description !== "string" || !fields.description.trim()) throw new Error("Missing required description");
  const def: Definition = { name: fields.name, description: fields.description.replace(/\\n/g, "\n"), prompt: match[2].trim() };
  for (const key of ["tools", "disallowedTools"] as const) {
    const value = fields[key];
    if (value === undefined) continue;
    const items = typeof value === "string" ? value.split(",").map(s => s.trim()).filter(Boolean) : value;
    if (!Array.isArray(items) || items.some(s => typeof s !== "string")) throw new Error(`Invalid ${key}`);
    def[key] = items;
  }
  if (fields.model !== undefined) {
    if (typeof fields.model !== "string") throw new Error("Invalid model");
    def.model = fields.model;
  }
  if (fields.effort !== undefined) {
    if (typeof fields.effort !== "number" && !["low", "medium", "high", "xhigh", "max"].includes(String(fields.effort))) throw new Error("Invalid effort");
    def.effort = fields.effort as string | number;
  }
  if (fields.maxTurns !== undefined) {
    if (!Number.isInteger(fields.maxTurns) || Number(fields.maxTurns) <= 0) throw new Error("Invalid maxTurns");
    def.maxTurns = fields.maxTurns as number;
  }
  for (const key of ["background", "omitClaudeMd"] as const) {
    if (fields[key] !== undefined && typeof fields[key] !== "boolean") throw new Error(`Invalid ${key}`);
    def[key] = fields[key] as boolean | undefined;
  }
  return def;
}

export class Definitions {
  private signature?: string;
  private active = builtins();
  constructor(private readonly home = os.homedir()) {}
  load(cwd: string, warn: (message: string) => void, force = false): Definition[] {
    const files: string[] = [];
    const errors: string[] = [];
    for (const dir of [join(this.home, ".claude/agents"), join(cwd, ".claude/agents")]) {
      try { files.push(...fs.readdirSync(dir).filter(f => f.endsWith(".md")).sort().map(f => join(dir, f))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(`${dir}: ${String(error)}`); }
    }
    const signature = cwd + files.map(file => {
      try { const stat = fs.statSync(file); return `${file}:${stat.mtimeMs}:${stat.size}`; }
      catch { return `${file}:missing`; }
    }).join("|");
    if (!force && signature === this.signature) return this.active;
    this.signature = signature;
    const definitions = new Map(builtins().map(def => [def.name, def]));
    for (const file of files) {
      try {
        const def = parseDefinition(fs.readFileSync(file, "utf8"));
        definitions.set(def.name, def);
        if (typeof def.effort === "number") errors.push(`${file}: integer effort ignored; inheriting parent thinking level`);
      } catch (error) { errors.push(`${file}: ${String(error)}`); }
    }
    if (errors.length) warn(errors.join("\n"));
    return this.active = [...definitions.values()];
  }
}
