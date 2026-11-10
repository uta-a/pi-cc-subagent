import { renderRuns, type Palette } from "../src/render.ts";
import { demoRuns } from "../src/preview.ts";
const theme = {
  fg(color: string, text: string) {
    const code = ({ dim: 90, success: 32, warning: 33, error: 31 } as Record<string, number>)[color] ?? 37;
    return `\x1b[${code}m${text}\x1b[0m`;
  },
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
} as Palette;
for (const runs of demoRuns()) {
  console.log(renderRuns(runs, theme, { expanded: process.argv.includes("--expanded"), hint: "ctrl+o to expand" }).render(process.stdout.columns ?? 100).join("\n") + "\n");
}
