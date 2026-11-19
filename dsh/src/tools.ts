/**
 * DSH `ToolDefinition` projection for pi-lens MCP tools.
 *
 * Every capability the engine advertises on `tools/list` becomes a native DSH
 * tool: the MCP schema is sanitized into the enforced DSH subset, execution
 * forwards cancellation, and the canonical value carries compact text so the
 * tool result is stable and replayable (DSH standard §3.4).
 */

import type { McpCallResult, McpToolInfo } from "./mcp-client.js";
import { renderMcpResult, toParameterSchema } from "./schema.js";

export interface McpCaller {
	callTool(
		name: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<McpCallResult>;
}

/** Structural subset of the DSH tool-run context the adapter consumes. */
export interface ToolRunContext {
	readonly signal: AbortSignal;
}

export interface ToolContentBlock {
	readonly type: "text";
	readonly text: string;
}

/**
 * Structural subset of `@deepseek-ai/dsh-tools` `ToolDefinition`. Keeping the
 * host types out of the build matrix lets the package compile without the
 * harness's private dependency graph while remaining assignment-compatible
 * with the runtime contract.
 */
export interface ToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly parameters: Record<string, unknown>;
	readonly output: {
		readonly schema: Record<string, unknown>;
		render(args: unknown, value: unknown): ToolContentBlock[];
	};
	readonly timeoutMs?: number;
	isConcurrencySafe?: () => boolean;
	execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
}

export interface ToolProjectionOptions {
	readonly requestTimeoutMs: number;
	readonly maxTextChars: number;
	readonly caller: McpCaller;
	readonly onError?: (message: string) => void;
}

export interface CanonicalToolValue {
	readonly text: string;
	readonly isError: boolean;
}

const OUTPUT_SCHEMA: Record<string, unknown> = {
	type: "object",
	properties: {
		text: { type: "string" },
		isError: { type: "boolean" },
	},
	required: ["text"],
	additionalProperties: false,
};

/** Tool names reserved by the harness itself and therefore never proxied. */
const RESERVED_TOOL_NAMES = new Set(["run_code"]);

export function isProjectableTool(
	tool: McpToolInfo,
	include: readonly string[],
	exclude: readonly string[],
): boolean {
	if (RESERVED_TOOL_NAMES.has(tool.name)) return false;
	if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(tool.name)) return false;
	if (exclude.includes(tool.name)) return false;
	return include.length === 0 || include.includes(tool.name);
}

export function projectTool(
	tool: McpToolInfo,
	options: ToolProjectionOptions,
): ToolDefinition {
	const description = buildDescription(tool);
	const definition: ToolDefinition = {
		name: tool.name,
		description,
		parameters: toParameterSchema(tool.inputSchema),
		output: {
			schema: OUTPUT_SCHEMA,
			render(_args: unknown, value: unknown): ToolContentBlock[] {
				const canonical = value as CanonicalToolValue;
				return [{ type: "text", text: canonical.text }];
			},
		},
		timeoutMs: options.requestTimeoutMs,
		async execute(
			args: unknown,
			exec: ToolRunContext,
		): Promise<CanonicalToolValue> {
			const result = await options.caller.callTool(
				tool.name,
				asArguments(args),
				exec.signal,
			);
			const text = renderMcpResult(result, options.maxTextChars);
			if (result.isError === true) {
				options.onError?.(`${tool.name}: ${text}`);
				throw new Error(text);
			}
			return { text, isError: false };
		},
	};
	// Only explicitly read-only MCP tools may run concurrently; mutating tools
	// (autofix, rename, format) inherit the harness's strict default.
	if (tool.annotations?.readOnlyHint === true) {
		definition.isConcurrencySafe = () => true;
	}
	return definition;
}

function asArguments(args: unknown): Record<string, unknown> {
	if (typeof args !== "object" || args === null || Array.isArray(args))
		return {};
	return { ...(args as Record<string, unknown>) };
}

function buildDescription(tool: McpToolInfo): string {
	const base =
		typeof tool.description === "string" && tool.description.trim().length > 0
			? tool.description.trim()
			: `Run the pi-lens ${tool.name} capability.`;
	if (base.includes("Side effects:")) return base;
	return [
		base,
		"Call when language-aware feedback or code navigation is needed for the current workspace.",
		"Preconditions: the plugin is loaded and the pi-lens engine has completed its MCP handshake.",
		"Returns compact text from the MCP server; failures surface as tool errors.",
		"Side effects: read-only analysis; language servers or linters may be started on demand.",
	].join("\n");
}
