import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { apply, Config } from "../../dist/dsh/index.js";

const fixtures = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"fixtures",
);
const server = path.join(fixtures, "fake-mcp-server.mjs");

function createCommandHarness() {
	const tools = new Map();
	const commands = new Map();
	const disposers = [];
	const registry = {
		register(definition) {
			if (commands.has(definition.name)) {
				throw new Error(`duplicate command ${definition.name}`);
			}
			commands.set(definition.name, definition);
			return () => commands.delete(definition.name);
		},
	};
	const ctx = {
		tools: {
			register(definition) {
				tools.set(definition.name, definition);
				return () => tools.delete(definition.name);
			},
		},
		inject(_deps, callback) {
			callback({
				commands: registry,
				effect(factory) {
					const dispose = factory();
					disposers.push(dispose);
					return dispose;
				},
			});
			return { dispose() {} };
		},
		effect(factory) {
			const dispose = factory();
			disposers.push(dispose);
			return dispose;
		},
	};
	return {
		ctx,
		tools,
		commands,
		async dispose() {
			for (const dispose of disposers.reverse()) await dispose?.();
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

function invoke(commands, name, rawInput = "") {
	const definition = commands.get(name);
	assert.ok(definition, `missing command ${name}`);
	return definition.handler({
		rawInput,
		signal: new AbortController().signal,
	});
}

test("registers six pi-lens slash commands", async () => {
	const harness = createCommandHarness();
	try {
		apply(
			harness.ctx,
			Config({ serverPath: server, cwd: fixtures, restartOnCrash: false }),
		);
		await waitFor(() => harness.tools.has("pilens_echo"));

		assert.deepEqual([...harness.commands.keys()].sort(), [
			"lens-config",
			"lens-health",
			"lens-restart",
			"lens-status",
			"lens-toggle",
			"lens-tools",
		]);
		for (const definition of harness.commands.values()) {
			assert.match(definition.description, /^pi-lens:/);
		}
	} finally {
		await harness.dispose();
	}
	assert.equal(harness.commands.size, 0, "unload must unregister commands");
});

test("status, tools, and config commands report adapter state", async () => {
	const harness = createCommandHarness();
	try {
		apply(
			harness.ctx,
			Config({
				serverPath: server,
				cwd: fixtures,
				restartOnCrash: false,
				env: { SECRET_TOKEN: "super-secret-value" },
			}),
		);
		await waitFor(() => harness.tools.has("pilens_echo"));

		const status = await invoke(harness.commands, "lens-status");
		assert.equal(status.kind, "success");
		assert.match(status.text, /lifecycle: ACTIVE/);
		assert.match(status.text, /engine: ready/);
		assert.match(status.text, /enabled: true/);

		const tools = await invoke(harness.commands, "lens-tools");
		assert.equal(tools.kind, "success");
		assert.match(tools.text, /pi-lens tools \(5 registered\)/);
		assert.match(tools.text, /pilens_echo/);
		assert.ok(!tools.text.includes("run_code"), "reserved names stay hidden");

		const config = await invoke(harness.commands, "lens-config");
		assert.equal(config.kind, "success");
		assert.match(config.text, /env keys: SECRET_TOKEN/);
		assert.ok(
			!config.text.includes("super-secret-value"),
			"environment values must stay redacted",
		);
	} finally {
		await harness.dispose();
	}
});

test("health falls back to status when the engine lacks pilens_health", async () => {
	const harness = createCommandHarness();
	try {
		apply(
			harness.ctx,
			Config({ serverPath: server, cwd: fixtures, restartOnCrash: false }),
		);
		await waitFor(() => harness.tools.has("pilens_echo"));

		const health = await invoke(harness.commands, "lens-health");
		assert.equal(health.kind, "success");
		assert.match(health.text, /does not advertise pilens_health/);
		assert.match(health.text, /lifecycle: ACTIVE/);
	} finally {
		await harness.dispose();
	}
});

test("toggle disables tool execution until re-enabled", async () => {
	const harness = createCommandHarness();
	try {
		apply(
			harness.ctx,
			Config({ serverPath: server, cwd: fixtures, restartOnCrash: false }),
		);
		await waitFor(() => harness.tools.has("pilens_echo"));

		const off = await invoke(harness.commands, "lens-toggle", "off");
		assert.equal(off.kind, "success");
		assert.match(off.text, /disabled/);
		await assert.rejects(
			harness.tools
				.get("pilens_echo")
				.execute({ value: "x" }, { signal: new AbortController().signal }),
			/pi-lens is disabled/,
		);

		const on = await invoke(harness.commands, "lens-toggle", "on");
		assert.match(on.text, /enabled/);
		const echoed = await harness.tools
			.get("pilens_echo")
			.execute({ value: "x" }, { signal: new AbortController().signal });
		assert.match(echoed.text, /"x"/);

		const invalid = await invoke(harness.commands, "lens-toggle", "maybe");
		assert.equal(invalid.kind, "error");
		assert.match(invalid.text, /usage:/);
	} finally {
		await harness.dispose();
	}
});

test("restart re-runs the handshake and keeps tools available", async () => {
	const harness = createCommandHarness();
	try {
		apply(
			harness.ctx,
			Config({ serverPath: server, cwd: fixtures, restartOnCrash: false }),
		);
		await waitFor(() => harness.tools.has("pilens_echo"));

		const restarted = await invoke(harness.commands, "lens-restart");
		assert.equal(restarted.kind, "success");
		assert.match(restarted.text, /engine: ready/);
		assert.match(restarted.text, /tools: 6/);

		const echoed = await harness.tools
			.get("pilens_echo")
			.execute(
				{ value: "after-restart" },
				{ signal: new AbortController().signal },
			);
		assert.match(echoed.text, /after-restart/);
	} finally {
		await harness.dispose();
	}
});
