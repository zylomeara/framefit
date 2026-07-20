# MCP client config examples

Ready-to-copy configuration for connecting an MCP client (Claude Code and compatible hosts) to a
locally built framefit server over **stdio**. Build once first:

```bash
cd mcp-server && pnpm install && pnpm build
```

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

For live iteration on the source, swap the last arg for
`--import tsx --watch /absolute/path/to/framefit/mcp-server/src/index.ts`.

## 4. Future — npx one-liner

Once the npm package is published, the clone-and-build step disappears and registration becomes a
single line (no absolute paths):

```bash
claude mcp add framefit --env FIGMA_TOKEN=figd_your_token_here -- npx -y framefit
```

This section will be updated with the published package name.

## HTTP transport

For a hosted (single- or multi-tenant) HTTP server instead of stdio, point the client at a URL:

```json
{ "mcpServers": { "framefit": { "type": "http", "url": "http://127.0.0.1:3846/mcp" } } }
```

See [`docker/README.md`](../../docker/README.md) for running the server behind HTTP.
