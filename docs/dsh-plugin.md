# DeepSeek Harness plugin

`pi-lens` ships a native [DeepSeek Harness](https://deepseek.com/harness/en/)
(DSH) plugin built on Cordis. The plugin proxies the engine's MCP server, so
every capability advertised on `tools/list` becomes a native DSH tool without
duplicating analysis logic. The same package still loads as a pi extension; the
two entry points are independent.

## Install

```bash
# From the registry (once published)
dsh plugin --profile tui add pi-lens

# From a local tarball (absolute path required)
dsh plugin --profile tui add /absolute/path/pi-lens-4.5.1.tgz
```

Restart the profile after installing. `dsh plugin --profile tui --dump-config`
shows the inserted `pi-lens` row.

The bundle patch is:

```yaml
- insert:
    - id: pi-lens
      name: pi-lens
```

The package root resolves to the DSH entry (`dist/dsh/index.js`). The pi
extension stays at the `./pi` subpath and `package.json#pi.extensions`, so the
harness never imports pi host packages such as `@earendil-works/pi-tui`.

## Slash commands

Six commands are registered through the `commands` service and appear in the
`/` palette. They run immediately and are never sent to the model.

| Command | Purpose |
|---|---|
| `/lens-status` | Adapter lifecycle, engine state, tool count, restarts, last error |
| `/lens-health` | Engine health report; falls back to adapter status when `pilens_health` is absent |
| `/lens-toggle` | Enable or disable adapter tool calls (`on` / `off`; empty toggles) |
| `/lens-tools` | List the MCP capabilities exposed as DSH tools |
| `/lens-restart` | Restart the engine and re-run the MCP handshake |
| `/lens-config` | Effective config; environment keys are shown, values stay redacted |

The command surface maps the portable pi commands (`lens-health`, `lens-toggle`,
`lens-tools`) and replaces the pi-only UI commands (`lens-map`,
`lens-widget-toggle`, `lens-allow-edit`) with DSH-native equivalents. Map
generation and the pi TUI widget have no DSH counterpart; use
`pilens_project_report` for structured project data.

## Configuration

Configuration is validated by Schemastery before `apply` runs.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Load the adapter; `false` leaves the host untouched |
| `serverPath` | `""` | Absolute path to `pi-lens-mcp`; empty uses the sibling `dist/mcp/server.js` |
| `cwd` | `""` | Workspace handed to the engine; empty uses the host cwd |
| `startupTimeoutMs` | `15000` | MCP initialize timeout |
| `requestTimeoutMs` | `120000` | Per tool call timeout |
| `includeTools` | `[]` | Empty includes every advertised tool |
| `excludeTools` | `[]` | Tool names never proxied |
| `restartOnCrash` | `true` | Restart after an unexpected engine exit |
| `maxRestarts` | `3` | Consecutive restart budget |
| `restartBackoffMs` | `500` | Base for exponential backoff, capped at 30s |
| `maxTextChars` | `120000` | Truncation bound for tool text |
| `env` | `{}` | Extra environment variables forwarded to the engine |
| `debug` | `false` | Write adapter diagnostics to stderr |

Override per profile in `cordis.patch.yml`:

```yaml
- id: pi-lens
  config:
    cwd: /workspace/project
    excludeTools: [pilens_autofix]
```

## Lifecycle

`dsh/src/lifecycle.ts` enforces the host phases:

```text
PENDING -> LOADING -> ACTIVE -> UNLOADING -> DISPOSED
                          \-> DEGRADED -/
```

- `apply` starts the engine in the background; tools become available after the
  MCP handshake and `tools/list`.
- A failed start or unexpected exit moves the adapter to `DEGRADED` and schedules
  a restart with exponential backoff.
- Unload disposes the MCP child, commands, timers, and every tool registration.
  After unload, calls are rejected by the host.

## Protocol and tools

`dsh/src/mcp-client.ts` implements MCP over stdio with newline-delimited
JSON-RPC 2.0: `initialize`, `notifications/initialized`, paginated `tools/list`,
`tools/call`, cancellation, per-request timeouts, and SIGTERM then SIGKILL
cleanup. Only a minimal environment is forwarded to the child.

Each advertised tool is projected by `dsh/src/schema.ts` into the JSON Schema
subset DSH enforces. Unsupported keywords become open annotation nodes; nesting
is bounded to reject malicious schemas. `run_code` is reserved and never
proxied. Only tools declaring `readOnlyHint` are marked concurrency-safe.

`pilens_status` is always registered and reports lifecycle, engine state,
protocol version, tool count, restarts, pid, and the last error.

## Compatibility and tests

```bash
npm run build:dsh   # compile dist/dsh
npm run test:dsh    # protocol, lifecycle, commands, schema, packaging, performance
npm run verify      # tests + DSH compliance gate + pi packaging checks
```

The suite covers:

- MCP framing, handshake, cancellation, timeouts, and child cleanup.
- Plugin contract, tool registration, schema projection, filters, and unload.
- Six slash commands, including toggle enforcement and config redaction.
- Real Cordis host load/call/unload where DSH packages are installed.
- A fake MCP server with deterministic slow, failing, and read-only tools.
- Tool-catalog and schema-depth performance bounds.
- Manifest, peer-dependency, export, and bundle-patch checks.

## Packaging

```bash
npm run pack:check
# or
npm run build:dist
npm pack --pack-destination release
```

`scripts/verify-plugin.mjs` validates the package against DSH Plugin Standard
2.0.0. The release tarball includes the DSH entry, bundle patch, source, docs,
and the verifier.

## Troubleshooting

- **Plugin not listed** — check `dsh plugin --profile tui --dump-config` for the
  `pi-lens` row and run `dsh plugin --profile tui list`.
- **Engine stuck in `DEGRADED`** — run `/lens-status`; the `lastError` and the
  last stderr lines identify a missing binary, bad `serverPath`, or timeout.
- **Tools missing** — run `/lens-tools`; verify `includeTools` / `excludeTools`
  and that the engine advertised the capability on `tools/list`.
- **Restart budget exhausted** — after `maxRestarts` consecutive crashes the
  adapter stays degraded instead of crash-looping. Fix the engine failure and
  reload the plugin.
- **`ERR_MODULE_NOT_FOUND: @earendil-works/pi-tui` on activation** — the
  profile is loading an old package root that still points at the pi extension.
  Reinstall the packaged release; its root export is `dist/dsh/index.js`, while
  the pi entry lives at `dist/index.js` and `./pi`. Do not point a row at an
  extracted folder's `dist/index.js`.

## Compatibility with pi

The DSH adapter is additive. `pi` continues to load `dist/index.js` through
`package.json#pi.extensions` and `exports["./pi"]`; the DSH root export, patch,
and manifests are not on pi's load path.
