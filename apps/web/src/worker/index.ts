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
  version: string;
  targets: Record<string, string>;
};

const releaseTargets = {
  "darwin-amd64": "ttys-agent-darwin-amd64",
  "darwin-arm64": "ttys-agent-darwin-arm64",
  "linux-amd64": "ttys-agent-linux-amd64",
  "linux-arm64": "ttys-agent-linux-arm64",
  "windows-amd64": "ttys-agent-windows-amd64.exe",
} as const;

const latestReleaseCacheTtlSeconds = 300;

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
      return Response.json(await bootstrapManifest(url, env), {
        headers: {
          "cache-control": `public, max-age=${latestReleaseCacheTtlSeconds}`,
        },
      });
    }

    if (url.pathname.startsWith("/downloads/release/") && request.method === "GET") {
      const assetName = url.pathname.slice("/downloads/release/".length);
      if (!assetName) return new Response("missing asset name", { status: 400 });

      const release = await latestGitHubRelease(env);
      const downloadURL = releaseAssetURL(env, release.tag_name, assetName);
      return Response.redirect(downloadURL, 302);
    }

    if (url.pathname === "/api/session" && request.method === "POST") {
      const sessionId = crypto.randomUUID();
      const id = env.TTY_SESSION.idFromName(sessionId);
      const stub = env.TTY_SESSION.get(id);
      const response = await stub.fetch("https://session.internal/init", {
        method: "POST",
      });

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

    const statusMatch = url.pathname.match(/^\/api\/session\/(?<sessionId>[^/]+)$/);
    if (statusMatch?.groups && request.method === "GET") {
      const { sessionId } = statusMatch.groups;
      const id = env.TTY_SESSION.idFromName(sessionId);
      const stub = env.TTY_SESSION.get(id);
      return stub.fetch("https://session.internal/status");
    }

    const match = url.pathname.match(
      /^\/api\/session\/(?<sessionId>[^/]+)\/(?<role>host|viewer)$/,
    );
    if (match?.groups) {
      const { sessionId, role } = match.groups;
      const id = env.TTY_SESSION.idFromName(sessionId);
      const stub = env.TTY_SESSION.get(id);
      return stub.fetch(
        new Request(`https://session.internal/connect/${role}`, request),
      );
    }

    return env.ASSETS.fetch(request);
  },
};

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

async function bootstrapManifest(url: URL, env: Env): Promise<ReleaseManifest> {
  const binaryBaseURL = bootstrapBinaryBaseURL(url, env);
  const checksumsURL = bootstrapChecksumsURL(url, env);

  let version = "local";
  if (env.BOOTSTRAP_GITHUB_REPOSITORY) {
    const release = await latestGitHubRelease(env);
    version = release.tag_name;
  }

  return {
    binaryBaseURL,
    checksumsURL,
    version,
    targets: Object.fromEntries(
      Object.entries(releaseTargets).map(([target, assetName]) => [
        target,
        `${binaryBaseURL}/${assetName}`,
      ]),
    ),
  };
}

type GitHubRelease = {
  tag_name: string;
};

async function latestGitHubRelease(env: Env): Promise<GitHubRelease> {
  const repository = env.BOOTSTRAP_GITHUB_REPOSITORY;
  if (!repository) throw new Error("BOOTSTRAP_GITHUB_REPOSITORY is not configured");

  const cache = caches.default;
  const cacheURL = new URL(`https://bootstrap-cache.internal/github/latest/${repository}`);
  const cacheKey = new Request(cacheURL.toString(), { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return (await cached.json()) as GitHubRelease;

  const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "ttys-bootstrap-worker",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub latest release lookup failed: ${response.status}`);
  }

  const release = (await response.json()) as GitHubRelease;
  const cacheResponse = new Response(JSON.stringify(release), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${latestReleaseCacheTtlSeconds}`,
    },
  });
  await cache.put(cacheKey, cacheResponse.clone());
  return release;
}

function releaseAssetURL(env: Env, tag: string, assetName: string): string {
  const repository = env.BOOTSTRAP_GITHUB_REPOSITORY;
  if (!repository) throw new Error("BOOTSTRAP_GITHUB_REPOSITORY is not configured");
  return `https://github.com/${repository}/releases/download/${tag}/${assetName}`;
}
