import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
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
	const listeners = new Map();
	const on = (event, listener) => {
		const set = listeners.get(event) ?? new Set();
		set.add(listener);
		listeners.set(event, set);
		return () => set.delete(listener);
	};
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
		on,
		off(event, listener) {
			listeners.get(event)?.delete(listener);
		},
	};
	return {
		ctx,
		tools,
		commands,
		pre(exec) {
			return waterfall(listeners, "tools/pre-execute", [exec], {
				kind: "allow",
			});
		},
		post(exec, result) {
			return waterfall(listeners, "tools/post-execute", [exec, result], {
				kind: "accept",
			});
		},
		async dispose() {
			for (const dispose of disposers.reverse()) await dispose?.();
		},
	};
}

/** Run a recorded waterfall chain, innermost `next()` returning `terminal`. */
function waterfall(listeners, event, args, terminal) {
	const chain = [...(listeners.get(event) ?? [])];
	let call = async () => terminal;
	for (let index = chain.length - 1; index >= 0; index -= 1) {
		const listener = chain[index];
		const downstream = call;
		call = () => listener(...args, downstream);
	}
	return call();
}

async function waitFor(predicate, timeoutMs = 8_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("timed out waiting for condition");
}

function invoke(commands, name, rawInput = "", agent) {
	const definition = commands.get(name);
	assert.ok(definition, `missing command ${name}`);
	return definition.handler({
		rawInput,
		signal: new AbortController().signal,
		agent,
	});
}

test("registers seven pi-lens slash commands", async () => {
	const harness = createCommandHarness();
	try {
		apply(
			harness.ctx,
			Config({ serverPath: server, cwd: fixtures, restartOnCrash: false }),
		);
		await waitFor(() => harness.tools.has("pilens_echo"));

		assert.deepEqual([...harness.commands.keys()].sort(), [
			"lens-allow-edit",
			"lens-health",
			"lens-map",
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

test("status, tools, and map commands report adapter state", async () => {
	const harness = createCommandHarness();
	try {
		apply(
			harness.ctx,
			Config({
				serverPath: server,
				cwd: fixtures,
				restartOnCrash: false,
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
		assert.match(tools.text, /pi-lens tools \(6 registered\)/);
		assert.match(tools.text, /pilens_echo/);
		assert.ok(!tools.text.includes("run_code"), "reserved names stay hidden");

		const map = await invoke(harness.commands, "lens-map");
		assert.equal(map.kind, "success");
		assert.match(map.text, /Project map: 3 file\(s\), 2 edge\(s\)/);
		assert.match(map.text, /fake-lens-map\.html/);
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
		assert.match(restarted.text, /tools: 7/);

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

test("allow-edit arms a one-shot, per-agent read-guard exemption", async () => {
	const workspace = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-dsh-guard-"),
	);
	const target = path.join(workspace, "target.txt");
	const other = path.join(workspace, "other.txt");
	fs.writeFileSync(target, "one\n");
	fs.writeFileSync(other, "two\n");

	const harness = createCommandHarness();
	try {
		apply(
			harness.ctx,
			Config({ serverPath: server, cwd: workspace, restartOnCrash: false }),
		);
		await waitFor(() => harness.tools.has("pilens_echo"));

		const editTarget = { name: "edit", arguments: { file_path: target } };
		const denied = await harness.pre(editTarget);
		assert.equal(denied.kind, "deny");
		assert.match(denied.reason, /Edit without read/);

		await harness.post(
			{ name: "read", arguments: { file_path: target } },
			{ isError: false },
		);
		assert.equal((await harness.pre(editTarget)).kind, "allow");

		const agentA = { id: "agent-a" };
		const agentB = { id: "agent-b" };
		const editOther = (agent) => ({
			name: "edit",
			arguments: { file_path: other },
			agent,
		});

		assert.equal((await harness.pre(editOther(agentA))).kind, "deny");

		const armed = await invoke(
			harness.commands,
			"lens-allow-edit",
			other,
			agentA,
		);
		assert.equal(armed.kind, "success");
		assert.ok(armed.text.includes(other));

		assert.equal(
			(await harness.pre(editOther(agentB))).kind,
			"deny",
			"exemptions stay per agent",
		);
		assert.equal((await harness.pre(editOther(agentA))).kind, "allow");
		assert.equal(
			(await harness.pre(editOther(agentA))).kind,
			"deny",
			"exemption is one-shot",
		);

		const usage = await invoke(harness.commands, "lens-allow-edit", "   ");
		assert.equal(usage.kind, "error");
		assert.match(usage.text, /Usage:/);

		await invoke(harness.commands, "lens-toggle", "off");
		assert.equal(
			(await harness.pre(editOther(agentB))).kind,
			"allow",
			"disabled adapter stops guarding",
		);
	} finally {
		await harness.dispose();
		fs.rmSync(workspace, { recursive: true, force: true });
	}
});
