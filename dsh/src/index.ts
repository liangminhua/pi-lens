/**
 * Public DSH entry point. `package.json#exports["."]` and `exports["./dsh"]`
 * point here after the dist build (see `tsconfig.dist.json`). The pi extension
 * entry remains `dist/index.js` at `exports["./pi"]`.
 */

export type { PluginLifecycleState } from "./lifecycle.js";
export { PluginLifecycle } from "./lifecycle.js";
export type { Config as PiLensDshConfig } from "./plugin.js";
export { adapterVersion, apply, Config, inject, name } from "./plugin.js";
