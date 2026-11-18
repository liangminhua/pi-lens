import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	adapterVersion,
	apply,
	Config,
	inject,
	name,
} from "../../dist/dsh/index.js";

const fixtures = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"fixtures",
);
const server = path.join(fixtures, "fake-mcp-server.mjs");

function createFakeContext() {
	const tools = new Map();
	const disposers = [];
	const ctx = {
		tools: {
			register(definition) {
				if (tools.has(definition.name)) {
					throw new Error(`duplicate tool ${definition.name}`);
				}
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
	return {
		ctx,
		tools,
		async dispose() {
			for (const dispose of disposers.reverse()) {
				await dispose?.();
			}
		},
	};
}

async function waitFor(predicate, timeoutMs = 8_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("timed out waiting for condition");
}

test("adapter exports the DSH plugin contract", () => {
	assert.equal(name, "pi-lens");
	assert.deepEqual(inject, ["tools"]);
	assert.equal(typeof apply, "function");
	assert.equal(typeof adapterVersion, "string");
	const config = Config({ serverPath: server });
	assert.equal(config.enabled, true);
	assert.equal(config.maxRestarts, 3);
	assert.equal(config.requestTimeoutMs, 120_000);
});

test("apply registers the status tool and every advertised MCP capability", async () => {
	const harness = createFakeContext();
	const config = Config({
		serverPath: server,
		cwd: fixtures,
		restartOnCrash: false,
	});
	try {
		apply(harness.ctx, config);
		await waitFor(() => harness.tools.has("pilens_diagnostics"));

		assert.ok(harness.tools.has("pilens_status"));
		assert.ok(harness.tools.has("pilens_echo"));
		assert.ok(
			!harness.tools.has("run_code"),
			"reserved tool must not be proxied",
		);

		const status = await readStatus(harness);
		assert.match(status, /lifecycle: ACTIVE/);
		await waitFor(async () => /engine: ready/.test(await readStatus(harness)));
		assert.match(await readStatus(harness), /protocol: 2025-06-18/);
		assert.match(await readStatus(harness), /tools: 6/);
	} finally {
		await harness.dispose();
	}
	assert.equal(harness.tools.size, 0, "unload must dispose every registration");
});

test("MCP schemas are projected into the supported DSH subset", async () => {
	const harness = createFakeContext();
	try {
		apply(
			harness.ctx,
			Config({ serverPath: server, cwd: fixtures, restartOnCrash: false }),
		);
		await waitFor(() => harness.tools.has("pilens_diagnostics"));

		const diagnostics = harness.tools.get("pilens_diagnostics");
		assert.equal(diagnostics.parameters.type, "object");
		assert.equal(diagnostics.parameters.additionalProperties, true);
		assert.deepEqual(diagnostics.parameters.required, ["cwd"]);
		assert.deepEqual(diagnostics.parameters.properties.severity.enum, [
			"error",
			"warning",
			"info",
		]);
		const cwd = diagnostics.parameters.properties.cwd;
		assert.equal(cwd.type, "string");
		assert.equal(cwd.format, undefined);
		assert.equal(cwd.minLength, undefined);
		assert.equal(diagnostics.parameters.properties.limit.minimum, undefined);

		const navigate = harness.tools.get("pilens_navigate");
		assert.equal(navigate.parameters.properties.symbol.anyOf, undefined);
		assert.equal(
			navigate.parameters.properties.symbol.description,
			"Symbol name",
		);
	} finally {
		await harness.dispose();
	}
});

test("tool execution proxies arguments and renders compact text", async () => {
	const harness = createFakeContext();
	try {
		apply(
			harness.ctx,
			Config({ serverPath: server, cwd: fixtures, restartOnCrash: false }),
		);
		await waitFor(() => harness.tools.has("pilens_echo"));

		const echo = harness.tools.get("pilens_echo");
		assert.equal(echo.isConcurrencySafe?.(), true);
		const value = await echo.execute(
			{ value: "hello" },
			{ signal: new AbortController().signal },
		);
		assert.match(value.text, /pilens_echo:\{"value":"hello"\}/);
		const blocks = echo.output.render({ value: "hello" }, value);
		assert.deepEqual(blocks, [{ type: "text", text: value.text }]);

		const diagnostics = harness.tools.get("pilens_diagnostics");
		assert.equal(diagnostics.isConcurrencySafe, undefined);

		await assert.rejects(
			harness.tools
				.get("pilens_fail")
				.execute({}, { signal: new AbortController().signal }),
			/boom/,
		);
	} finally {
		await harness.dispose();
	}
});

test("tool include/exclude filters are honoured", async () => {
	const harness = createFakeContext();
	try {
		apply(
			harness.ctx,
			Config({
				serverPath: server,
				cwd: fixtures,
				restartOnCrash: false,
				includeTools: ["pilens_echo", "pilens_diagnostics"],
				excludeTools: ["pilens_diagnostics"],
			}),
		);
		await waitFor(() => harness.tools.has("pilens_echo"));
		assert.ok(!harness.tools.has("pilens_diagnostics"));
		assert.ok(!harness.tools.has("pilens_navigate"));
		assert.ok(harness.tools.has("pilens_status"));
	} finally {
		await harness.dispose();
	}
});

test("disabled configuration leaves the host untouched", () => {
	const harness = createFakeContext();
	apply(harness.ctx, Config({ enabled: false }));
	assert.equal(harness.tools.size, 0);
});

test("unload disposes the engine child and rejects later calls", async () => {
	const harness = createFakeContext();
	apply(
		harness.ctx,
		Config({ serverPath: server, cwd: fixtures, restartOnCrash: false }),
	);
	await waitFor(() => harness.tools.has("pilens_echo"));
	const echo = harness.tools.get("pilens_echo");
	await harness.dispose();
	await assert.rejects(
		echo.execute({ value: "late" }, { signal: new AbortController().signal }),
		/disposed/,
	);
});

async function readStatus(harness) {
	const status = harness.tools.get("pilens_status");
	assert.ok(status, "status tool must remain registered");
	const value = await status.execute(
		{},
		{ signal: new AbortController().signal },
	);
	return value.text;
}
