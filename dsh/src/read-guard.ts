/**
 * Read-before-edit guard for DSH-backed workspaces.
 *
 * pi enforces this guard inside its `tool_call` hook. DSH exposes the same
 * interception point as the `tools/pre-execute` waterfall, so the adapter
 * implements the guard without touching the analysis engine:
 *
 * - `tools/post-execute` observes successful `read` calls and records the file
 *   as read for that agent (own successful writes count too, so a freshly
 *   created file may be edited without re-reading it).
 * - `tools/pre-execute` denies a mutation of an existing file the agent has
 *   not read, unless `/lens-allow-edit` armed a one-shot exemption.
 *
 * The guard covers the filesystem tools DSH ships: `write`, `edit`,
 * `apply_patch` (update hunks) and `str_replace_editor` (non-`view` commands).
 * Shell-based writes are out of scope, matching pi's name-based classification.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Minimal tool-call view supplied by the `tools/*` events. */
export interface ToolExecutionView {
	readonly name: string;
	readonly arguments: unknown;
	readonly agent?: unknown;
}

/** Minimal result view: only the success flag matters to the guard. */
export interface ToolResultView {
	readonly isError?: boolean;
}

/** Subset of DSH's `PreToolDecision` the guard produces. */
export type ToolDecision =
	| { readonly kind: "allow" }
	| { readonly kind: "deny"; readonly reason: string };

const READ_TOOLS: ReadonlySet<string> = new Set(["read"]);
const MUTATING_TOOLS: ReadonlySet<string> = new Set(["write", "edit"]);
const EDITOR_TOOL = "str_replace_editor";
const PATCH_TOOL = "apply_patch";
const PATCH_UPDATE_TARGET = /^\*\*\* Update File:\s*(.+)$/;
const DEFAULT_AGENT = "process";

/** Stable per-agent key: DSH's `Agent` exposes its session id as `id`. */
export function agentKey(agent: unknown): string {
	const id = (agent as { readonly id?: unknown } | undefined)?.id;
	return typeof id === "string" && id.length > 0 ? id : DEFAULT_AGENT;
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: {};
}

function stringField(
	args: Record<string, unknown>,
	...keys: readonly string[]
): string | undefined {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}
	return undefined;
}

function cleanRawPath(raw: string): string {
	let value = raw.trim();
	if (value.length >= 2) {
		const first = value[0];
		const last = value[value.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			value = value.slice(1, -1).trim();
		}
	}
	if (value.startsWith("file://")) value = value.slice("file://".length);
	return value;
}

/** Paths a successful call proves the agent has seen. */
function readTargets(
	name: string,
	args: Record<string, unknown>,
): readonly string[] {
	if (READ_TOOLS.has(name)) {
		const target = stringField(args, "file_path", "filePath", "path");
		return target ? [target] : [];
	}
	if (name === EDITOR_TOOL && stringField(args, "command") === "view") {
		const target = stringField(args, "path", "file_path");
		return target ? [target] : [];
	}
	return [];
}

/** Paths a mutation call is about to write. */
function writeTargets(
	name: string,
	args: Record<string, unknown>,
): readonly string[] {
	if (MUTATING_TOOLS.has(name)) {
		const target = stringField(args, "file_path", "filePath", "path");
		return target ? [target] : [];
	}
	if (name === EDITOR_TOOL) {
		const command = stringField(args, "command");
		const target = stringField(args, "path", "file_path");
		return command && command !== "view" && target ? [target] : [];
	}
	if (name === PATCH_TOOL) {
		const patch = stringField(args, "input", "patch");
		if (!patch) return [];
		return patch
			.split("\n")
			.map((line) => PATCH_UPDATE_TARGET.exec(line)?.[1]?.trim())
			.filter((value): value is string => Boolean(value));
	}
	return [];
}

/**
 * Per-agent read/exemption bookkeeping. Keys are resolved absolute paths, so a
 * relative read and an absolute edit of the same file still agree.
 */
