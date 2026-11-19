/**
 * pi-lens DSH plugin entry.
 *
 * DSH (DeepSeek Harness) loads Cordis plugins through `apply(ctx, config)`.
 * This module is the host-plane adapter:
 *
 * - `name`      Cordis plugin id
 * - `inject`    waits for the `tools` service before activation
 * - `Config`    Schemastery schema with defaults (validated before apply)
 * - `apply`     owns every resource through `ctx.effect`/`ctx.tools.register`
 *
 * The adapter proxies the engine's MCP server instead of duplicating analysis
 * logic, so every pi-lens capability listed on `tools/list` is exposed as a
 * native DSH tool.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Schema from "@deepseek-ai/schemastery";
import {
	type CommandHost,
	installCommands,
	type PiLensCommandRuntime,
} from "./commands.js";
import { PluginLifecycle, type PluginLifecycleState } from "./lifecycle.js";
import {
	installReadGuard,
	ReadGuard,
	type ReadGuardHost,
} from "./read-guard.js";
import {
	buildChildEnv,
	type McpCallResult,
	McpStdioClient,
	type McpToolInfo,
} from "./mcp-client.js";
import {
	isProjectableTool,
	projectTool,
	type ToolDefinition,
} from "./tools.js";

export const name = "pi-lens";
export const inject = ["tools"];

/** Adapter version reported in the MCP `clientInfo` handshake. */
export const adapterVersion = "1.0.0";

/**
 * Structural subset of the Cordis `Context` the adapter consumes. The host
 * supplies the real context; this declaration keeps the build independent of
 * the harness's private type graph.
 */
export interface PluginContext extends CommandHost, ReadGuardHost {
	effect(
		factory: () => void | (() => void | Promise<void>),
		label?: string,
	): unknown;
	tools: {
		register(definition: ToolDefinition): () => void;
	};
}

const MAX_RESTART_BACKOFF_MS = 30_000;

export interface Config {
	/** Load the adapter. False leaves the host untouched. */
	enabled: boolean;
	/** Absolute path to `pi-lens-mcp`; empty resolves the sibling dist entry. */
	serverPath: string;
	/** Workspace root handed to the MCP server; empty uses the host cwd. */
	cwd: string;
	startupTimeoutMs: number;
	requestTimeoutMs: number;
	/** Empty includes every advertised tool. */
	includeTools: string[];
	excludeTools: string[];
	restartOnCrash: boolean;
	maxRestarts: number;
	restartBackoffMs: number;
	maxTextChars: number;
	/** Extra environment variables forwarded to the analysis child. */
	env: Record<string, string>;
	debug: boolean;
}

export const Config: Schema<Config> = Schema.object({
	enabled: Schema.boolean().default(true),
	serverPath: Schema.string().default(""),
	cwd: Schema.string().default(""),
	startupTimeoutMs: Schema.natural().default(15_000),
	requestTimeoutMs: Schema.natural().default(120_000),
	includeTools: Schema.array(String).default([]),
	excludeTools: Schema.array(String).default([]),
	restartOnCrash: Schema.boolean().default(true),
	maxRestarts: Schema.natural().default(3),
	restartBackoffMs: Schema.natural().default(500),
	maxTextChars: Schema.natural().default(120_000),
	env: Schema.dict(String).default({}),
	debug: Schema.boolean().default(false),
});

interface RuntimeStatus {
	lifecycle: PluginLifecycleState;
	engine: string;
	enabled: boolean;
	pid?: number;
	server: string;
	cwd: string;
	protocolVersion?: string;
	serverName?: string;
	tools: number;
	restarts: number;
	lastError?: string;
	stderr: readonly string[];
}

class PiLensRuntime {
	private client: McpStdioClient | null = null;
	private state: "idle" | "starting" | "ready" | "degraded" | "disposed" =
		"idle";
	private startPromise: Promise<void> | null = null;
	private restartTimer: NodeJS.Timeout | null = null;
	private failures = 0;
	private restarts = 0;
	private enabled = true;
	private lastError: string | undefined;
	private disposed = false;
	tools: McpToolInfo[] = [];
	onTools: ((tools: readonly McpToolInfo[]) => void) | undefined;

	constructor(
		private readonly config: Config,
		private readonly lifecycle: PluginLifecycle,
		private readonly serverPath: string,
		private readonly workspace: string,
	) {}

	async start(): Promise<void> {
		if (this.disposed) throw new Error("pi-lens runtime is disposed");
		if (this.client?.state === "ready") return;
		if (this.startPromise) return this.startPromise;
		this.startPromise = this.startInternal().finally(() => {
			this.startPromise = null;
		});
		return this.startPromise;
	}

