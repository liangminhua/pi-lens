/**
 * MCP stdio client used by the DSH plugin.
 *
 * The plugin never re-implements pi-lens analysis: it owns one long-lived
 * `pi-lens-mcp` child and proxies calls through MCP JSON-RPC. Ownership is
 * explicit — the caller's disposer stops the child, rejects in-flight work,
 * and escalates SIGTERM to SIGKILL after a grace period (DSH standard §3.2,
 * §3.6).
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
	isJsonRpcMessage,
	JSON_RPC_VERSION,
	type JsonRpcErrorMessage,
	JsonRpcProtocolError,
	type JsonRpcRequestMessage,
	type JsonRpcSuccessMessage,
	LineDecoder,
} from "./protocol.js";

export type McpClientState =
	| "idle"
	| "starting"
	| "ready"
	| "closing"
	| "closed"
	| "failed";

export interface McpToolInfo {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
	annotations?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface McpContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
	resource?: unknown;
	[key: string]: unknown;
}

export interface McpCallResult {
	content?: McpContentBlock[];
	isError?: boolean;
	structuredContent?: unknown;
	[key: string]: unknown;
}

export interface McpInitializeResult {
	protocolVersion?: string;
	capabilities?: Record<string, unknown>;
	serverInfo?: { name?: string; version?: string };
	[key: string]: unknown;
}

export interface McpStdioClientOptions {
	/** Arguments for the child process; the first entry is the MCP server path. */
	readonly args: string[];
	readonly cwd: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly startupTimeoutMs?: number;
	readonly requestTimeoutMs?: number;
	readonly clientName?: string;
	readonly clientVersion?: string;
	readonly stderrLimit?: number;
	readonly logger?: (level: "warn" | "error", message: string) => void;
	/** Called once for an unexpected child exit (not for a deliberate dispose). */
	readonly onExit?: (
		code: number | null,
		signal: NodeJS.Signals | null,
	) => void;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DISPOSE_GRACE_MS = 2_000;

/**
 * Environment keys forwarded to the analysis child. Credentials are NOT
 * forwarded by default (DSH standard §3.6.4); callers opt in through
 * `config.env`.
 */
const FORWARDED_ENV_KEYS = [
	"PATH",
	"Path",
	"HOME",
	"USERPROFILE",
	"TMPDIR",
	"TEMP",
	"TMP",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"SYSTEMROOT",
	"WINDIR",
	"APPDATA",
	"LOCALAPPDATA",
	"PATHEXT",
	"NODE_EXTRA_CA_CERTS",
] as const;

export function buildChildEnv(
	extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of FORWARDED_ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	for (const [key, value] of Object.entries(extra)) {
		if (typeof value === "string" && key.length > 0) env[key] = value;
	}
	return env;
}

export class McpStdioClient {
	private child: ChildProcessWithoutNullStreams | null = null;
	private readonly decoder = new LineDecoder();
	private readonly pending = new Map<number, PendingRequest>();
	private readonly stderrTail: string[] = [];
	private nextId = 1;
	private stateValue: McpClientState = "idle";
	private startPromise: Promise<McpInitializeResult> | null = null;
	private disposing = false;
	private exitNotified = false;
	private serverInfoValue: McpInitializeResult = {};

	constructor(private readonly options: McpStdioClientOptions) {}

	get state(): McpClientState {
		return this.stateValue;
	}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	get serverInfo(): McpInitializeResult {
		return this.serverInfoValue;
	}

	get stderr(): readonly string[] {
		return this.stderrTail;
	}

	async start(signal?: AbortSignal): Promise<McpInitializeResult> {
		if (this.stateValue === "ready") return this.serverInfoValue;
		if (this.startPromise) return this.startPromise;
		const promise = this.startInternal(signal).finally(() => {
			this.startPromise = null;
		});
		this.startPromise = promise;
		return promise;
	}

	private async startInternal(
		signal?: AbortSignal,
	): Promise<McpInitializeResult> {
		if (this.disposing) throw new Error("MCP client is disposing");
		this.stateValue = "starting";
		const child = spawn(process.execPath, [...this.options.args], {
			cwd: this.options.cwd,
			env: this.options.env ?? buildChildEnv(),
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
			windowsHide: true,
		});
		this.child = child;
		this.exitNotified = false;
		this.attach(child);

		try {
			const initialized = (await this.request(
				"initialize",
				{
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: {
						name: this.options.clientName ?? "dsh-pi-lens",
						version: this.options.clientVersion ?? "1.0.0",
					},
				},
				{
					timeoutMs:
						this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
					signal,
				},
			)) as McpInitializeResult;
			this.serverInfoValue = initialized;
			this.notify("notifications/initialized", {});
			this.stateValue = "ready";
			return initialized;
		} catch (error) {
			this.stateValue = "failed";
			this.stopChild("SIGKILL");
			throw error;
		}
	}

	async listTools(signal?: AbortSignal): Promise<McpToolInfo[]> {
		const tools: McpToolInfo[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 100; page += 1) {
			const result = (await this.request(
				"tools/list",
				cursor ? { cursor } : {},
				{ signal },
			)) as { tools?: unknown[]; nextCursor?: unknown };
			for (const tool of result.tools ?? []) {
				if (isMcpToolInfo(tool)) tools.push(tool);
			}
			if (
				typeof result.nextCursor !== "string" ||
				result.nextCursor.length === 0
			) {
				break;
			}
			cursor = result.nextCursor;
		}
		return tools;
	}

