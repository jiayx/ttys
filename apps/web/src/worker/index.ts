import { TTYSession } from "./session-do";
import { renderPowerShellBootstrap, renderShellBootstrap } from "./bootstrap";

export { TTYSession };

type Env = {
  ASSETS: Fetcher;
  BOOTSTRAP_BINARY_BASE_URL?: string;
  BOOTSTRAP_CHECKSUMS_URL?: string;
  BOOTSTRAP_GITHUB_REPOSITORY?: string;
  TTY_SESSION: DurableObjectNamespace<TTYSession>;
};

type ReleaseManifest = {
  binaryBaseURL: string;
  checksumsURL: string;
  targets: Record<string, string>;
};

const releaseTargets = {
  "darwin-amd64": "ttys-agent-zig-darwin-amd64",
  "darwin-arm64": "ttys-agent-zig-darwin-arm64",
  "linux-amd64": "ttys-agent-zig-linux-amd64",
  "linux-arm64": "ttys-agent-zig-linux-arm64",
  "windows-amd64": "ttys-agent-zig-windows-amd64.exe",
} as const;

const sessionIdAlphabet = "23456789abcdefghjkmnpqrstuvwxyz";
const sessionIdPattern = /^[23456789abcdefghjkmnpqrstuvwxyz]{3}-[23456789abcdefghjkmnpqrstuvwxyz]{3}$/;
const maxSessionIdAttempts = 8;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true });
    }

    if (url.pathname === "/start" && request.method === "GET") {
      return new Response(
        renderShellBootstrap({
          binaryBaseURL: bootstrapBinaryBaseURL(url, env),
          checksumsURL: bootstrapChecksumsURL(url, env),
          serverOrigin: url.origin,
          sessionId: url.searchParams.get("session"),
        }),
        {
          headers: {
            "content-type": "text/x-shellscript; charset=utf-8",
            "cache-control": "no-store",
          },
        },
      );
    }

    if (url.pathname === "/start.ps1" && request.method === "GET") {
      return new Response(
        renderPowerShellBootstrap({
          binaryBaseURL: bootstrapBinaryBaseURL(url, env),
          checksumsURL: bootstrapChecksumsURL(url, env),
          serverOrigin: url.origin,
          sessionId: url.searchParams.get("session"),
        }),
        {
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
          },
        },
      );
    }

    if (url.pathname === "/api/bootstrap/manifest" && request.method === "GET") {
      return Response.json(bootstrapManifest(url, env));
    }

    if (url.pathname.startsWith("/downloads/release/") && request.method === "GET") {
      const assetName = url.pathname.slice("/downloads/release/".length);
      if (!assetName) return new Response("missing asset name", { status: 400 });

      return proxyLatestReleaseAsset(env, assetName);
    }

    if (url.pathname === "/api/session" && request.method === "POST") {
      return createSession(env);
    }

    const statusMatch = url.pathname.match(/^\/api\/session\/(?<sessionId>[^/]+)$/);
    if (statusMatch?.groups && request.method === "GET") {
      const { sessionId } = statusMatch.groups;
      if (!isValidSessionId(sessionId)) {
        return new Response("invalid session id", { status: 400 });
      }
      const id = env.TTY_SESSION.idFromName(sessionId);
      const stub = env.TTY_SESSION.get(id);
      return stub.fetch("https://session.internal/status");
    }

    const match = url.pathname.match(
      /^\/api\/session\/(?<sessionId>[^/]+)\/(?<role>host|viewer)$/,
    );
    if (match?.groups) {
      const { sessionId, role } = match.groups;
      if (!isValidSessionId(sessionId)) {
        return new Response("invalid session id", { status: 400 });
      }
      const id = env.TTY_SESSION.idFromName(sessionId);
      const stub = env.TTY_SESSION.get(id);
      return stub.fetch(
        new Request(`https://session.internal/connect/${role}`, request),
      );
    }

    return env.ASSETS.fetch(request);
  },
};

