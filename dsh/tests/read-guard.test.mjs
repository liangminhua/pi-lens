import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
	agentKey,
	installReadGuard,
	ReadGuard,
} from "../../dist/dsh/read-guard.js";

function workspaceFixture(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-guard-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("resolves absolute, relative, home and file:// paths", (t) => {
	const workspace = workspaceFixture(t);
	const guard = new ReadGuard(workspace);

	assert.equal(guard.resolve("src/a.ts"), path.join(workspace, "src/a.ts"));
	assert.equal(guard.resolve("/etc/hosts"), "/etc/hosts");
	assert.equal(guard.resolve("~/x.ts"), path.join(os.homedir(), "x.ts"));
	assert.equal(guard.resolve("file:///tmp/x.ts"), "/tmp/x.ts");
	assert.equal(
		guard.resolve('  "src/quote.ts"  '),
		path.join(workspace, "src/quote.ts"),
	);
	assert.equal(guard.resolve("   "), undefined);
});

test("denies unread edits, allows creation and records reads", (t) => {
	const workspace = workspaceFixture(t);
	const target = path.join(workspace, "target.ts");
	fs.writeFileSync(target, "export {};\n");
	const guard = new ReadGuard(workspace);
	const agent = { id: "agent-a" };
	const edit = { name: "edit", arguments: { file_path: target }, agent };

	assert.match(guard.check(edit) ?? "", /Edit without read/);

	guard.observe({ name: "read", arguments: { file_path: target }, agent });
	assert.equal(guard.check(edit), undefined);

	// A successful write makes the file editable without re-reading it.
	assert.equal(
		guard.check({
			name: "edit",
			arguments: { file_path: path.join(workspace, "fresh.ts") },
			agent,
		}),
		undefined,
		"creating a new file needs no read",
	);
	guard.observe({
		name: "write",
		arguments: { file_path: path.join(workspace, "fresh.ts") },
		agent,
	});
	assert.equal(
		guard.check({
			name: "write",
			arguments: { file_path: path.join(workspace, "fresh.ts") },
			agent,
		}),
		undefined,
	);
});

test("tracks reads per agent and consumes exemptions once", (t) => {
	const workspace = workspaceFixture(t);
	const target = path.join(workspace, "target.ts");
	fs.writeFileSync(target, "export {};\n");
	const guard = new ReadGuard(workspace);

	assert.equal(guard.allowOnce({ id: "agent-a" }, "target.ts"), target);
	const editA = {
		name: "edit",
		arguments: { file_path: "target.ts" },
		agent: { id: "agent-a" },
	};
	const editB = {
		name: "edit",
		arguments: { file_path: "target.ts" },
		agent: { id: "agent-b" },
	};

	assert.equal(
		guard.check(editB)?.includes(target),
		true,
		"other agents unaffected",
	);
	assert.equal(guard.check(editA), undefined, "exemption applies once");
	assert.match(
		guard.check(editA) ?? "",
		/Edit without read/,
		"exemption is one-shot",
	);

	assert.equal(agentKey({ id: "agent-a" }), "agent-a");
	assert.equal(agentKey(undefined), "process");
	assert.equal(agentKey({}), "process");
});

test("guards apply_patch update hunks but not additions", (t) => {
	const workspace = workspaceFixture(t);
	const existing = path.join(workspace, "existing.ts");
	fs.writeFileSync(existing, "export {};\n");
	const guard = new ReadGuard(workspace);

	const update = {
		name: "apply_patch",
		arguments: {
			input:
				"*** Begin Patch\n*** Update File: existing.ts\n@@\n-a\n+b\n*** End Patch\n",
		},
	};
	assert.match(guard.check(update) ?? "", /Edit without read/);

	const addition = {
		name: "apply_patch",
		arguments: {
			input:
				"*** Begin Patch\n*** Add File: brand-new.ts\n+new\n*** End Patch\n",
		},
	};
	assert.equal(guard.check(addition), undefined);

	guard.observe({ name: "read", arguments: { file_path: "existing.ts" } });
	assert.equal(guard.check(update), undefined);
});

test("counts str_replace_editor view as a read", (t) => {
	const workspace = workspaceFixture(t);
	const target = path.join(workspace, "file.ts");
	fs.writeFileSync(target, "export {};\n");
	const guard = new ReadGuard(workspace);
	const mutation = {
		name: "str_replace_editor",
		arguments: { command: "str_replace", path: "file.ts" },
	};

	assert.match(guard.check(mutation) ?? "", /Edit without read/);
	guard.observe({
		name: "str_replace_editor",
		arguments: { command: "view", path: "file.ts" },
	});
	assert.equal(guard.check(mutation), undefined);
});

test("installs pre/post listeners that respect the enabled flag", async (t) => {
	const workspace = workspaceFixture(t);
	const target = path.join(workspace, "file.ts");
	fs.writeFileSync(target, "export {};\n");

	const listeners = new Map();
	const host = {
		on(event, listener) {
			const set = listeners.get(event) ?? new Set();
			set.add(listener);
			listeners.set(event, set);
		},
		off(event, listener) {
			listeners.get(event)?.delete(listener);
		},
	};
	let enabled = true;
	const dispose = installReadGuard(host, {
		guard: new ReadGuard(workspace),
		isEnabled: () => enabled,
	});

	const runPre = async (exec) => {
		const listenersForEvent = [...(listeners.get("tools/pre-execute") ?? [])];
		let call = async () => ({ kind: "allow" });
		for (const listener of listenersForEvent.reverse()) {
			const next = call;
			call = () => listener(exec, next);
		}
		return call();
	};
	const runPost = async (exec, result) => {
		const listenersForEvent = [...(listeners.get("tools/post-execute") ?? [])];
		let call = async () => ({ kind: "accept" });
		for (const listener of listenersForEvent.reverse()) {
			const next = call;
			call = () => listener(exec, result, next);
		}
		return call();
	};

	const edit = { name: "edit", arguments: { file_path: target } };
	assert.equal((await runPre(edit)).kind, "deny");

	await runPost(
		{ name: "read", arguments: { file_path: target } },
		{ isError: false },
	);
	assert.equal((await runPre(edit)).kind, "allow");

	// Failed reads must not grant edit access.
	const other = path.join(workspace, "other.ts");
	fs.writeFileSync(other, "export {};\n");
	await runPost(
		{ name: "read", arguments: { file_path: other } },
		{ isError: true },
	);
	assert.equal(
		(await runPre({ name: "edit", arguments: { file_path: other } })).kind,
		"deny",
	);

	enabled = false;
	assert.equal(
		(await runPre({ name: "edit", arguments: { file_path: other } })).kind,
		"allow",
	);

	dispose();
	assert.equal(listeners.get("tools/pre-execute")?.size ?? 0, 0);
	assert.equal(listeners.get("tools/post-execute")?.size ?? 0, 0);
	assert.equal(
		(await runPre({ name: "edit", arguments: { file_path: other } })).kind,
		"allow",
	);
});