	private async startInternal(): Promise<void> {
		if (this.disposed) throw new Error("pi-lens runtime is disposed");
		this.state = "starting";
		const client = new McpStdioClient({
			args: [this.serverPath, `--cwd=${this.workspace}`],
			cwd: this.workspace,
			env: buildChildEnv(this.config.env),
			startupTimeoutMs: this.config.startupTimeoutMs,
			requestTimeoutMs: this.config.requestTimeoutMs,
			clientName: "dsh-pi-lens",
			clientVersion: adapterVersion,
			logger: (level, message) => this.log(level, message),
			onExit: (code, signal) => {
				if (this.client === client) this.handleUnexpectedExit(code, signal);
			},
		});
		this.client = client;
		try {
			await client.start();
			const tools = await client.listTools();
			if (this.disposed) {
				await client.dispose();
				return;
			}
			this.tools = tools;
			this.state = "ready";
			this.failures = 0;
			this.lastError = undefined;
			this.onTools?.(tools);
			if (this.lifecycle.state === "DEGRADED")
				this.lifecycle.transition("ACTIVE");
			this.log(
				"info",
				`engine ready (${tools.length} tools, pid=${client.pid ?? "?"})`,
			);
		} catch (error) {
			this.state = "degraded";
			this.lastError = errorMessage(error);
			if (this.lifecycle.state === "ACTIVE")
				this.lifecycle.transition("DEGRADED");
			await client.dispose();
			this.scheduleRestart();
			throw error;
		}
	}

	async callTool(
		toolName: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<McpCallResult> {
		if (!this.enabled) {
			throw new Error(
				"pi-lens is disabled for this session; run /lens-toggle to enable it",
			);
		}
		if (signal?.aborted) throw new Error(`MCP call '${toolName}' aborted`);
		if (this.disposed) throw new Error("pi-lens runtime is disposed");
		if (this.client?.state !== "ready") await this.start();
		const client = this.client;
		if (!client || client.state !== "ready") {
			throw new Error(
				`pi-lens engine is unavailable (${this.state}${this.lastError ? `: ${this.lastError}` : ""})`,
			);
		}
		return client.callTool(toolName, args, signal);
	}

	status(): RuntimeStatus {
		return {
			lifecycle: this.lifecycle.state,
			engine: this.state,
			enabled: this.enabled,
			pid: this.client?.pid,
			server: this.serverPath,
			cwd: this.workspace,
			protocolVersion: this.client?.serverInfo.protocolVersion,
			serverName: this.client?.serverInfo.serverInfo?.name,
			tools: this.tools.length,
			restarts: this.restarts,
			lastError: this.lastError,
			stderr: this.client?.stderr ?? [],
		};
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	setEnabled(value: boolean): void {
		this.enabled = value;
	}

	/** Replace the live MCP child and re-run the handshake. */
	async restart(): Promise<void> {
		if (this.disposed) throw new Error("pi-lens runtime is disposed");
		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
			this.restartTimer = null;
		}
		const client = this.client;
		this.client = null;
		this.state = "idle";
		this.failures = 0;
		if (client) await client.dispose();
		await this.start();
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.state = "disposed";
		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
			this.restartTimer = null;
		}
		const client = this.client;
		this.client = null;
		this.onTools = undefined;
		if (client) await client.dispose();
	}

	private handleUnexpectedExit(
		code: number | null,
		signal: NodeJS.Signals | null,
	): void {
		if (this.disposed) return;
		this.state = "degraded";
		this.lastError = `engine exited (code=${code ?? "null"}, signal=${signal ?? "none"})`;
		this.log("warn", this.lastError);
		if (this.lifecycle.state === "ACTIVE")
			this.lifecycle.transition("DEGRADED");
		this.scheduleRestart();
	}

	private scheduleRestart(): void {
		if (
			this.disposed ||
			!this.config.restartOnCrash ||
			this.restartTimer !== null
		) {
			return;
		}
		if (this.failures >= this.config.maxRestarts) {
			this.log(
				"warn",
				`restart budget exhausted (${this.failures}/${this.config.maxRestarts})`,
			);
			return;
		}
		this.failures += 1;
		this.restarts += 1;
		const delay = Math.min(
			this.config.restartBackoffMs * 2 ** (this.failures - 1),
			MAX_RESTART_BACKOFF_MS,
		);
		this.log(
			"info",
			`restarting engine in ${delay}ms (attempt ${this.failures})`,
		);
		this.restartTimer = setTimeout(() => {
			this.restartTimer = null;
			void this.start().catch((error: unknown) => {
				this.log("warn", `restart failed: ${errorMessage(error)}`);
			});
		}, delay);
		this.restartTimer.unref?.();
	}

	private log(level: "info" | "warn" | "error", message: string): void {
		if (!this.config.debug && level !== "error") return;
		process.stderr.write(`[pi-lens:${level}] ${message}\n`);
	}
}

/** Resolve the bundled `dist/mcp/server.js` relative to this module. */
export function resolveServerPath(config: Config): string {
	if (config.serverPath.trim().length > 0)
		return path.resolve(config.serverPath);
	return fileURLToPath(new URL("../mcp/server.js", import.meta.url));
}

