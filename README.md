# ttys

Anonymous shared terminal over Cloudflare Workers and Durable Objects.

## Components

- `apps/web`: React + Vite frontend and Cloudflare Worker
- `agent`: Go host agent
- `agent-zig`: Zig host agent
- `scripts`: local development and bootstrap helpers

## Current State

- The web app can create a session, attach viewers, and bridge host/viewer websocket traffic through the Worker.
- The Zig agent is the default implementation used by bootstrap downloads.
- The Go agent remains available as a reference implementation and local development fallback.

## Repository Layout

- `apps/web`: browser UI, Worker routes, Durable Object logic
- `agent/cmd/ttys-agent`: Go CLI entrypoint
- `agent/internal`: Go PTY, websocket transport, platform handling, session flow
- `agent-zig/src`: Zig PTY, transport, terminal, and session flow
- `.github/workflows/build-agents.yml`: CI build matrix for Go and Zig release assets

## Requirements

- Node.js with `pnpm`
- Go `1.24.2` or compatible toolchain
- Zig `0.16.0` for `agent-zig`
- A Cloudflare account for deployment

## Web Development

Install dependencies:

```bash
pnpm install
```

Run the web app locally:

```bash
pnpm dev
```

Build the web app:

```bash
pnpm build
```

Deploy the Worker:

```bash
pnpm deploy
```

## Go Agent

Build:

```bash
cd agent
go build ./...
```

Run against a local server:

```bash
./scripts/start.sh http://localhost:5173
```

Attach to an existing session:

```bash
./scripts/start.sh http://localhost:5173 <session-id>
```

Windows PowerShell entrypoint:

```powershell
./scripts/start.ps1 -Server http://localhost:5173
```

Direct Go CLI usage:

```bash
cd agent
go run ./cmd/ttys-agent -server http://localhost:5173
```

Flags:

- `-server`: HTTP base URL or direct host websocket URL
- `-session`: existing session ID when using an HTTP server URL
- `-shell`: shell to launch

## Zig Agent

Build the default native target:

```bash
cd agent-zig
zig build
```

Build Windows:

```bash
cd agent-zig
zig build -Dtarget=x86_64-windows-gnu
```

Build Linux:

```bash
cd agent-zig
zig build -Dtarget=x86_64-linux-gnu
```

Notes:

- Unix-like targets use the built-in Zig WebSocket transport; no `libcurl` runtime dependency is required.
- Windows uses `WinHTTP` plus `ConPTY`; this path builds successfully but still needs more runtime validation.

## Local Bootstrap Assets

Build a local Zig agent into the web download directory:

```bash
./scripts/build-local-agent.sh
```

This writes the current machine's Zig agent binary to:

- `apps/web/public/downloads/local/ttys-agent-zig-<os>-<arch>[.exe]`
- `apps/web/public/downloads/local/checksums.txt`

## CI and Releases

GitHub Actions workflow:

- `.github/workflows/build-agents.yml`

It builds:

- Go:
  - `ttys-agent-darwin-amd64`
  - `ttys-agent-darwin-arm64`
  - `ttys-agent-linux-amd64`
  - `ttys-agent-linux-arm64`
  - `ttys-agent-windows-amd64.exe`
- Zig:
  - `ttys-agent-zig-darwin-amd64`
  - `ttys-agent-zig-darwin-arm64`
  - `ttys-agent-zig-linux-amd64`
  - `ttys-agent-zig-linux-arm64`
  - `ttys-agent-zig-windows-amd64.exe`

On `v*` tags, the workflow also publishes all assets plus `checksums.txt` to GitHub Releases.

## Status Guidance

Bootstrap downloads use the Zig agent by default.

On Linux, the Zig release binary uses the portable transport by default.
