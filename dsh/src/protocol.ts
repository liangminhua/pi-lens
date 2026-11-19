/**
 * Minimal MCP (Model Context Protocol) JSON-RPC 2.0 framing.
 *
 * The DSH plugin talks to the pi-lens engine through the long-lived
 * `pi-lens-mcp` child process, which speaks newline-delimited JSON-RPC over
 * stdio (`initialize`, `tools/list`, `tools/call`, `ping`). This module owns
 * the wire types and the line decoder so both the client and the compatibility
 * tests exercise the same framing code.
 */

export const JSON_RPC_VERSION = "2.0";

export interface JsonRpcRequestMessage {
	jsonrpc: typeof JSON_RPC_VERSION;
	id: number;
	method: string;
	params?: unknown;
}

export interface JsonRpcNotificationMessage {
	jsonrpc: typeof JSON_RPC_VERSION;
	method: string;
	params?: unknown;
}

export interface JsonRpcSuccessMessage {
	jsonrpc: typeof JSON_RPC_VERSION;
	id: number;
	result: unknown;
}

export interface JsonRpcErrorMessage {
	jsonrpc: typeof JSON_RPC_VERSION;
	id: number | null;
	error: {
		code: number;
		message: string;
		data?: unknown;
	};
}

export type JsonRpcMessage =
	| JsonRpcSuccessMessage
	| JsonRpcErrorMessage
	| JsonRpcNotificationMessage;

/** Error raised for a JSON-RPC `error` response. */
export class JsonRpcProtocolError extends Error {
	readonly code: number;
	readonly data: unknown;

	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.name = "JsonRpcProtocolError";
		this.code = code;
		this.data = data;
	}
}

/**
 * Incremental newline-delimited JSON decoder.
 *
 * A single stdout chunk may contain a partial line, several lines, or both;
 * `push` returns only complete frames and retains the remainder. Blank lines
 * are ignored because they carry no JSON-RPC message.
 */
export class LineDecoder {
	private buffer = "";

	constructor(private readonly maxBufferedChars = 8 * 1024 * 1024) {}

	push(chunk: Buffer | string): string[] {
		this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
		if (this.buffer.length > this.maxBufferedChars) {
			this.buffer = "";
			throw new Error(
				`MCP stdout frame exceeded ${this.maxBufferedChars} characters without a newline`,
			);
		}
		const lines: string[] = [];
		let newline = this.buffer.indexOf("\n");
		while (newline !== -1) {
			const line = this.buffer.slice(0, newline).replace(/\r$/, "");
			this.buffer = this.buffer.slice(newline + 1);
			if (line.trim().length > 0) lines.push(line);
			newline = this.buffer.indexOf("\n");
		}
		return lines;
	}

	/** Flush a trailing frame written without a final newline. */
	flush(): string[] {
		const rest = this.buffer.trim();
		this.buffer = "";
		return rest.length > 0 ? [rest] : [];
	}
}

/** Narrow an untrusted decoded value to a JSON-RPC response or notification. */
export function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
	if (typeof value !== "object" || value === null) return false;
	const message = value as Record<string, unknown>;
	if (message.jsonrpc !== JSON_RPC_VERSION) return false;
	if (typeof message.method === "string") return true;
	return typeof message.id === "number";
}
