import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { apply, Config } from "../../dist/dsh/index.js";
import { toParameterSchema } from "../../dist/dsh/schema.js";
import { projectTool } from "../../dist/dsh/tools.js";

const fixtures = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"fixtures",
);
const server = path.join(fixtures, "fake-mcp-server.mjs");

function syntheticTool(index) {
	return {
		name: `pilens_synthetic_${index}`,
		description: `Synthetic tool ${index}`,
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", format: "path", minLength: 1 },
				mode: { enum: ["read", "write", 3] },
				nested: {
					type: "object",
					properties: {
						flag: { type: "boolean" },
						list: { type: "array", items: { type: "string" } },
					},
					required: ["flag"],
				},
			},
			required: ["path"],
			additionalProperties: false,
		},
	};
}

test("schema projection scales to a large tool catalog", () => {
	const started = process.hrtime.bigint();
	for (let index = 0; index < 500; index += 1) {
		const tool = syntheticTool(index);
		const schema = toParameterSchema(tool.inputSchema);
		assert.equal(schema.type, "object");
		assert.deepEqual(schema.required, ["path"]);
		projectTool(tool, {
			requestTimeoutMs: 1_000,
			maxTextChars: 10_000,
			caller: { callTool: async () => ({ content: [] }) },
		});
	}
	const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
	assert.ok(elapsedMs < 1_000, `projection took ${elapsedMs.toFixed(1)}ms`);
});

test("adversarial schema depth is bounded instead of throwing", () => {
	let schema = { type: "string" };
	for (let depth = 0; depth < 500; depth += 1) {
		schema = { type: "object", properties: { child: schema } };
	}
	const projected = toParameterSchema(schema);
	assert.equal(projected.type, "object");
	assert.doesNotThrow(() => JSON.stringify(projected));
});

test("the adapter sustains concurrent tool calls without cross-talk", async () => {
	const tools = new Map();
	const disposers = [];
	const ctx = {
		tools: {
			register(definition) {
				tools.set(definition.name, definition);
				return () => tools.delete(definition.name);
			},
		},
		effect(factory) {
			const dispose = factory();
			disposers.push(dispose);
			return dispose;
		},
		on() {
			return () => {};
		},
	};
	apply(
		ctx,
		Config({ serverPath: server, cwd: fixtures, restartOnCrash: false }),
	);
	try {
		const deadline = Date.now() + 8_000;
		while (!tools.has("pilens_echo") && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		const echo = tools.get("pilens_echo");
		assert.ok(echo, "echo tool must be registered");
		const started = process.hrtime.bigint();
		const results = await Promise.all(
			Array.from({ length: 25 }, (_, index) =>
				echo.execute(
					{ value: `call-${index}` },
					{ signal: new AbortController().signal },
				),
			),
		);
		const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
		results.forEach((value, index) => {
			assert.match(value.text, new RegExp(`call-${index}`));
		});
		assert.ok(
			elapsedMs < 5_000,
			`concurrent calls took ${elapsedMs.toFixed(1)}ms`,
		);
	} finally {
		for (const dispose of disposers.reverse()) await dispose?.();
	}
});
