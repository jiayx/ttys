# ttys

Anonymous shared terminal over Cloudflare Workers and Durable Objects.

## Stack

- Host agent: Go
- Web: Vite 8 + TypeScript + React
- Worker runtime: Cloudflare Workers + Durable Objects
- Styling: Tailwind CSS

## Layout

- `apps/web`: frontend and Worker code
- `agent`: local host bridge
- `scripts`: bootstrap scripts for macOS, Linux, and Windows

## Current status

- Browser UI can create a session and attach as a viewer on `/s/:sessionId`
- Worker and Durable Object can create a session, expose host/viewer websocket routes, and fan out host output to viewers
- Viewers are read-only by default and can request control; the host must approve the request locally, and control is granted for a 30 minute lease
- The Go agent turns the current terminal window into the shared session frontend, keeps the PTY one row shorter, and reserves the last row for a local status bar
- The local status bar stays visible, shows viewers/control/session lifecycle state, and uses `Ctrl-G` as the local action prefix
- Sessions expire automatically after 2 hours, pending control requests expire after 30 seconds, and host disconnects get a 60 second reconnection grace period
- Windows builds now use ConPTY instead of the previous stub

## Local development

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

Build the Go agent:

```bash
cd agent
go build ./...
```

## Manual host flow

Run the agent against the local dev server base URL and let it create a session automatically:

```bash
./scripts/start.sh http://127.0.0.1:8787
```

The agent will print the session id and the share URL.

By default, everyone opening the share URL is read-only. A viewer must request control from the browser, and the host terminal can respond with local actions without leaving the shared session view.
The browser UI will show explicit access notes when a control request is pending, granted, declined, revoked, or expired.
The Worker also exposes bootstrap entrypoints at `/start` and `/start.ps1`, plus `/api/bootstrap/manifest` for platform download URLs.

The host terminal uses a single-line local status bar and `Ctrl-G` action prefix:

- `Ctrl-G a`: approve the pending control request
- `Ctrl-G d`: deny the pending control request
- `Ctrl-G r`: revoke the current controller
- `Ctrl-G s`: show an expanded status summary in the status bar
- `Ctrl-G q`: cancel local action mode

## Bootstrap distribution

- `GET /start`: Unix bootstrap script for `curl | sh`
- `GET /start.ps1`: PowerShell bootstrap script
- `GET /api/bootstrap/manifest`: platform-to-binary URL manifest

By default, bootstrap scripts download binaries from `${origin}/downloads/local/...`. For local testing, build the current machine's agent into that directory:

```bash
./scripts/build-local-agent.sh
```

The local build script emits a platform-specific asset name plus `checksums.txt`, and the bootstrap scripts verify SHA-256 before execution.

For production, you can either set:

- `BOOTSTRAP_BINARY_BASE_URL`
- `BOOTSTRAP_CHECKSUMS_URL`

or let the Worker derive GitHub Releases URLs from:

- `BOOTSTRAP_GITHUB_REPOSITORY`
- `BOOTSTRAP_GITHUB_TAG`

In that mode, the Worker will serve bootstrap scripts that download `ttys-agent-<os>-<arch>[.exe]` plus `checksums.txt` from the matching GitHub release.

You can still attach to an existing session:

```bash
./scripts/start.sh http://127.0.0.1:8787 <session-id>
```

Or bypass session creation entirely with a direct websocket endpoint:

```bash
cd agent
go run ./cmd/ttys-agent -server ws://127.0.0.1:8787/api/session/<session-id>/host
```

## Next steps

1. Replace the placeholder bootstrap scripts with real platform detection and binary download
2. Implement read-only vs control tokens
3. Add Windows ConPTY support
4. Replace the dev-only host command in the browser with the real one-line bootstrap command