export class ReadGuard {
	private readonly reads = new Map<string, Set<string>>();
	private readonly exemptions = new Map<string, Set<string>>();

	constructor(private readonly workspace: string) {}

	/** Resolve a user-supplied or tool-supplied path against the workspace. */
	resolve(raw: string): string | undefined {
		const value = cleanRawPath(raw);
		if (!value) return undefined;
		if (value === "~") return os.homedir();
		if (value.startsWith("~/")) {
			return path.resolve(os.homedir(), value.slice(2));
		}
		return path.resolve(this.workspace, value);
	}

	/** Arm a one-shot exemption and return the resolved path. */
	allowOnce(agent: unknown, raw: string): string | undefined {
		const target = this.resolve(raw);
		if (!target) return undefined;
		this.bucket(this.exemptions, agentKey(agent)).add(target);
		return target;
	}

	/** Record what a successful call proved or wrote. */
	observe(exec: ToolExecutionView): void {
		const key = agentKey(exec.agent);
		const args = asRecord(exec.arguments);
		for (const raw of [
			...readTargets(exec.name, args),
			...writeTargets(exec.name, args),
		]) {
			const target = this.resolve(raw);
			if (target) this.bucket(this.reads, key).add(target);
		}
	}

	/** Deny reason for an unread mutation, or `undefined` when allowed. */
	check(exec: ToolExecutionView): string | undefined {
		const key = agentKey(exec.agent);
		const args = asRecord(exec.arguments);
		for (const raw of writeTargets(exec.name, args)) {
			const target = this.resolve(raw);
			if (!target) continue;
			if (this.exemptions.get(key)?.delete(target)) continue;
			if (this.reads.get(key)?.has(target)) continue;
			// Creating a new file needs no prior read; only existing content does.
			if (!fs.existsSync(target)) continue;
			return `RETRYABLE — Edit without read: you have not read \`${target}\` in this session. Read it first, then retry: \`read file_path="${target}"\`.`;
		}
		return undefined;
	}

	clear(): void {
		this.reads.clear();
		this.exemptions.clear();
	}

	private bucket(map: Map<string, Set<string>>, key: string): Set<string> {
		let set = map.get(key);
		if (!set) {
			set = new Set();
			map.set(key, set);
		}
		return set;
	}
}

type PreListener = (
	exec: ToolExecutionView,
	next: () => Promise<ToolDecision>,
) => Promise<ToolDecision>;

type PostListener = (
	exec: ToolExecutionView,
	result: ToolResultView,
	next: () => Promise<unknown>,
) => Promise<unknown>;

/** Host surface the guard needs; the real DSH context satisfies it. */
export interface ReadGuardHost {
	on(event: "tools/pre-execute", listener: PreListener): unknown;
	on(event: "tools/post-execute", listener: PostListener): unknown;
	off?(event: "tools/pre-execute", listener: PreListener): void;
	off?(event: "tools/post-execute", listener: PostListener): void;
}

export interface ReadGuardOptions {
	readonly guard: ReadGuard;
	/** The guard follows `/lens-toggle`: disabled plugins do not intercept. */
	readonly isEnabled?: () => boolean;
}

/** Install the two event listeners; returns a disposer. */
export function installReadGuard(
	host: ReadGuardHost,
	options: ReadGuardOptions,
): () => void {
	const enabled = options.isEnabled ?? (() => true);
	const pre: PreListener = async (exec, next) => {
		if (!enabled()) return next();
		const denial = options.guard.check(exec);
		return denial ? { kind: "deny", reason: denial } : next();
	};
	const post: PostListener = async (exec, result, next) => {
		if (enabled() && result?.isError !== true) options.guard.observe(exec);
		return next();
	};
	host.on("tools/pre-execute", pre);
	host.on("tools/post-execute", post);
	return () => {
		options.guard.clear();
		host.off?.("tools/pre-execute", pre);
		host.off?.("tools/post-execute", post);
	};
}
