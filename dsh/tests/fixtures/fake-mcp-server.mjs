#!/usr/bin/env node
/**
 * Deterministic MCP server used by the DSH compatibility tests.
 *
 * It mirrors the subset of `pi-lens-mcp` the adapter depends on:
 * `initialize`, `notifications/initialized`, `tools/list`, `tools/call`,
 * cancellation, and process exit on stdin EOF. Slow calls wait until the
 * client cancels so abort/timeout behavior is observable.
 */

import { createInterface } from "node:readline";

const slowTimers = new Map();

function send(message) {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function result(id, value) {
	send({ id, result: value });
}

const tools = [
	{
		name: "pilens_diagnostics",
		description: "Collect diagnostics for a workspace.",
		inputSchema: {
			type: "object",
			properties: {
				cwd: { type: "string", format: "path", minLength: 1 },
				limit: { type: "integer", minimum: 1, maximum: 500 },
				severity: { enum: ["error", "warning", "info"] },
			},
			required: ["cwd"],
			additionalProperties: false,
		},
	},
	{
		name: "pilens_navigate",
		description: "Resolve a symbol at a position.",
		inputSchema: {
			type: "object",
			properties: {
				symbol: {
					anyOf: [{ type: "string" }, { type: "null" }],
					description: "Symbol name",
				},
			},
			required: ["symbol"],
			additionalProperties: false,
		},
	},
	{
		name: "pilens_echo",
		description: "Echo arguments back.",
		annotations: { readOnlyHint: true },
		inputSchema: {
			type: "object",
			properties: { value: { type: "string" } },
			required: ["value"],
			additionalProperties: true,
		},
	},
	{
		name: "pilens_fail",
		description: "Always fails.",
		inputSchema: { type: "object", properties: {}, additionalProperties: true },
	},
	{
		name: "pilens_slow",
		description: "Never completes unless cancelled.",
		inputSchema: { type: "object", properties: {}, additionalProperties: true },
	},
	{
		name: "run_code",
		description: "Reserved by the harness, must not be proxied.",
		inputSchema: { type: "object", properties: {}, additionalProperties: true },
	},
];

function handleCall(id, params) {
	const name = params?.name;
	const args = params?.arguments ?? {};
	if (name === "pilens_fail") {
		result(id, { content: [{ type: "text", text: "boom" }], isError: true });
		return;
	}
	if (name === "pilens_slow") {
		const timer = setTimeout(() => {
			slowTimers.delete(id);
			result(id, { content: [{ type: "text", text: "slow done" }] });
		}, 30_000);
		slowTimers.set(id, timer);
		return;
	}
	result(id, {
		content: [
			{
				type: "text",
				text: `${name}:${JSON.stringify(args)}`,
			},
		],
		structuredContent: { tool: name, args },
	});
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	if (message.method === "initialize") {
		result(message.id, {
			protocolVersion: "2025-06-18",
			capabilities: { tools: { listChanged: false } },
			serverInfo: { name: "fake-pi-lens", version: "0.0.1" },
		});
		return;
	}
	if (message.method === "notifications/initialized") return;
	if (message.method === "tools/list") {
		result(message.id, { tools });
		return;
	}
	if (message.method === "tools/call") {
		handleCall(message.id, message.params);
		return;
	}
	if (message.method === "notifications/cancelled") {
		const timer = slowTimers.get(message.params?.requestId);
		if (timer) {
			clearTimeout(timer);
			slowTimers.delete(message.params?.requestId);
		}
		return;
	}
	if (message.method === "ping") {
		result(message.id, {});
		return;
	}
	if (typeof message.id === "number") {
		send({
			id: message.id,
			error: { code: -32601, message: `unknown method ${message.method}` },
		});
	}
});

rl.on("close", () => {
	for (const timer of slowTimers.values()) clearTimeout(timer);
	process.exit(0);
});
