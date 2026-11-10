import type { Api, Model } from "@earendil-works/pi-ai";
import type { Effort, Profile, Task } from "./state.ts";

export const LIMITS = {
  quick: { turns: 6, toolUses: 12, response: 2048, output: 4096, toolBytes: 4096 },
  balanced: { turns: 12, toolUses: 24, response: 4096, output: 12000, toolBytes: 8192 },
  deep: { turns: 20, toolUses: 48, response: 8192, output: 24000, toolBytes: 12288 },
} as const;

export function taskProfile(task: Task): Profile {
  if (task.profile && task.profile !== "auto") return task.profile;
  const text = `${task.description} ${task.prompt}`;
  if (task.subagent_type === "Plan" || /architecture|race condition|deadlock|security audit|cryptograph|セキュリティ監査|脆弱性|デッドロック|競合状態|アーキテクチャ|設計判断/i.test(text)) return "deep";
  if (task.subagent_type === "Explore" || /\b(typo|rename|formatting)\b|誤字|軽微な修正|表記ゆれ/.test(text)) return "quick";
  return "balanced";
}

const fast = (model: Model<Api>) => /haiku|(?:^|[-_.])mini(?:$|[-_.])|flash/i.test(model.id);
const sonnet = (model: Model<Api>) => /sonnet/i.test(model.id);
const opus = (model: Model<Api>) => /opus/i.test(model.id);

/** Deterministic routing: no extra classifier/model request and no unlisted providers. */
export function choosePolicy(task: Task, parent: Model<Api>, available: readonly Model<Api>[]) {
  const profile = taskProfile(task);
  let model = parent;
  const requested = task.model;
  if (requested && requested !== "auto" && requested !== "inherit") {
    const candidates = available.filter(candidate => requested === `${candidate.provider}/${candidate.id}` || (!requested.includes("/") && requested === candidate.id));
    if (candidates.length !== 1) throw new Error(`Model unavailable or ambiguous: ${requested}. Use an available provider/model ID.`);
    model = candidates[0];
  } else if (requested !== "inherit") {
    let preferred: Model<Api>[] = [];
    if (profile === "quick") preferred = available.filter(fast);
    else if (profile === "balanced" && (opus(parent) || fast(parent))) preferred = available.filter(sonnet);
    else if (profile === "deep" && (fast(parent) || sonnet(parent))) preferred = available.filter(opus);
    // Prefer the current provider, then a known smaller family; prefer newer IDs within a family.
    preferred.sort((a, b) => Number(b.provider === parent.provider) - Number(a.provider === parent.provider)
      || Number(/haiku/i.test(b.id)) - Number(/haiku/i.test(a.id))
      || a.provider.localeCompare(b.provider)
      || b.id.localeCompare(a.id, "en", { numeric: true }));
    model = preferred[0] ?? parent;
  }
  const defaultEffort = { quick: "minimal", balanced: "low", deep: "medium" } as const;
  const effort: Effort = !model.reasoning ? "off" : task.effort && task.effort !== "auto" ? task.effort : defaultEffort[profile];
  return { model, effort, profile, limits: LIMITS[profile] };
}