async function createSession(env: Env): Promise<Response> {
  for (let attempt = 0; attempt < maxSessionIdAttempts; attempt += 1) {
    const sessionId = randomSessionId();
    const id = env.TTY_SESSION.idFromName(sessionId);
    const stub = env.TTY_SESSION.get(id);
    const response = await stub.fetch("https://session.internal/init", {
      method: "POST",
    });

    if (response.status === 409) {
      continue;
    }

    if (!response.ok) {
      return new Response("failed to initialize session", { status: 500 });
    }

    return Response.json({
      sessionId,
      viewerUrl: `/s/${sessionId}`,
      hostWebSocketUrl: `/api/session/${sessionId}/host`,
      viewerWebSocketUrl: `/api/session/${sessionId}/viewer`,
    });
  }

  return new Response("failed to allocate session id", { status: 503 });
}

function randomSessionId() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);

  let value = "";
  for (const byte of bytes) {
    value += sessionIdAlphabet[byte % sessionIdAlphabet.length];
  }

  return `${value.slice(0, 3)}-${value.slice(3)}`;
}

function isValidSessionId(sessionId: string) {
  return sessionIdPattern.test(sessionId);
}

function bootstrapBinaryBaseURL(url: URL, env: Env) {
  if (env.BOOTSTRAP_BINARY_BASE_URL) {
    return env.BOOTSTRAP_BINARY_BASE_URL;
  }

  if (env.BOOTSTRAP_GITHUB_REPOSITORY) {
    return `${url.origin}/downloads/release`;
  }

  return `${url.origin}/downloads/local`;
}

function bootstrapChecksumsURL(url: URL, env: Env) {
  if (env.BOOTSTRAP_CHECKSUMS_URL) {
    return env.BOOTSTRAP_CHECKSUMS_URL;
  }

  return `${bootstrapBinaryBaseURL(url, env)}/checksums.txt`;
}

function bootstrapManifest(url: URL, env: Env): ReleaseManifest {
  const binaryBaseURL = bootstrapBinaryBaseURL(url, env);
  const checksumsURL = bootstrapChecksumsURL(url, env);

  return {
    binaryBaseURL,
    checksumsURL,
    targets: Object.fromEntries(
      Object.entries(releaseTargets).map(([target, assetName]) => [
        target,
        `${binaryBaseURL}/${assetName}`,
      ]),
    ),
  };
}

function latestReleaseAssetURL(env: Env, assetName: string): string {
  const repository = env.BOOTSTRAP_GITHUB_REPOSITORY;
  if (!repository) throw new Error("BOOTSTRAP_GITHUB_REPOSITORY is not configured");
  return `https://github.com/${repository}/releases/latest/download/${assetName}`;
}

async function proxyLatestReleaseAsset(env: Env, assetName: string): Promise<Response> {
  if (!isAllowedReleaseAsset(assetName)) {
    return new Response("unknown release asset", { status: 404 });
  }

  const upstreamURL = latestReleaseAssetURL(env, assetName);
  const upstream = await fetch(upstreamURL, {
    headers: {
      "user-agent": "ttys-bootstrap-proxy",
    },
    redirect: "follow",
  });

  if (!upstream.ok || !upstream.body) {
    return new Response("failed to fetch release asset", {
      status: upstream.status === 404 ? 404 : 502,
    });
  }

  const headers = new Headers();
  headers.set("cache-control", "public, max-age=300");
  headers.set("content-type", contentTypeForAsset(assetName, upstream));
  headers.set("content-disposition", `attachment; filename="${assetName}"`);
  const contentLength = upstream.headers.get("content-length");
  if (contentLength) {
    headers.set("content-length", contentLength);
  }

  return new Response(upstream.body, {
    status: 200,
    headers,
  });
}

function isAllowedReleaseAsset(assetName: string) {
  return assetName === "checksums.txt" || Object.values(releaseTargets).includes(assetName as never);
}

function contentTypeForAsset(assetName: string, upstream: Response) {
  if (assetName === "checksums.txt") {
    return "text/plain; charset=utf-8";
  }
  return upstream.headers.get("content-type") ?? "application/octet-stream";
}
