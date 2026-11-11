import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Api, Model, AssistantMessage, Message, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import extension from "../src/index.ts";
import { emptyUsage, type Details } from "../src/state.ts";

export const flush = () => new Promise<void>(resolve => setImmediate(resolve));
export const task = { description: "Find code", prompt: "Find code" };
export const model = (id = "claude-opus-4-6", provider = "test", reasoning = true) => ({ id, name: id, provider, reasoning, maxTokens: 32768 } as Model<Api>);
export function response(text = "Done", tool?: string): AssistantMessage {
  return { role: "assistant", content: tool ? [{ type: "toolCall", id: `call-${Math.random()}`, name: tool, arguments: { path: "shared.ts" } }] : [{ type: "text", text }], api: "anthropic-messages", provider: "test", model: "test", usage: { ...emptyUsage(), input: 100, output: 10, totalTokens: 110 }, stopReason: tool ? "toolUse" : "stop", timestamp: Date.now() };
}
export interface Result { content: { type: "text"; text: string }[]; details?: Details; usage?: Usage; isError?: boolean }
interface Tool {
  name: string;
  parameters: { properties: Record<string, unknown>; required: string[] };
  description: string;
  executionMode?: string;
  execute(id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, update: ((result: Result) => void) | undefined, ctx: ExtensionToolContext): Promise<Result>;
  renderCall(args: Record<string, unknown>, theme: Theme, context: unknown): Component;
  renderResult(result: Result, options: { expanded: boolean }, theme: Theme, context: { keyHint: (id: string, label: string) => string; isError?: boolean }): Component;
}
export function harness() {
  const events = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
  const tools = new Map<string, Tool>();
  const renderers = new Map<string, Parameters<ExtensionAPI["registerMessageRenderer"]>[1]>();
  const sent: { message: Parameters<ExtensionAPI["sendMessage"]>[0]; options: Parameters<ExtensionAPI["sendMessage"]>[1] }[] = [];
  const writes: (string | undefined)[] = [], notices: string[] = [];
  const pending: { resolve: (value: AssistantMessage) => void; signal: AbortSignal }[] = [];
  const conversations: Message[][] = [], choices: SimpleStreamOptions[] = [], models: Model<Api>[] = [];
  const nested: { name: string; args: Record<string, unknown>; signal?: AbortSignal }[] = [];
  let config: unknown = {}, thinking = "high", idle = true;
  let available = [model()];
  const theme = { style: (text: string) => text, fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
  let editorFactory = () => ({ getText: () => "", handleInput(_key: string) {} });
  const pi = {
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { events.set(name, handler); },
    registerTool(definition: Tool) { tools.set(definition.name, definition); },
    registerCommand(name: string, definition: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) { commands.set(name, definition.handler); },
    registerEntryRenderer() {},
    registerMessageRenderer(name: string, renderer: Parameters<ExtensionAPI["registerMessageRenderer"]>[1]) { renderers.set(name, renderer); },
    sendMessage(message: Parameters<ExtensionAPI["sendMessage"]>[0], options: Parameters<ExtensionAPI["sendMessage"]>[1]) { sent.push({ message, options }); },
    sendUserMessage() {},
    getSettings: () => ({ ccSubagent: config }), getThinkingLevel: () => thinking,
    getActiveTools: () => ctx.tools.map(t => t.name), getAllTools: () => ctx.tools,
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: "tui", cwd: process.cwd(), model: available[0], thinkingLevel: "high",
    tools: ["read", "write", "edit", "bash", "find", "grep", "ls", "Agent", "SendMessage", "TaskStop", "ask_user_question", "custom_fetch"].map(name => ({ name, description: name, parameters: {} })),
    isIdle: () => idle, getSystemPrompt: () => "PARENT SECRET SYSTEM",
    ui: { theme, getEditorComponent: () => editorFactory,
      setEditorComponent(factory: typeof editorFactory) { editorFactory = factory; },
      setStatus(_key: string, text: string | undefined) { writes.push(text); },
      notify(text: string) { notices.push(text); } },
    modelRegistry: {
      getAvailable: () => available,
      streamSimple(chosen: Model<Api>, context: { messages: Message[] }, options: SimpleStreamOptions & { signal: AbortSignal }) {
        models.push(chosen); conversations.push(structuredClone(context.messages)); choices.push(options);
        let resolve!: (value: AssistantMessage) => void;
        const result = new Promise<AssistantMessage>(r => { resolve = r; });
        pending.push({ resolve, signal: options.signal });
        return { async *[Symbol.asyncIterator]() {}, result: () => result };
      },
    },
    executeTool: async (name: string, args: Record<string, unknown>, options: { signal?: AbortSignal }) => {
      nested.push({ name, args, signal: options.signal });
      return { isError: false, result: { content: [{ type: "text", text: "contents" }], details: {} } };
    },
  } as unknown as ExtensionToolContext & ExtensionCommandContext;
  extension(pi);
  const call = (name: string, params: Record<string, unknown>, signal?: AbortSignal, update?: (result: Result) => void) => tools.get(name)!.execute("same-id", params, signal, update, ctx);
  return { pi, ctx, theme, events, commands, tools, renderers, sent, writes, notices, pending, conversations, choices, models, nested, call,
    agent: (params: Record<string, unknown> = {}, signal?: AbortSignal, update?: (result: Result) => void) => call("Agent", { ...task, ...params }, signal, update),
    config: (value: unknown) => { config = value; }, thinking: (value: string) => { thinking = value; }, available: (value: Model<Api>[]) => { available = value; }, busy: () => { idle = false; },
    before: (files?: { path: string; content: string }[]) => events.get("before_agent_start")!({ systemPrompt: "PARENT SECRET SYSTEM", systemPromptOptions: { contextFiles: files, cwd: ctx.cwd } }, ctx) as { systemPrompt: string },
    shutdown: () => events.get("session_shutdown")!({}, ctx),
  };
}