/** Resolve the workspace handed to the engine. */
export function resolveWorkspace(config: Config): string {
	return config.cwd.trim().length > 0
		? path.resolve(config.cwd)
		: process.cwd();
}

function createStatusTool(runtime: PiLensRuntime): ToolDefinition {
	return {
		name: "pilens_status",
		description: [
			"Report pi-lens engine health: lifecycle phase, MCP handshake state, tool count, restarts, and last error.",
			"Call when a pi-lens tool failed or before relying on analysis results.",
			"Returns compact text; read-only and side-effect free.",
		].join("\n"),
		parameters: { type: "object", properties: {}, additionalProperties: false },
		output: {
			schema: {
				type: "object",
				properties: { text: { type: "string" } },
				required: ["text"],
				additionalProperties: false,
			},
			render(_args, value) {
				return [{ type: "text", text: (value as { text: string }).text }];
			},
		},
		async execute(): Promise<{ text: string }> {
			return { text: renderStatus(runtime.status()) };
		},
	};
}

function renderStatus(status: RuntimeStatus): string {
	const lines = [
		"pi-lens DSH adapter",
		`lifecycle: ${status.lifecycle}`,
		`engine: ${status.engine}`,
		`enabled: ${status.enabled}`,
		`protocol: ${status.protocolVersion ?? "unknown"}`,
		`tools: ${status.tools}`,
		`restarts: ${status.restarts}`,
		`server: ${status.server}`,
		`cwd: ${status.cwd}`,
	];
	if (status.pid !== undefined) lines.push(`pid: ${status.pid}`);
	if (status.lastError) lines.push(`lastError: ${status.lastError}`);
	if (status.stderr.length > 0) {
		lines.push(`stderr: ${status.stderr.slice(-3).join(" | ")}`);
	}
	return lines.join("\n");
}

export function apply(ctx: PluginContext, config: Config): void {
	const lifecycle = new PluginLifecycle();
	lifecycle.transition("LOADING");
	if (!config.enabled) {
		lifecycle.transition("ACTIVE");
		return;
	}

	ctx.effect(() => {
		const disposers: Array<() => void> = [];
		const runtime = new PiLensRuntime(
			config,
			lifecycle,
			resolveServerPath(config),
			resolveWorkspace(config),
		);

		const register = (definition: ToolDefinition): void => {
			try {
				const dispose = ctx.tools.register(definition);
				if (typeof dispose === "function") disposers.push(dispose);
			} catch (error) {
				process.stderr.write(
					`[pi-lens:error] failed to register ${definition.name}: ${errorMessage(error)}\n`,
				);
			}
		};

		const registered = new Set<string>();
		runtime.onTools = (tools) => {
			for (const tool of tools) {
				if (registered.has(tool.name)) continue;
				if (
					!isProjectableTool(tool, config.includeTools, config.excludeTools)
				) {
					continue;
				}
				register(
					projectTool(tool, {
						requestTimeoutMs: config.requestTimeoutMs,
						maxTextChars: config.maxTextChars,
						caller: runtime,
					}),
				);
				registered.add(tool.name);
			}
		};

		register(createStatusTool(runtime));
		const readGuard = new ReadGuard(resolveWorkspace(config));
		const disposeGuard = installReadGuard(ctx, {
			guard: readGuard,
			isEnabled: () => runtime.isEnabled(),
		});
		const commandView: PiLensCommandRuntime = {
			status: () => runtime.status(),
			statusText: () => renderStatus(runtime.status()),
			getTools: () => runtime.tools.filter((tool) => registered.has(tool.name)),
			isEnabled: () => runtime.isEnabled(),
			setEnabled: (value) => runtime.setEnabled(value),
			restart: () => runtime.restart(),
			callTool: (toolName, args, signal) =>
				runtime.callTool(toolName, args, signal),
			allowEdit: (rawPath, agent) => readGuard.allowOnce(agent, rawPath),
		};
		const disposeCommands = installCommands(ctx, commandView);
		lifecycle.transition("ACTIVE");
		void runtime.start().catch((error: unknown) => {
			process.stderr.write(
				`[pi-lens:error] engine start failed: ${errorMessage(error)}\n`,
			);
		});

		return async () => {
			if (lifecycle.state !== "UNLOADING" && lifecycle.state !== "DISPOSED") {
				lifecycle.transition("UNLOADING");
			}
			await runtime.dispose();
			disposeCommands?.();
			disposeGuard();
			for (const dispose of disposers.reverse()) {
				try {
					dispose();
				} catch {
					/* the host may already have unregistered this tool */
				}
			}
			if (lifecycle.state === "UNLOADING") lifecycle.transition("DISPOSED");
		};
	}, "pi-lens-mcp-engine");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
