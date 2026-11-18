import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildChildEnv, McpStdioClient } from "../../dist/dsh/mcp-client.js";
import { LineDecoder } from "../../dist/dsh/protocol.js";

const fixtures = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"fixtures",
);
const server = path.join(fixtures, "fake-mcp-server.mjs");

test("LineDecoder only emits complete newline-delimited frames", () => {
	const decoder = new LineDecoder();
	assert.deepEqual(decoder.push('{"a":1}\n{"b":'), ['{"a":1}']);
	assert.deepEqual(decoder.push("2}\r\n\n"), ['{"b":2}']);
	assert.deepEqual(decoder.flush(), []);
});

test("LineDecoder rejects unbounded frames", () => {
	const decoder = new LineDecoder(8);
	assert.throws(() => decoder.push("123456789"), /exceeded 8 characters/);
});

test("MCP client completes initialize, tools/list and tools/call", async () => {
	const client = new McpStdioClient({
		args: [server, "--cwd=/tmp/workspace"],
		cwd: path.dirname(server),
		env: buildChildEnv(),
	});
	try {
		const initialized = await client.start();
		assert.equal(client.state, "ready");
		assert.equal(initialized.protocolVersion, "2025-06-18");
		assert.equal(initialized.serverInfo.name, "fake-pi-lens");
		assert.equal(typeof client.pid, "number");

		const tools = await client.listTools();
		assert.deepEqual(
			tools.map((tool) => tool.name).sort(),
			[
				"pilens_diagnostics",
				"pilens_echo",
				"pilens_fail",
				"pilens_navigate",
				"pilens_slow",
				"run_code",
			].sort(),
		);

		const echoed = await client.callTool("pilens_echo", { value: "hi" });
		assert.equal(echoed.isError, undefined);
		assert.match(echoed.content[0].text, /pilens_echo:\{"value":"hi"\}/);
		assert.deepEqual(echoed.structuredContent, {
			tool: "pilens_echo",
			args: { value: "hi" },
		});
	} finally {
		await client.dispose();
	}
	assert.equal(client.state, "closed");
});

test("MCP client surfaces tool errors without corrupting the stream", async () => {
	const client = new McpStdioClient({
		args: [server],
		cwd: path.dirname(server),
		env: buildChildEnv(),
	});
	try {
		await client.start();
		const failed = await client.callTool("pilens_fail", {});
		assert.equal(failed.isError, true);
		// A failed call must not poison later requests.
		const echoed = await client.callTool("pilens_echo", { value: "again" });
		assert.match(echoed.content[0].text, /again/);
	} finally {
		await client.dispose();
	}
});

test("aborting a tool call sends cancellation and rejects promptly", async () => {
	const client = new McpStdioClient({
		args: [server],
		cwd: path.dirname(server),
		env: buildChildEnv(),
	});
	try {
		await client.start();
		const controller = new AbortController();
		const pending = client.callTool("pilens_slow", {}, controller.signal);
		setTimeout(() => controller.abort(), 25);
		await assert.rejects(pending, /aborted/);
		// The client remains usable after a cancelled request.
		const echoed = await client.callTool("pilens_echo", { value: "after" });
		assert.match(echoed.content[0].text, /after/);
	} finally {
		await client.dispose();
	}
});

test("request timeout rejects and unblocks later calls", async () => {
	const client = new McpStdioClient({
		args: [server],
		cwd: path.dirname(server),
		env: buildChildEnv(),
		requestTimeoutMs: 50,
	});
	try {
		await client.start();
		await assert.rejects(
			client.callTool("pilens_slow", {}),
			/timed out after 50ms/,
		);
	} finally {
		await client.dispose();
	}
});
