import { TTYSession } from "./session-do";
import { renderPowerShellBootstrap, renderShellBootstrap } from "./bootstrap";

export { TTYSession };

type Env = {
  ASSETS: Fetcher;
  BOOTSTRAP_BINARY_BASE_URL?: string;
  BOOTSTRAP_CHECKSUMS_URL?: string;
  BOOTSTRAP_GITHUB_REPOSITORY?: string;
  BOOTSTRAP_GITHUB_TAG?: string;
  TTY_SESSION: DurableObjectNamespace<TTYSession>;
};

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
      const baseURL = bootstrapBinaryBaseURL(url, env);
      const checksumsURL = bootstrapChecksumsURL(url, env);
      return Response.json({
        binaryBaseURL: baseURL,
        checksumsURL,
        targets: {
          "darwin-amd64": `${baseURL}/ttys-agent-darwin-amd64`,
          "darwin-arm64": `${baseURL}/ttys-agent-darwin-arm64`,
          "linux-amd64": `${baseURL}/ttys-agent-linux-amd64`,
          "linux-arm64": `${baseURL}/ttys-agent-linux-arm64`,
          "windows-amd64": `${baseURL}/ttys-agent-windows-amd64.exe`,
          "windows-arm64": `${baseURL}/ttys-agent-windows-arm64.exe`,
        },
      });
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

  if (env.BOOTSTRAP_GITHUB_REPOSITORY && env.BOOTSTRAP_GITHUB_TAG) {
    return `https://github.com/${env.BOOTSTRAP_GITHUB_REPOSITORY}/releases/download/${env.BOOTSTRAP_GITHUB_TAG}`;
  }

  return `${url.origin}/downloads/local`;
}

function bootstrapChecksumsURL(url: URL, env: Env) {
  if (env.BOOTSTRAP_CHECKSUMS_URL) {
    return env.BOOTSTRAP_CHECKSUMS_URL;
  }

  return `${bootstrapBinaryBaseURL(url, env)}/checksums.txt`;
}
