import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Profile } from "./state.ts";

export interface Settings {
  maxConcurrent: number;
  defaultModel?: string;
  budgets: "off" | "auto" | Profile;
  autoModel: boolean;
  resultFiles: boolean;
  fileLocks: boolean;
}
export function settings(pi: ExtensionAPI): Settings {
  const all = pi.getSettings() as Record<string, unknown>;
  const raw = all.ccSubagent;
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return {
    maxConcurrent: Number.isInteger(value.maxConcurrent) && Number(value.maxConcurrent) > 0 ? Number(value.maxConcurrent) : 20,
    defaultModel: typeof value.defaultModel === "string" && value.defaultModel.trim() ? value.defaultModel : undefined,
    budgets: typeof value.budgets === "string" && ["off", "auto", "quick", "balanced", "deep"].includes(value.budgets) ? value.budgets as Settings["budgets"] : "off",
    autoModel: value.autoModel === true,
    resultFiles: value.resultFiles === true,
    fileLocks: typeof value.fileLocks === "boolean" ? value.fileLocks : true,
  };
}