	async callTool(
		name: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<McpCallResult> {
		const result = (await this.request(
			"tools/call",
			{ name, arguments: args },
			{ signal },
		)) as McpCallResult;
		return result ?? {};
	}

	async dispose(): Promise<void> {
		if (this.stateValue === "closed") return;
		this.disposing = true;
		this.stateValue = "closing";
		this.failAll(new Error("MCP client disposed"));
		const child = this.child;
		if (!child) {
			this.stateValue = "closed";
			return;
		}
		await new Promise<void>((resolve) => {
			let settled = false;
			const finish = (): void => {
				if (settled) return;
				settled = true;
				clearTimeout(killTimer);
				this.child = null;
				this.stateValue = "closed";
				resolve();
			};
			const killTimer = setTimeout(() => {
				this.stopChild("SIGKILL");
				finish();
			}, DISPOSE_GRACE_MS);
			child.once("exit", finish);
			try {
				child.stdin.end();
			} catch {
				/* already closed */
			}
			this.stopChild("SIGTERM");
		});
	}

	private attach(child: ChildProcessWithoutNullStreams): void {
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			let lines: string[];
			try {
				lines = this.decoder.push(chunk);
			} catch (error) {
				this.log("error", (error as Error).message);
				return;
			}
			for (const line of lines) this.handleLine(line);
		});
		child.stderr.on("data", (chunk: string) => {
			// Keep a bounded tail for diagnostics; never forward to stdout.
			for (const line of chunk.split(/\r?\n/)) {
				if (line.trim().length === 0) continue;
				this.stderrTail.push(line);
				const limit = this.options.stderrLimit ?? 40;
				if (this.stderrTail.length > limit) this.stderrTail.shift();
			}
		});
		child.on("error", (error) => {
			this.log("error", `MCP child error: ${error.message}`);
			this.failAll(error);
			this.stateValue = "failed";
		});
		child.on("exit", (code, signal) => {
			const deliberate = this.disposing;
			this.failAll(
				new Error(
					`MCP child exited (code=${code ?? "null"}, signal=${signal ?? "none"})`,
				),
			);
			if (!deliberate) this.stateValue = "failed";
			if (!deliberate && !this.exitNotified) {
				this.exitNotified = true;
				this.options.onExit?.(code, signal);
			}
		});
	}

	private handleLine(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			this.log(
				"warn",
				`ignoring non-JSON MCP stdout line: ${line.slice(0, 200)}`,
			);
			return;
		}
		if (!isJsonRpcMessage(parsed)) {
			this.log("warn", "ignoring malformed MCP message");
			return;
		}
		if (typeof (parsed as { method?: unknown }).method === "string") {
			// Notifications (logging, progress) carry no response correlation.
			return;
		}
		const response = parsed as JsonRpcSuccessMessage | JsonRpcErrorMessage;
		const pending = this.pending.get(response.id as number);
		if (!pending) return;
		this.pending.delete(response.id as number);
		if ("error" in response && response.error) {
			pending.reject(
				new JsonRpcProtocolError(
					response.error.code,
					response.error.message,
					response.error.data,
				),
			);
			return;
		}
		pending.resolve((response as JsonRpcSuccessMessage).result);
	}

	private request(
		method: string,
		params: unknown,
		options: { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<unknown> {
		const child = this.child;
		if (
			!child ||
			(this.stateValue !== "ready" && this.stateValue !== "starting")
		) {
			return Promise.reject(
				new Error(`MCP client is not running (state=${this.stateValue})`),
			);
		}
		const id = this.nextId;
		this.nextId += 1;
		return new Promise<unknown>((resolve, reject) => {
			const timeoutMs =
				options.timeoutMs ??
				this.options.requestTimeoutMs ??
				DEFAULT_REQUEST_TIMEOUT_MS;
			let settled = false;
			const settle = (): boolean => {
				if (settled) return false;
				settled = true;
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
				return true;
			};
			const timer = setTimeout(() => {
				if (!settle()) return;
				this.pending.delete(id);
				reject(
					new Error(`MCP request '${method}' timed out after ${timeoutMs}ms`),
				);
			}, timeoutMs);
			const onAbort = (): void => {
				if (!settle()) return;
				this.pending.delete(id);
				try {
					this.notify("notifications/cancelled", {
						requestId: id,
						reason: "client aborted",
					});
				} catch {
					/* the child may already be gone */
				}
				reject(new Error(`MCP request '${method}' aborted`));
			};
			if (options.signal?.aborted) {
				onAbort();
				return;
			}
			options.signal?.addEventListener("abort", onAbort, { once: true });
			this.pending.set(id, {
				resolve: (value) => {
					if (!settle()) return;
					resolve(value);
				},
				reject: (error) => {
					if (!settle()) return;
					reject(error);
				},
			});
			const message: JsonRpcRequestMessage = {
				jsonrpc: JSON_RPC_VERSION,
				id,
				method,
				params,
			};
			this.write(message);
		});
	}

	private notify(method: string, params: unknown): void {
		this.write({ jsonrpc: JSON_RPC_VERSION, method, params });
	}

	private write(message: unknown): void {
		const child = this.child;
		if (!child || !child.stdin.writable) {
			throw new Error("MCP child stdin is not writable");
		}
		child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private failAll(error: Error): void {
		for (const [id, pending] of this.pending) {
			this.pending.delete(id);
			pending.reject(error);
		}
	}

	private stopChild(signal: NodeJS.Signals): void {
		const child = this.child;
		if (!child || child.killed) return;
		try {
			child.kill(signal);
		} catch {
			/* already exited */
		}
	}

	private log(level: "warn" | "error", message: string): void {
		this.options.logger?.(level, message);
	}
}

function isMcpToolInfo(value: unknown): value is McpToolInfo {
	if (typeof value !== "object" || value === null) return false;
	const tool = value as Record<string, unknown>;
	return typeof tool.name === "string" && tool.name.length > 0;
}
