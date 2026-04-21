import { useEffect, useMemo, useRef, useState } from "react";
import { mountTerminal, type TerminalController } from "./terminal";

type SessionInfo = {
  sessionId: string;
  viewerUrl: string;
  hostWebSocketUrl: string;
  viewerWebSocketUrl: string;
};

type SessionStatus = {
  state: "idle" | "ready" | "active" | "closed";
  hostConnected: boolean;
  viewerCount: number;
  viewerId: string | null;
  canWrite: boolean;
  controllerViewerId: string | null;
  controlLeaseExpiresAt: number | null;
  pendingControlRequest: {
    viewerId: string;
    leaseSeconds: number;
  } | null;
  hasPendingControlRequest: boolean;
};

export function App() {
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const terminal = useRef<TerminalController | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const inputCleanup = useRef<(() => void) | null>(null);
  const canWriteRef = useRef(false);
  const previousStatusRef = useRef<SessionStatus | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(readSessionId());
  const [sessionStatus, setSessionStatus] = useState<SessionStatus | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [requestingControl, setRequestingControl] = useState(false);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [transportState, setTransportState] = useState("idle");
  const reconnectAttempts = useRef(0);
  const reconnectTimer = useRef<number | null>(null);

  const shareUrl = useMemo(() => {
    if (!sessionId || typeof window === "undefined") {
      return "";
    }

    return new URL(`/s/${sessionId}`, window.location.origin).toString();
  }, [sessionId]);
  const hostCommand = useMemo(() => {
    if (!sessionId || typeof window === "undefined") {
      return "";
    }

    return `cd agent && go run ./cmd/ttys-agent -server ${window.location.origin} -session ${sessionId}`;
  }, [sessionId]);
  const shellBootstrapCommand = useMemo(() => {
    if (!sessionId || typeof window === "undefined") {
      return "";
    }

    return `curl -fsSL '${window.location.origin}/start?session=${sessionId}' | sh`;
  }, [sessionId]);
  const powershellBootstrapCommand = useMemo(() => {
    if (!sessionId || typeof window === "undefined") {
      return "";
    }

    return `& ([ScriptBlock]::Create((irm '${window.location.origin}/start.ps1?session=${sessionId}')))`; 
  }, [sessionId]);

  useEffect(() => {
    canWriteRef.current = Boolean(sessionStatus?.canWrite);
  }, [sessionStatus?.canWrite]);

  useEffect(() => {
    if (!terminalRef.current) {
      return;
    }

    terminal.current = mountTerminal(terminalRef.current);
    return () => {
      if (reconnectTimer.current !== null) {
        window.clearTimeout(reconnectTimer.current);
      }
      inputCleanup.current?.();
      socket.current?.close();
      terminal.current?.dispose();
    };
  }, []);

  useEffect(() => {
    if (!sessionId || !terminal.current) {
      return;
    }

    let cancelled = false;
    let activeSocket: WebSocket | null = null;

    function clearReconnectTimer() {
      if (reconnectTimer.current !== null) {
        window.clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
    }

    function closeActiveSocket() {
      const currentSocket = activeSocket;
      if (currentSocket) {
        currentSocket.close();
      }
      if (socket.current === currentSocket) {
        socket.current = null;
      }
      activeSocket = null;
    }

    async function connectViewer() {
      clearReconnectTimer();
      setConnecting(true);
      setTransportState("connecting");
      let status: SessionStatus;

      try {
        const response = await fetch(`/api/session/${sessionId}`);
        if (!response.ok) {
          setStatusNote("Session ended. Refresh or create a new session.");
          setTransportState("closed");
          setConnecting(false);
          return;
        }

        status = (await response.json()) as SessionStatus;
      } catch {
        if (cancelled) {
          return;
        }
        setStatusNote("Unable to reach the server. Retrying...");
        setTransportState("reconnecting");
        setConnecting(false);
        void scheduleReconnect();
        return;
      }

      if (cancelled) {
        return;
      }

      if (status.state === "closed") {
        setSessionStatus(status);
        setStatusNote("Session ended. Refresh or create a new session.");
        setTransportState("closed");
        setConnecting(false);
        return;
      }

      setSessionStatus(status);

      const ws = new WebSocket(viewerSocketURL(sessionId));
      activeSocket = ws;
      socket.current = ws;
      const wasReconnect = reconnectAttempts.current > 0;

      ws.addEventListener("open", () => {
        if (cancelled || activeSocket !== ws) {
          return;
        }
        clearReconnectTimer();
        setTransportState("connected");
        setConnecting(false);
        if (wasReconnect) {
          setStatusNote("Viewer reconnected.");
        } else {
          setStatusNote(null);
        }
        reconnectAttempts.current = 0;
        sendResize();
      });

      ws.addEventListener("message", (event) => {
        if (typeof event.data !== "string") {
          return;
        }

        const parsed = parseControlFrame(event.data);
        if (parsed) {
          handleControlFrame(parsed);
          return;
        }

        terminal.current?.write(event.data);
      });

      ws.addEventListener("close", () => {
        if (activeSocket === ws) {
          activeSocket = null;
        }
        if (socket.current === ws) {
          socket.current = null;
        }
        if (cancelled) {
          return;
        }
        setTransportState("reconnecting");
        setConnecting(false);
        void scheduleReconnect();
      });

      ws.addEventListener("error", () => {
        if (cancelled) {
          return;
        }
        setTransportState("error");
      });

      inputCleanup.current?.();
      inputCleanup.current = terminal.current?.onData((value) => {
        if (!canWriteRef.current) {
          return;
        }
        ws.send(JSON.stringify({ type: "stdin", payload: { data: value } }));
      }) ?? null;
    }

    async function scheduleReconnect() {
      clearReconnectTimer();
      reconnectAttempts.current += 1;
      const attempt = reconnectAttempts.current;
      const delay = Math.min(1000 * attempt, 5000);

      try {
        const response = await fetch(`/api/session/${sessionId}`);
        if (!response.ok) {
          setTransportState("closed");
          setStatusNote("Session ended. Refresh or create a new session.");
          return;
        }

        const status = (await response.json()) as SessionStatus;
        if (cancelled) {
          return;
        }

        setSessionStatus(status);
        if (status.state === "closed") {
          setTransportState("closed");
          setStatusNote("Session ended. Refresh or create a new session.");
          return;
        }

        setStatusNote(`Connection lost. Reconnecting in ${delay / 1000}s...`);
        reconnectTimer.current = window.setTimeout(() => {
          if (cancelled) {
            return;
          }
          void connectViewer();
        }, delay);
      } catch {
        setStatusNote(`Connection lost. Reconnecting in ${delay / 1000}s...`);
        reconnectTimer.current = window.setTimeout(() => {
          if (cancelled) {
            return;
          }
          void connectViewer();
        }, delay);
      }
    }

    function sendResize() {
      if (socket.current?.readyState !== WebSocket.OPEN || !terminal.current) {
        return;
      }

      const { cols, rows } = terminal.current.fit();
      if (!canWriteRef.current) {
        return;
      }
      socket.current.send(JSON.stringify({ type: "resize", payload: { cols, rows } }));
    }

    function handleControlFrame(frame: Record<string, unknown>) {
      if (frame.type === "session.status") {
        const payload = frame.payload as SessionStatus;
        const previous = previousStatusRef.current;
        if (previous) {
          if (!previous.canWrite && payload.canWrite) {
            const leaseUntil = payload.controlLeaseExpiresAt
              ? new Date(payload.controlLeaseExpiresAt).toLocaleTimeString()
              : "the lease expires";
            setStatusNote(`Control granted. Lease active until ${leaseUntil}.`);
          } else if (previous.canWrite && !payload.canWrite) {
            setStatusNote(
              payload.controllerViewerId && payload.controllerViewerId !== payload.viewerId
                ? "Control moved to another viewer."
                : "Control was revoked or the lease expired.",
            );
          } else if (
            previous.pendingControlRequest &&
            !payload.pendingControlRequest &&
            !payload.canWrite
          ) {
            setStatusNote("Control request was declined or cleared.");
          } else if (!previous.pendingControlRequest && payload.pendingControlRequest) {
            setStatusNote("Control request sent. Waiting for host approval.");
          }
        }
        previousStatusRef.current = payload;
        setSessionStatus(payload);
        setRequestingControl(Boolean(payload.pendingControlRequest));
        return;
      }

      if (frame.type === "session.backfill") {
        const chunks = ((frame.payload as { chunks?: string[] }).chunks ?? []).join("");
        if (chunks) {
          terminal.current?.write(chunks);
        }
      }
    }

    void connectViewer();
    window.addEventListener("resize", sendResize);

    return () => {
      cancelled = true;
      clearReconnectTimer();
      window.removeEventListener("resize", sendResize);
      inputCleanup.current?.();
      inputCleanup.current = null;
      closeActiveSocket();
    };
  }, [sessionId]);

  async function createSession() {
    setCreating(true);
    try {
      const response = await fetch("/api/session", { method: "POST" });
      if (!response.ok) {
        throw new Error("failed to create session");
      }

      const created = (await response.json()) as SessionInfo;
      setSessionId(created.sessionId);
      reconnectAttempts.current = 0;
      window.history.replaceState({}, "", created.viewerUrl);
      previousStatusRef.current = null;
      setStatusNote(null);
      terminal.current?.clear();
      terminal.current?.writeln("Session created.");
      terminal.current?.writeln("Waiting for host agent to attach...");
    } finally {
      setCreating(false);
    }
  }

  function requestControl() {
    if (socket.current?.readyState !== WebSocket.OPEN || requestingControl) {
      return;
    }

    socket.current.send(
      JSON.stringify({
        type: "control.request",
        payload: { leaseSeconds: 30 * 60 },
      }),
    );
    setRequestingControl(true);
  }

  const modeLabel = sessionStatus?.canWrite ? "Control granted" : "Read-only";
  let leaseLabel: string | null = null;
  if (sessionStatus?.canWrite && sessionStatus.controlLeaseExpiresAt) {
    leaseLabel = new Date(sessionStatus.controlLeaseExpiresAt).toLocaleTimeString();
  }
  const canRequestControl =
    Boolean(sessionId) &&
    Boolean(sessionStatus?.hostConnected) &&
    !sessionStatus?.canWrite &&
    !sessionStatus?.hasPendingControlRequest &&
    sessionStatus?.controllerViewerId === null;

  let requestControlLabel = "Request control";
  if (sessionStatus?.canWrite) {
    requestControlLabel = "Control active";
  } else if (requestingControl) {
    requestControlLabel = "Request pending...";
  } else if (sessionStatus?.controllerViewerId) {
    requestControlLabel = "Another viewer is controlling";
  }

  return (
    <main className="min-h-screen bg-stone-950 text-stone-100">
      <section className="mx-auto flex min-h-screen max-w-6xl flex-col px-6 py-8">
        <header className="mb-6 flex items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.32em] text-amber-400">
              ttys
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">
              Cloudflare-backed shared terminal
            </h1>
          </div>
          <div className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-sm text-emerald-300">
            {transportState}
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
          <aside className="rounded-3xl border border-white/10 bg-white/5 p-5 backdrop-blur">
            <h2 className="text-sm font-medium uppercase tracking-[0.24em] text-stone-400">
              Status
            </h2>
            <dl className="mt-4 space-y-4 text-sm">
              <div>
                <dt className="text-stone-500">Session</dt>
                <dd className="mt-1 text-stone-200">Anonymous short session</dd>
              </div>
              <div>
                <dt className="text-stone-500">Transport</dt>
                <dd className="mt-1 text-stone-200">Worker + Durable Object</dd>
              </div>
              <div>
                <dt className="text-stone-500">Session ID</dt>
                <dd className="mt-1 break-all text-stone-200">
                  {sessionId ?? "Not created"}
                </dd>
              </div>
              <div>
                <dt className="text-stone-500">Host</dt>
                <dd className="mt-1 text-stone-200">
                  {sessionStatus?.hostConnected ? "Connected" : "Waiting"}
                </dd>
              </div>
              <div>
                <dt className="text-stone-500">Viewers</dt>
                <dd className="mt-1 text-stone-200">
                  {sessionStatus?.viewerCount ?? 0}
                </dd>
              </div>
              <div>
                <dt className="text-stone-500">Mode</dt>
                <dd className="mt-1 text-stone-200">
                  {connecting ? "Connecting" : modeLabel}
                </dd>
              </div>
              <div>
                <dt className="text-stone-500">Control lease</dt>
                <dd className="mt-1 text-stone-200">
                  {leaseLabel ? `Until ${leaseLabel}` : "Not granted"}
                </dd>
              </div>
            </dl>
            <div className="mt-6 space-y-3">
              <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                <p className="text-xs uppercase tracking-[0.22em] text-stone-500">
                  Access
                </p>
                <p className="mt-2 text-sm text-stone-200">
                  {statusNote ??
                    "Viewers are read-only by default. Request control to type into the host shell."}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void createSession()}
                disabled={creating}
                className="w-full rounded-2xl bg-amber-400 px-4 py-3 text-sm font-medium text-stone-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {creating ? "Creating..." : sessionId ? "New session" : "Create session"}
              </button>
              <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                <p className="text-xs uppercase tracking-[0.22em] text-stone-500">
                  Share URL
                </p>
                <p className="mt-2 break-all text-sm text-stone-200">
                  {shareUrl || "Create a session to get a shareable URL."}
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                <p className="text-xs uppercase tracking-[0.22em] text-stone-500">
                  Host command
                </p>
                <p className="mt-2 break-all font-mono text-sm text-stone-200">
                  {hostCommand || "Create a session to get a host attach command."}
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                <p className="text-xs uppercase tracking-[0.22em] text-stone-500">
                  Unix bootstrap
                </p>
                <p className="mt-2 break-all font-mono text-sm text-stone-200">
                  {shellBootstrapCommand || "Create a session to get the curl bootstrap command."}
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                <p className="text-xs uppercase tracking-[0.22em] text-stone-500">
                  PowerShell bootstrap
                </p>
                <p className="mt-2 break-all font-mono text-sm text-stone-200">
                  {powershellBootstrapCommand ||
                    "Create a session to get the PowerShell bootstrap command."}
                </p>
              </div>
              <button
                type="button"
                onClick={requestControl}
                disabled={!canRequestControl || requestingControl}
                className="w-full rounded-2xl border border-sky-400/30 bg-sky-500/10 px-4 py-3 text-sm font-medium text-sky-200 transition hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {requestControlLabel}
              </button>
            </div>
          </aside>

          <section className="rounded-3xl border border-white/10 bg-black/50 p-3 shadow-2xl shadow-black/40">
            <div
              ref={terminalRef}
              className="h-[70vh] overflow-hidden rounded-2xl border border-white/10 bg-[#111111]"
            />
          </section>
        </div>
      </section>
    </main>
  );
}

function readSessionId() {
  if (typeof window === "undefined") {
    return null;
  }

  const match = window.location.pathname.match(/^\/s\/([^/]+)$/);
  return match?.[1] ?? null;
}

function viewerSocketURL(sessionId: string) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/session/${sessionId}/viewer`;
}

function parseControlFrame(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (typeof parsed.type === "string") {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}
