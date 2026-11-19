import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Runs only where a DSH host installation is resolvable. The regular suite
 * exercises the adapter with a contract fake, so this file adds the real
 * Cordis `ToolRegistry` path without making the base install depend on the
 * harness's private package graph.
 */
let host;
try {
	const [{ Context }, SystemPrompt, ToolRegistry] = await Promise.all([
		import("@deepseek-ai/cordis"),
		import("@deepseek-ai/dsh-system-prompt"),
		import("@deepseek-ai/dsh-tools"),
	]);
	const executor = await import("@deepseek-ai/dsh-tool-executor-native").catch(
		() => null,
	);
	host = {
		Context,
		SystemPrompt: SystemPrompt.default,
		ToolRegistry: ToolRegistry.default,
		Executor: executor ?? null,
	};
} catch {
	host = null;
}

const fixtures = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"fixtures",
);
const server = path.join(fixtures, "fake-mcp-server.mjs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function textOf(result) {
	return (result.content ?? [])
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("");
}

async function call(ctx, name, args) {
	const signal = new AbortController().signal;
	const id = `host-${name}-${Math.random()}`;
	// DSH 0.2.x executes a batch; 0.0.x executes a single call.
	const batch = await ctx.tools
		.execute({
			calls: [
				{
					type: "tool-call",
					id,
					name,
					arguments: JSON.stringify(args),
				},
			],
			signal,
		})
		.catch(() => null);
	if (batch?.results) return batch.results[0].result;
	return ctx.tools.execute({ callId: id, name, arguments: args, signal });
}

async function waitFor(fn, label, timeoutMs = 8000) {
	const deadline = Date.now() + timeoutMs;
	let last;
	while (Date.now() < deadline) {
		try {
			const value = await fn();
			if (value) return value;
		} catch (error) {
			last = error;
		}
		await sleep(100);
	}
	throw new Error(`${label} timed out${last ? `: ${last.message}` : ""}`);
}

async function safeDispose(fiber) {
	try {
		await fiber.dispose();
	} catch {
		/* already disposed or failed during teardown */
	}
}

test("loads, calls and unloads through a real Cordis tools service", {
	skip: host ? false : "DSH host packages are not installed",
}, async () => {
	const plugin = await import("../../dist/dsh/index.js");
	const { Context, SystemPrompt, ToolRegistry, Executor } = host;
	const ctx = new Context();
	const promptFiber = ctx.plugin(SystemPrompt);
	const toolsFiber = ctx.plugin(ToolRegistry);
	const executorFiber = Executor ? ctx.plugin(Executor) : null;
	const pluginFiber = ctx.plugin(plugin, {
		serverPath: server,
		cwd: path.dirname(server),
		requestTimeoutMs: 5000,
		restartOnCrash: false,
	});

	try {
		await waitFor(() => ctx.tools, "tools service");
		const ready = await waitFor(async () => {
			const result = await call(ctx, "pilens_status", {});
			return /engine: ready/.test(textOf(result)) ? textOf(result) : undefined;
		}, "engine ready");
		assert.match(ready, /lifecycle: ACTIVE/);

		const echoed = await call(ctx, "pilens_echo", { value: "dsh-host" });
		assert.equal(echoed.isError, false);
		assert.match(textOf(echoed), /dsh-host/);

		await pluginFiber.dispose();
		const after = await call(ctx, "pilens_echo", {
			value: "after-unload",
		}).catch(() => ({ isError: true }));
		assert.equal(after.isError, true);
	} finally {
		await safeDispose(pluginFiber);
		if (executorFiber) await safeDispose(executorFiber);
		await safeDispose(toolsFiber);
		await safeDispose(promptFiber);
	}
});
