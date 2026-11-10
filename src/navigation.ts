import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AgentStatus } from "./status.ts";
import type { Run } from "./state.ts";

export function safeText(text: string): string {
  return text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
    .replace(/\t/g, "  ");
}

export function agentDetailLines(run: Run): string[] {
  return [
    `Task: ${run.task.description}`,
    `Status: ${run.status}`,
    `Usage: ${run.usage.totalTokens} cumulative tokens · $${run.usage.cost.total.toFixed(4)}`,
    ...(run.model ? [`Model: ${run.model} · effort: ${run.effort ?? "off"} · profile: ${run.profile ?? "balanced"}`] : []),
    `Now: ${run.currentActivity ?? run.activities.at(-1)?.text ?? "Waiting for model response…"}`,
    "", "Prompt:", run.task.prompt,
    "", "Activity:",
    ...run.activities.slice(-30).map(item => `${item.error ? "Error: " : ""}${item.text}`),
    ...(run.liveText ? ["", "Streaming response:", run.liveText] : []),
    ...(run.output ? ["", "Response:", run.output] : []),
    ...(run.error ? ["", `Error: ${run.error}`] : []),
  ];
}

/** Pi overlay adaptation of CC's select/view/return state machine; does not replace the transcript. */
export class AgentNavigation {
  private restoreEditors = new Set<() => void>();
  private installedFactory?: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;
  private closeView?: () => void;
  private viewOpen = false;
  private closed = false;
  constructor(private readonly status: AgentStatus) {}

  attach(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui" || this.closed) return;
    const previous = ctx.ui.getEditorComponent();
    if (this.installedFactory && previous === this.installedFactory) return;
    const factory: NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>> = (tui, theme, keybindings) => {
      const editor = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
      const original = editor.handleInput.bind(editor);
      editor.handleInput = data => {
        if (!this.handleEditorInput(data, ctx, editor.getText())) original(data);
        if (!this.closed && editor.getText().length && this.status.selecting) this.status.deselect(ctx);
      };
      this.restoreEditors.add(() => { editor.handleInput = original; });
      return editor;
    };
    this.installedFactory = factory;
    ctx.ui.setEditorComponent(factory);
  }

  private handleEditorInput(data: string, ctx: ExtensionContext, editorText: string): boolean {
      if (this.closed || this.viewOpen || !this.status.running().length) return false;
      if (editorText.length) return false;
      // Only the focused editor invokes this method, never permission/selection dialogs.
      if (!this.status.selecting && (matchesKey(data, "up") || matchesKey(data, "shift+up"))) return false;
      if (matchesKey(data, "up") || matchesKey(data, "shift+up")) {
        this.status.move(-1, ctx); return true;
      }
      if (matchesKey(data, "down") || matchesKey(data, "shift+down")) {
        this.status.move(1, ctx); return true;
      }
      if (matchesKey(data, "return") && this.status.selecting) {
        void this.open(ctx).catch(error => {
          if (!this.closed) ctx.ui.notify(`Agent view: ${String(error)}`, "error");
        });
        return true;
      }
      if (matchesKey(data, "escape") && this.status.selecting) {
        this.status.deselect(ctx); return true;
      }
      return false;
  }

  async open(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui" || this.viewOpen || this.closed) return;
    const initial = this.status.selectedRun;
    if (!initial) return;
    let viewed: Run = initial;
    this.viewOpen = true;
    let scroll = 0;
    let returnedToMain = false;
    try {
      await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
        let disposed = false;
        let finished = false;
        const close = () => { if (!disposed && !finished) { finished = true; done(); } };
        this.closeView = close;
        const timer = setInterval(() => { if (!this.closed && !disposed) tui.requestRender(); }, 1000);
        timer.unref();
        return {
          invalidate() {},
          dispose: () => { disposed = true; clearInterval(timer); this.closeView = undefined; },
          render: (width: number) => {
            const height = Math.max(4, Math.floor(tui.terminal.rows * 0.75));
            const title = this.status.name(viewed);
            const body = agentDetailLines(viewed);
            const content = body.flatMap(line => wrapTextWithAnsi(safeText(line), Math.max(1, width - 2)));
            const pageSize = Math.max(1, height - 3);
            scroll = Math.max(0, Math.min(scroll, Math.max(0, content.length - pageSize)));
            const header = theme.bold(` ${title} — live activity`);
            const help = theme.fg("dim", " ↑↓ switch agent · Enter return · PgUp/PgDn scroll · Esc close");
            return [header, "", ...content.slice(scroll, scroll + pageSize).map(line => ` ${line}`), help]
              .map(line => truncateToWidth(line, Math.max(0, width)));
          },
          handleInput: (data: string) => {
            if (keybindings.matches(data, "tui.select.cancel") || matchesKey(data, "return")) { close(); return; }
            if (matchesKey(data, "up") || matchesKey(data, "down")) {
              this.status.move(matchesKey(data, "up") ? -1 : 1, ctx);
              const next = this.status.selectedRun;
              if (!next) { returnedToMain = true; close(); return; }
              viewed = next;
              scroll = 0;
            } else if (matchesKey(data, "pageUp")) scroll = Math.max(0, scroll - 8);
            else if (matchesKey(data, "pageDown")) scroll += 8;
            else return;
            tui.requestRender();
          },
        };
      }, { overlay: true, overlayOptions: { width: "95%", maxHeight: "80%", anchor: "center" } });
    } finally {
      this.viewOpen = false;
      this.closeView = undefined;
      if (!this.closed && !returnedToMain) this.status.deselect(ctx);
    }
  }

  shutdown(): void {
    this.closed = true;
    for (const restore of this.restoreEditors) restore();
    this.restoreEditors.clear();
    this.closeView?.();
  }
}
