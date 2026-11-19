import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const patch = readFileSync(path.join(root, "cordis.patch.yml"), "utf8");

test("package declares a DSH bundle patch wired to a real file", () => {
	assert.equal(pkg.name, "pi-lens");
	assert.equal(pkg.type, "module");
	assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
	assert.ok(existsSync(path.join(root, "cordis.patch.yml")));
	assert.match(patch, /- insert:/);
	assert.match(patch, /^\s+name: pi-lens$/m);
	assert.equal(pkg.exports["."], "./dist/dsh/index.js");
	assert.equal(pkg.exports["./dsh"], "./dist/dsh/index.js");
	assert.ok(pkg.pi.extensions.includes("./dist/index.js"));
	assert.match(patch, /^\s*-\s*id: pi-lens$/m);
});

test("shared DSH runtimes are peer dependencies, never dependencies", () => {
	for (const name of [
		"@deepseek-ai/cordis",
		"@deepseek-ai/dsh-tools",
		"@deepseek-ai/schemastery",
	]) {
		assert.ok(pkg.peerDependencies?.[name], `${name} must be a peerDependency`);
		assert.equal(pkg.dependencies?.[name], undefined);
		assert.equal(pkg.peerDependenciesMeta?.[name]?.optional, true);
	}
});

test("exports and package files cover the DSH runtime artifacts", () => {
	assert.equal(pkg.exports["./dsh"], "./dist/dsh/index.js");
	assert.equal(pkg.exports["./package.json"], "./package.json");
	assert.equal(pkg.exports["./cordis.patch.yml"], "./cordis.patch.yml");
	assert.ok(pkg.files.includes("dist/dsh/"));
	assert.ok(pkg.files.includes("cordis.patch.yml"));
	assert.ok(pkg.scripts.typecheck || pkg.scripts.lint);
	assert.ok(pkg.scripts.build);
	assert.ok(pkg.scripts.test);
	assert.ok(pkg.scripts.verify);
	assert.ok(pkg.scripts["pack:check"] || pkg.scripts.pack);
});

test("DSH capability manifest names the tools service and MCP protocol", () => {
	const capabilities = pkg.dsh.capabilities;
	assert.deepEqual(capabilities.services, ["tools"]);
	assert.deepEqual(capabilities.protocols, ["mcp/stdio"]);
	assert.equal(capabilities.tools.dynamic, true);
	assert.ok(capabilities.extensionPoints.includes("ctx.effect"));
	assert.ok(capabilities.extensionPoints.includes("ctx.tools.register"));
});

test("the vendored compliance gate has no MUST violations", () => {
	const result = spawnSync(
		process.execPath,
		[path.join(root, "scripts/verify-plugin.mjs"), root, "--json"],
		{ encoding: "utf8" },
	);
	assert.equal(
		result.status,
		0,
		`verify-plugin failed:\n${result.stdout}\n${result.stderr}`,
	);
});
