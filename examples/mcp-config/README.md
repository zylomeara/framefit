# MCP client config examples

Ready-to-copy configuration for connecting an MCP client (Claude Code and compatible hosts) to a
locally built framefit server over **stdio**. Build once first:

```bash
cd mcp-server
pnpm install
pnpm build
node scripts/stdio-smoke.mjs
```

The last line is the point of building: it speaks the MCP handshake to the server over stdio, so it
fails if `dist/` came out unusable — which `pnpm build` exiting `0` does not by itself prove.

In every example, replace `/absolute/path/to/framefit/...` with your real checkout path and
`figd_your_token_here` with a [Figma personal access token](../../README.md#figma-token).

## 1. Project scope — `.mcp.json`

[`claude-code-project.json`](claude-code-project.json) is a complete `.mcp.json`. Copy it to the
**root of your project** as `.mcp.json` and Claude Code offers the server to anyone who opens that
project. Edit the path and token, then commit the file *without* the real token (use option 3 to
keep the secret out of version control).

## 2. Global scope — one command

To make the server available in every project, register it globally instead of committing a file:

```bash
# not-executed: requires-mcp-host,contains-placeholder
claude mcp add --scope user framefit \
  --env MCP_TRANSPORT=stdio \
  --env FIGMA_TOKEN=figd_your_token_here \
  -- node /absolute/path/to/framefit/mcp-server/dist/index.js
```

Drop `--scope user` for the default (project-local) registration. `claude mcp list` shows what is
registered; `claude mcp remove framefit` undoes it.

## 3. Keep the token out of the config

Rather than inlining `FIGMA_TOKEN`, put it in `mcp-server/.env` and load it via Node's
`--env-file`, so no secret lives in the committed config:

```json
{
  "mcpServers": {
    "framefit": {
      "type": "stdio",
      "command": "node",
      "args": [
        "--env-file=/absolute/path/to/framefit/mcp-server/.env",
        "/absolute/path/to/framefit/mcp-server/dist/index.js"
      ],
      "env": { "MCP_TRANSPORT": "stdio" }
    }
  }
}
```

`--env-file` needs Node 20.6; `--env-file-if-exists`, used by this repo's own `pnpm dev` /
`pnpm start` and offered as an opt-in below, needs Node 20.19 (or 22.9 on the 22.x line). Both are
above the `"node": ">=20"` in `mcp-server/package.json`, and neither is needed on the README's
Tier-1 path, which passes no env-file flag at all.

### Live iteration on the source

To run the TypeScript sources instead of `dist/`, replace the **whole** `args` array — not just its
last element, which would drop the entry point:

```json
{
  "mcpServers": {
    "framefit": {
      "type": "stdio",
      "command": "node",
      "args": [
        "--import",
        "/absolute/path/to/framefit/mcp-server/node_modules/tsx/dist/loader.mjs",
        "--watch",
        "/absolute/path/to/framefit/mcp-server/src/index.ts"
      ],
      "env": { "MCP_TRANSPORT": "stdio" }
    }
  }
}
```

`mcp-server/scripts/stdio-smoke.mjs` reads that array out of this page and spawns it from a
temporary directory on every CI run, so the block above and the harness cannot drift.

**The loader is named by absolute path on purpose.** `--import tsx` is a bare specifier, and Node
resolves those against the **process working directory** — which for an MCP client is the user's own
project, not this checkout. Measured on node v24.12.0 from a directory outside the checkout, it
fails with `Cannot find package 'tsx' imported from <your project>/` and then prints on stdout
`Failed running '...'. Waiting for file changes before restarting...`.

What happens after that line depends on **whether anything is left in the watch set**, and every
outcome is one an MCP client cannot report. The loader failed before the entry point was ever
resolved, so no source file was registered, and the array above puts nothing else in the set: with
an empty set the process prints that same line and **exits 0** — measured five times at 116-153 ms.
A success code, from a server that answered nothing. Give it anything watchable instead — an
env-file element, or `--watch-path` — and on node v24.12.0 the same argv **stays alive** rather than
exiting, waiting for a change that will never come. The client sees no error and no answer either
way.

**The array carries no env-file flag, because a fresh clone has no `mcp-server/.env`** — and every
way of naming an absent env file costs you something. Measured against an absent file on v20.20.2,
v22.23.2 and v24.12.0:

- `--env-file=<path>` exits **9** before the handshake on all three, printing
  `node: <path>/.env: not found`;
- `--env-file-if-exists=<path>` prints `<path>/.env not found. Continuing without it.` and runs, on
  all three;
- `--env-file-if-exists=<path>` **together with `--watch`** — which is exactly the shape this
  section documents — runs on v20.20.2 and v24.12.0, but on **v22.23.2** it dies before the
  handshake with `Error: ENOENT: no such file or directory, watch '<path>/.env'`.

Node 22 is in this repo's CI matrix, so the array above names no env file at all and works from a
fresh clone on every runtime measured. **Once `mcp-server/.env` exists**, add
`--env-file-if-exists=/absolute/path/to/framefit/mcp-server/.env` as the array's first element: with
the file present, that combination stays up on all three.

Four elements, two of them absolute paths, and both must already exist — `tsx/dist/loader.mjs`,
which `pnpm install` puts under `node_modules/`, and `src/index.ts`.

On **Windows** the loader takes a `file://` URL instead:
`file:///C:/path/to/framefit/mcp-server/node_modules/tsx/dist/loader.mjs`. Only that one element
changes; the entry point takes a plain drive-letter path, and so does `--env-file-if-exists` if you
add it. `--import` is resolved as an ESM specifier, so a drive-letter path parses as a URL whose
scheme is the drive letter — measured with `D:\...`:
`ERR_UNSUPPORTED_ESM_URL_SCHEME ... Received protocol 'd:'`, the same with forward slashes.

## 4. npx one-liner

The package is on npm, so registration takes one line with no clone, no build and no absolute path.
This is the form the README leads with:

```bash
# not-executed: requires-mcp-host,contains-placeholder
claude mcp add framefit --env FIGMA_TOKEN=figd_your_token_here --env MCP_TRANSPORT=stdio -- npx -y framefit
```

The transport flag is not optional: the server defaults to the HTTP transport, which is the shape
the container deployments rely on, so without it this line boots an HTTP server the host never
speaks to.

## HTTP transport

For a hosted (single- or multi-tenant) HTTP server instead of stdio, point the client at a URL:

```json
{ "mcpServers": { "framefit": { "type": "http", "url": "http://127.0.0.1:3846/mcp" } } }
```

See [`docker/README.md`](../../docker/README.md) for running the server behind HTTP.
