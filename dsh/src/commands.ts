/**
 * DSH slash commands for the pi-lens adapter.
 *
 * Commands are registered through the optional `commands` service so they show
 * up in the harness `/` palette without being sent to the model. The service is
 * injected lazily: hosts without a command UI still load the plugin and all
 * tools normally.
 */

import type { McpCallResult, McpToolInfo } from "./mcp-client.js";

export interface CommandStatusView {
	readonly lifecycle: string;
	readonly engine: string;
	readonly enabled: boolean;
	readonly tools: number;
	readonly restarts: number;
	readonly pid?: number;
	readonly protocolVersion?: string;
	readonly lastError?: string;
}

export interface PiLensCommandRuntime {
	status(): CommandStatusView;
	statusText(): string;
	getTools(): readonly McpToolInfo[];
	isEnabled(): boolean;
	setEnabled(value: boolean): void;
	restart(): Promise<void>;
	callTool(
		name: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<McpCallResult>;
}

interface DshCommandResult {
	readonly kind: "success" | "error";
	readonly text: string;
}

interface DshCommandInvocation {
	readonly rawInput: string;
	readonly signal: AbortSignal;
}

interface DshCommandDefinition {
	readonly name: string;
	readonly description: string;
	readonly input?: { readonly hint: string };
	readonly handler: (
		invocation: DshCommandInvocation,
	) => DshCommandResult | Promise<DshCommandResult>;
}

interface DshCommandsService {
	register(definition: DshCommandDefinition): () => void;
}

export interface DshCommandContext {
	readonly commands: DshCommandsService;
	effect(
		factory: () => void | (() => void | Promise<void>),
		label?: string,
	): unknown;
}

export interface CommandHost {
	effect(
		factory: () => void | (() => void | Promise<void>),
		label?: string,
	): unknown;
	inject?(
		deps: readonly string[],
		callback: (ctx: DshCommandContext) => void,
	): { dispose?(): void } | undefined;
}

const MAX_HEALTH_CHARS = 4_000;
const MAX_TOOL_LINE = 96;

/** Register the adapter commands; no-op when the host has no command service. */
export function installCommands(
	ctx: CommandHost,
	runtime: PiLensCommandRuntime,
): (() => void) | undefined {
	if (typeof ctx.inject !== "function") return undefined;
	const fiber = ctx.inject(["commands"], (commandCtx) => {
		commandCtx.effect(() => {
			const disposers = createDefinitions(runtime).map((definition) =>
				commandCtx.commands.register(definition),
			);
			return () => {
				for (const dispose of disposers.reverse()) {
					try {
						dispose();
					} catch {
						/* the host may already have unregistered this command */
					}
				}
			};
		}, "pi-lens-commands");
	});
	return () => fiber?.dispose?.();
}

function createDefinitions(
	runtime: PiLensCommandRuntime,
): DshCommandDefinition[] {
	return [
		{
			name: "lens-status",
			description:
				"pi-lens: show adapter lifecycle, engine state, tool count, and last error.",
			handler: () => success(runtime.statusText()),
		},
		{
			name: "lens-health",
			description:
				"pi-lens: ask the engine for its health report (falls back to adapter status).",
			handler: async (invocation) => {
				const tool = runtime
					.getTools()
					.find((candidate) => candidate.name === "pilens_health");
				if (!tool) {
					return success(
						`${runtime.statusText()}\n\nhealth: engine does not advertise pilens_health`,
					);
				}
				try {
					const result = await runtime.callTool(
						"pilens_health",
						{},
						invocation.signal,
					);
					const text = resultText(result).slice(0, MAX_HEALTH_CHARS);
					return result.isError === true ? failure(text) : success(text);
				} catch (error) {
					return failure(
						`pi-lens health failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			},
		},
		{
			name: "lens-toggle",
			description:
				"pi-lens: enable or disable adapter tool calls for this process (`on` / `off`; empty toggles).",
			input: { hint: "on | off" },
			handler: (invocation) => toggle(runtime, invocation.rawInput),
		},
		{
			name: "lens-tools",
			description: "pi-lens: list the MCP capabilities exposed as DSH tools.",
			handler: () => success(renderTools(runtime)),
		},
		{
			name: "lens-restart",
			description:
				"pi-lens: restart the analysis engine and report the new state.",
			handler: async () => {
				await runtime.restart();
				return success(runtime.statusText());
			},
		},
		{
			name: "lens-map",
			description:
				"pi-lens: build the interactive HTML dependency map and print where it was written.",
			handler: async (invocation) => {
				const tool = runtime
					.getTools()
					.find((candidate) => candidate.name === "pilens_project_map");
				if (!tool) {
					return failure(
						"pi-lens engine does not advertise pilens_project_map; rebuild the engine (npm run build:dist) and restart.",
					);
				}
				try {
					const result = await runtime.callTool(
						"pilens_project_map",
						{},
						invocation.signal,
					);
					const text = resultText(result);
					return result.isError === true ? failure(text) : success(text);
				} catch (error) {
					return failure(
						`pi-lens map failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			},
		},
	];
}

function toggle(
	runtime: PiLensCommandRuntime,
	rawInput: string,
): DshCommandResult {
	const argument = rawInput.trim().toLowerCase();
	if (argument === "on" || argument === "enable" || argument === "enabled") {
		runtime.setEnabled(true);
	} else if (
		argument === "off" ||
		argument === "disable" ||
		argument === "disabled"
	) {
		runtime.setEnabled(false);
	} else if (argument.length > 0) {
		return failure("usage: /lens-toggle [on|off]");
	} else {
		runtime.setEnabled(!runtime.isEnabled());
	}
	return success(
		`pi-lens tools are now ${runtime.isEnabled() ? "enabled" : "disabled"} for this process.`,
	);
}

function renderTools(runtime: PiLensCommandRuntime): string {
	const tools = runtime.getTools();
	const lines = [`pi-lens tools (${tools.length} registered)`];
	for (const tool of tools) {
		const summary = (tool.description ?? "").split("\n")[0]?.trim() ?? "";
		const detail =
			summary.length > MAX_TOOL_LINE
				? `${summary.slice(0, MAX_TOOL_LINE - 1)}…`
				: summary;
		lines.push(`- ${tool.name}${detail ? ` — ${detail}` : ""}`);
	}
	return lines.join("\n");
}

function resultText(result: McpCallResult): string {
	return (result.content ?? [])
		.map((block) =>
			typeof block.text === "string" ? block.text : JSON.stringify(block),
		)
		.join("\n");
}

function success(text: string): DshCommandResult {
	return { kind: "success", text };
}

function failure(text: string): DshCommandResult {
	return { kind: "error", text };
}
