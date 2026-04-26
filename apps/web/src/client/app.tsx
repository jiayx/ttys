import { useEffect, useMemo, useRef, useState } from "react";
import { mountTerminal, type TerminalController } from "./terminal";
import {
  BinaryMessageType,
  binarySocketDataToArrayBuffer,
  encodeBinaryMessage,
} from "../protocol";

type SessionInfo = {
  sessionId: string;
  viewerUrl: string;
  hostWebSocketUrl: string;
  viewerWebSocketUrl: string;
};

type SessionStatus = {
  role: "host" | "viewer" | null;
  state: "idle" | "ready" | "active" | "closed";
  hostState: HostState;
  hostConnected: boolean;
  viewerCount: number;
  viewerId: string | null;
  viewerToken: string | null;
  canWrite: boolean;
  controllerViewerId: string | null;
  controlLeaseExpiresAt: number | null;
  pendingControlRequest: {
    viewerId: string;
    leaseSeconds: number;
  } | null;
  hasPendingControlRequest: boolean;
  sessionExpiresAt: number | null;
  hostDisconnectDeadline: number | null;
  pendingRequestExpiresAt: number | null;
};

type PlatformTab = "macos" | "linux" | "windows";
type TransportState = "idle" | "connecting" | "connected" | "reconnecting" | "closed" | "error";
type HostState = "waiting" | "online" | "reconnecting" | "offline";
type CopyLabel = "Copy" | "Copied" | "Copy failed";
type FlashPalette = {
  first: string;
  firstGlow: string;
  second: string;
  secondGlow: string;
};

const OFFLINE_STATUS_POLL_MS = 3000;

class SessionEndedError extends Error {}

export function App() {
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const terminal = useRef<TerminalController | null>(null);
  const requestControlButtonRef = useRef<HTMLButtonElement | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const inputCleanup = useRef<(() => void) | null>(null);
  const canWriteRef = useRef(false);
  const previousStatusRef = useRef<SessionStatus | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(readSessionId());
  const [sessionStatus, setSessionStatus] = useState<SessionStatus | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [requestingControl, setRequestingControl] = useState(false);
  const [selectedPlatform, setSelectedPlatform] = useState<PlatformTab>(() => detectPlatformTab());
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [shareCopyLabel, setShareCopyLabel] = useState<CopyLabel>("Copy");
  const [platformCopyLabel, setPlatformCopyLabel] = useState<CopyLabel>("Copy");
  const [transportState, setTransportState] = useState<TransportState>("idle");
  const [now, setNow] = useState(() => Date.now());
  const reconnectAttempts = useRef(0);
  const reconnectTimer = useRef<number | null>(null);
  const suppressReconnectRef = useRef(false);
  const shareCopyTimerRef = useRef<number | null>(null);
  const platformCopyTimerRef = useRef<number | null>(null);
  const sessionInfo = useMemo(() => buildSessionInfo(sessionId), [sessionId]);

  const shareUrl = useMemo(() => {
    return sessionInfo?.viewerUrl ?? "";
  }, [sessionInfo]);
  const shellBootstrapCommand = useMemo(() => {
    if (!sessionId || typeof window === "undefined") {
      return "";
    }

    return `curl -fsSL '${window.location.origin}/start?session=${sessionId}' | sh`;
  }, [sessionId]);
  const windowsBootstrapCommand = useMemo(() => {
    if (!sessionId || typeof window === "undefined") {
      return "";
    }

    return `irm '${window.location.origin}/start.ps1?session=${sessionId}' | iex`;
  }, [sessionId]);
  const platformCommand = useMemo(() => {
    if (selectedPlatform === "windows") {
      return windowsBootstrapCommand;
    }
    return shellBootstrapCommand;
  }, [selectedPlatform, shellBootstrapCommand, windowsBootstrapCommand]);

  useEffect(() => {
    canWriteRef.current = Boolean(sessionStatus?.canWrite);
  }, [sessionStatus?.canWrite]);

  useEffect(() => {
    return () => {
      if (shareCopyTimerRef.current !== null) {
        window.clearTimeout(shareCopyTimerRef.current);
      }
      if (platformCopyTimerRef.current !== null) {
        window.clearTimeout(platformCopyTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [sessionId]);

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

    const currentSessionId = sessionId;
    let cancelled = false;
    let activeSocket: WebSocket | null = null;
    let connectionGeneration = 0;
    type ConnectionAttempt = {
      isStale: () => boolean;
      ownsSocket: (ws: WebSocket) => boolean;
      scheduleRetry: (delay: number, retry: () => void) => void;
    };

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

    async function fetchSessionStatus(): Promise<SessionStatus | null> {
      const response = await fetch(sessionStatusURL(currentSessionId));
      if (!response.ok) {
        if (shouldRetrySessionStatus(response)) {
          return null;
        }
        throw new SessionEndedError();
      }
      return (await response.json()) as SessionStatus;
    }

    function startAttempt(): ConnectionAttempt {
      const generation = ++connectionGeneration;
      return {
        isStale() {
          return cancelled || generation !== connectionGeneration;
        },
        ownsSocket(ws: WebSocket) {
          return !this.isStale() && activeSocket === ws;
        },
        scheduleRetry(delay: number, retry: () => void) {
          reconnectTimer.current = window.setTimeout(() => {
            if (this.isStale()) {
              return;
            }
            retry();
          }, delay);
        },
      };
    }

    async function connectViewer() {
      const attempt = startAttempt();
      clearReconnectTimer();
      setConnecting(true);
      setTransportState("connecting");
      let status: SessionStatus | null;

      try {
        status = await fetchSessionStatus();
      } catch (error) {
        if (attempt.isStale()) {
          return;
        }
        if (error instanceof SessionEndedError) {
          setStatusNote("Session ended. Refresh or create a new session.");
          setTransportState("closed");
          setConnecting(false);
          return;
        }
        setStatusNote("Unable to reach the server. Retrying...");
        setTransportState("reconnecting");
        setConnecting(false);
        void scheduleReconnect(attempt);
        return;
      }

      if (attempt.isStale()) {
        return;
      }

      if (!status) {
        setStatusNote("Unable to reach the server. Retrying...");
        setTransportState("reconnecting");
        setConnecting(false);
        void scheduleReconnect(attempt);
        return;
      }

      if (status.state === "closed") {
        setSessionStatus(status);
        setTransportState("closed");
        setConnecting(false);
        void scheduleOfflineStatusPoll(attempt);
        return;
      }

      setSessionStatus(status);

      const ws = new WebSocket(viewerSocketURL(currentSessionId));
      ws.binaryType = "arraybuffer";
      activeSocket = ws;
      socket.current = ws;

      ws.addEventListener("open", () => {
        if (!attempt.ownsSocket(ws)) {
          return;
        }
        clearReconnectTimer();
        setTransportState("connected");
        setConnecting(false);
        reconnectAttempts.current = 0;
      });

      ws.addEventListener("message", (event: MessageEvent<unknown>) => {
        if (!attempt.ownsSocket(ws)) {
          return;
        }
        const data = event.data;
        if (typeof data !== "string") {
          void handleBinarySocketMessage(data, ws, terminal.current);
          return;
        }

        const parsed = parseControlFrame(data);
        if (parsed) {
          handleControlFrame(parsed);
          return;
        }
      });

      ws.addEventListener("close", () => {
        if (!attempt.ownsSocket(ws)) {
          return;
        }
        activeSocket = null;
        if (socket.current === ws) {
          socket.current = null;
        }
        if (suppressReconnectRef.current) {
          return;
        }
        setTransportState("reconnecting");
        setConnecting(false);
        void scheduleReconnect(attempt);
      });

      ws.addEventListener("error", () => {
        if (!attempt.ownsSocket(ws)) {
          return;
        }
        setTransportState("error");
      });

      inputCleanup.current?.();
      inputCleanup.current = terminal.current?.onData((value) => {
        if (!canWriteRef.current) {
          flashRequestControlButton();
          return;
        }
        ws.send(encodeBinaryMessage(BinaryMessageType.stdin, new TextEncoder().encode(value)));
      }) ?? null;
    }

    async function scheduleReconnect(attempt: ConnectionAttempt) {
      if (attempt.isStale()) {
        return;
      }
      clearReconnectTimer();
      reconnectAttempts.current += 1;
      const attemptNumber = reconnectAttempts.current;
      const delay = Math.min(1000 * attemptNumber, 5000);

      try {
        const status = await fetchSessionStatus();
        if (attempt.isStale()) {
          return;
        }

        if (!status) {
          attempt.scheduleRetry(delay, () => void scheduleReconnect(attempt));
          return;
        }

        setSessionStatus(status);
        if (status.state === "closed") {
          setTransportState("closed");
          void scheduleOfflineStatusPoll(attempt);
          return;
        }

        attempt.scheduleRetry(delay, () => void connectViewer());
      } catch (error) {
        if (attempt.isStale()) {
          return;
        }
        if (error instanceof SessionEndedError) {
          setTransportState("closed");
          setStatusNote("Session ended. Refresh or create a new session.");
          return;
        }
        attempt.scheduleRetry(delay, () => void scheduleReconnect(attempt));
      }
    }

    async function scheduleOfflineStatusPoll(attempt: ConnectionAttempt) {
      if (attempt.isStale()) {
        return;
      }
      clearReconnectTimer();
      setConnecting(false);
      setTransportState("closed");

      reconnectTimer.current = window.setTimeout(async () => {
        if (attempt.isStale()) {
          return;
        }

        try {
          const status = await fetchSessionStatus();
          if (attempt.isStale()) {
            return;
          }

          if (!status) {
            void scheduleOfflineStatusPoll(attempt);
            return;
          }

          setSessionStatus(status);
          if (status.state !== "closed" || status.hostConnected) {
            void connectViewer();
            return;
          }

          void scheduleOfflineStatusPoll(attempt);
        } catch (error) {
          if (error instanceof SessionEndedError) {
            setStatusNote("Session ended. Refresh or create a new session.");
            return;
          }
          if (!attempt.isStale()) {
            void scheduleOfflineStatusPoll(attempt);
          }
        }
      }, OFFLINE_STATUS_POLL_MS);
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
            terminal.current?.focus();
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
        storeViewerToken(currentSessionId, payload.viewerToken);
        setSessionStatus(payload);
        setRequestingControl(Boolean(payload.pendingControlRequest));
        return;
      }
    }

    void connectViewer();

    return () => {
      cancelled = true;
      clearReconnectTimer();
      inputCleanup.current?.();
      inputCleanup.current = null;
      closeActiveSocket();
    };
  }, [sessionId]);

  async function createSession(options: { openInNewTab?: boolean } = {}) {
    setCreating(true);
    try {
      const response = await fetch("/api/session", { method: "POST" });
      if (!response.ok) {
        throw new Error("failed to create session");
      }

      const created = (await response.json()) as SessionInfo;
      const createdInfo = normalizeSessionInfo(created);

      if (options.openInNewTab) {
        window.open(createdInfo.viewerUrl, "_blank", "noopener,noreferrer");
        return;
      }

      suppressReconnectRef.current = true;
      if (reconnectTimer.current !== null) {
        window.clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      inputCleanup.current?.();
      inputCleanup.current = null;
      socket.current?.close();
      socket.current = null;
      setSessionId(created.sessionId);
      reconnectAttempts.current = 0;
      window.history.replaceState({}, "", createdInfo.viewerUrl);
      previousStatusRef.current = null;
      setStatusNote(null);
      setSessionStatus(null);
      setTransportState("idle");
      setConnecting(false);
      terminal.current?.reset();
    } finally {
      suppressReconnectRef.current = false;
      setCreating(false);
    }
  }

  function handleCreateSessionClick(event: React.MouseEvent<HTMLButtonElement>) {
    void createSession({
      openInNewTab: event.metaKey || event.ctrlKey || event.shiftKey,
    });
  }

  async function handleCopy(
    value: string,
    setState: (value: CopyLabel) => void,
    timerRef: { current: number | null },
  ) {
    if (!value) {
      return;
    }

    setState((await copyText(value)) ? "Copied" : "Copy failed");
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setState("Copy");
    }, 2000);
  }

  async function copyText(value: string) {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        return true;
      } catch {
        // Fall back to execCommand below.
      }
    }

    if (typeof document === "undefined") {
      return false;
    }

    try {
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      textarea.style.pointerEvents = "none";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      const copied = document.execCommand("copy");
      document.body.removeChild(textarea);
      return copied;
    } catch {
      return false;
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

  function flashRequestControlButton() {
    const button = requestControlButtonRef.current;
    if (!button) {
      return;
    }

    const palette = pickFlashPalette();
    button.animate(
      [
        {
          transform: "scale(1)",
          borderColor: "rgba(56, 189, 248, 0.3)",
          boxShadow: "0 0 0 rgba(56, 189, 248, 0)",
        },
        {
          transform: "scale(1.01)",
          borderColor: palette.first,
          boxShadow: `0 0 0 2px ${palette.firstGlow}`,
        },
        {
          transform: "scale(1)",
          borderColor: palette.second,
          boxShadow: `0 0 0 3px ${palette.secondGlow}`,
        },
        {
          transform: "scale(1)",
          borderColor: "rgba(56, 189, 248, 0.3)",
          boxShadow: "0 0 0 rgba(56, 189, 248, 0)",
        },
      ],
      {
        duration: 520,
        easing: "ease-out",
      },
    );
  }

  const modeLabel = sessionStatus?.canWrite ? "Control granted" : "Read-only";
  const leaseLabel = formatDeadline(sessionStatus?.controlLeaseExpiresAt ?? null, now);
  const sessionExpiryLabel = formatDeadline(sessionStatus?.sessionExpiresAt ?? null, now);
  const connectionLabel = transportLabel(transportState);
  const canRequestControl =
    Boolean(sessionId) &&
    sessionStatus?.hostState === "online" &&
    !sessionStatus?.canWrite &&
    !sessionStatus?.hasPendingControlRequest &&
    sessionStatus?.controllerViewerId === null;

  let requestControlLabel = "Request control";
  if (sessionStatus?.canWrite) {
    requestControlLabel = "Control active";
  } else if (requestingControl) {
    requestControlLabel = "Request pending...";
  } else if (sessionStatus?.hasPendingControlRequest) {
    requestControlLabel = "Another request is pending";
  } else if (sessionStatus?.controllerViewerId) {
    requestControlLabel = "Another viewer is controlling";
  }

  let createSessionLabel = "Create session";
  if (creating) {
    createSessionLabel = "Creating...";
  } else if (sessionId) {
    createSessionLabel = "New session";
  }

  return (
    <main className="min-h-screen bg-stone-950 text-stone-100">
      <section className="mx-auto flex min-h-screen max-w-6xl flex-col px-6 py-8">
        <header className="mb-6 flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <img
              src="/logo.svg"
              alt=""
              className="h-12 w-12 shadow-[0_0_32px_rgba(251,191,36,0.18)]"
            />
            <div>
              <p className="text-xs uppercase tracking-[0.32em] text-amber-400">
                ttys
              </p>
              <h1 className="mt-2 text-xl font-medium tracking-tight text-stone-200">
                Live terminal sharing
              </h1>
            </div>
          </div>
          <div className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-300">
            {connectionLabel}
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
          <aside className="min-w-0 rounded-3xl border border-white/10 bg-black/30 p-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-medium uppercase tracking-[0.24em] text-stone-400">
                Status
              </h2>
              <button
                type="button"
                onClick={handleCreateSessionClick}
                onAuxClick={(event) => {
                  if (event.button === 1) {
                    event.preventDefault();
                    void createSession({ openInNewTab: true });
                  }
                }}
                disabled={creating}
                className="rounded-full border border-amber-400/60 bg-amber-400/10 px-3.5 py-1.5 text-xs font-semibold text-amber-200 shadow-[0_0_20px_rgba(251,191,36,0.12)] transition hover:border-amber-300 hover:bg-amber-400/20 hover:text-amber-100 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/10 disabled:text-stone-500 disabled:shadow-none"
              >
                {createSessionLabel}
              </button>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-2xl border border-white/8 bg-black/15 p-3">
                <dt className="text-xs uppercase tracking-[0.18em] text-stone-500">Host</dt>
                <dd className="mt-1 capitalize text-stone-200">
                  {sessionStatus?.hostState ?? "waiting"}
                </dd>
              </div>
              <div className="rounded-2xl border border-white/8 bg-black/15 p-3">
                <dt className="text-xs uppercase tracking-[0.18em] text-stone-500">Viewers</dt>
                <dd className="mt-1 text-stone-200">
                  {sessionStatus?.viewerCount ?? 0}
                </dd>
              </div>
              <div className="rounded-2xl border border-white/8 bg-black/15 p-3">
                <dt className="text-xs uppercase tracking-[0.18em] text-stone-500">Mode</dt>
                <dd className="mt-1 text-stone-200">
                  {connecting ? "Connecting" : modeLabel}
                </dd>
              </div>
              <div className="rounded-2xl border border-white/8 bg-black/15 p-3">
                <dt className="text-xs uppercase tracking-[0.18em] text-stone-500">Lease</dt>
                <dd className="mt-1 text-stone-200">
                  {leaseLabel ?? "Not granted"}
                </dd>
              </div>
              <div className="col-span-2 rounded-2xl border border-white/8 bg-black/15 p-3">
                <dt className="text-xs uppercase tracking-[0.18em] text-stone-500">Expires</dt>
                <dd className="mt-1 text-stone-200">
                  {sessionExpiryLabel ?? "Unknown"}
                </dd>
              </div>
            </dl>
            <div className="mt-4 space-y-3">
              <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                <p className="text-xs uppercase tracking-[0.22em] text-stone-500">
                  Access
                </p>
                <p className="mt-2 text-sm text-stone-200">
                  {statusNote ??
                    "Viewers are read-only by default. Request control to type into the host shell."}
                </p>
                <button
                  ref={requestControlButtonRef}
                  type="button"
                  onClick={requestControl}
                  disabled={!canRequestControl || requestingControl}
                  className="mt-3 w-full rounded-2xl border border-sky-400/30 bg-sky-500/10 px-4 py-3 text-sm font-medium text-sky-200 transition hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {requestControlLabel}
                </button>
              </div>
              <div className="min-w-0 rounded-2xl border border-white/10 bg-black/20 p-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs uppercase tracking-[0.22em] text-stone-500">
                    Start host
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      void handleCopy(
                        platformCommand,
                        setPlatformCopyLabel,
                        platformCopyTimerRef,
                      )
                    }
                    disabled={!platformCommand}
                    className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-stone-300 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {platformCopyLabel}
                  </button>
                </div>
                <div className="mt-3 grid grid-cols-3 rounded-2xl border border-white/10 bg-black/30 p-1">
                  <PlatformButton
                    active={selectedPlatform === "macos"}
                    label="macOS"
                    onClick={() => setSelectedPlatform("macos")}
                  />
                  <PlatformButton
                    active={selectedPlatform === "linux"}
                    label="Linux"
                    onClick={() => setSelectedPlatform("linux")}
                  />
                  <PlatformButton
                    active={selectedPlatform === "windows"}
                    label="Windows"
                    onClick={() => setSelectedPlatform("windows")}
                  />
                </div>
                <p className="mt-3 min-w-0 max-w-full overflow-x-auto whitespace-nowrap rounded-xl border border-white/8 bg-black/20 px-3 py-2 font-mono text-sm text-stone-200">
                  {platformCommand ||
                    "Create a session to get the bootstrap command for this platform."}
                </p>
              </div>
              <div className="min-w-0 rounded-2xl border border-white/10 bg-black/20 p-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs uppercase tracking-[0.22em] text-stone-500">
                    Share URL
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      void handleCopy(shareUrl, setShareCopyLabel, shareCopyTimerRef)
                    }
                    disabled={!shareUrl}
                    className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-stone-300 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {shareCopyLabel}
                  </button>
                </div>
                <p className="mt-2 min-w-0 max-w-full overflow-x-auto whitespace-nowrap rounded-xl border border-white/8 bg-black/20 px-3 py-2 text-sm text-stone-200">
                  {shareUrl || "Create a session to get a shareable URL."}
                </p>
              </div>
            </div>
          </aside>

          <section className="min-w-0 rounded-3xl border border-white/10 bg-black/50 p-3 shadow-2xl shadow-black/40 lg:sticky lg:top-6 lg:self-start">
            <div
              ref={terminalRef}
              className="min-w-0 h-[70vh] min-h-96 overflow-hidden rounded-2xl border border-white/10 bg-[#111111] lg:h-[calc(100vh-8rem)]"
            />
          </section>
        </div>
      </section>
    </main>
  );
}

async function handleBinarySocketMessage(
  data: unknown,
  ws: WebSocket,
  terminal: TerminalController | null,
) {
  const buffer = await binarySocketDataToArrayBuffer(data);
  if (!buffer) {
    ws.close(1003, "unsupported binary message container");
    return;
  }

  handleBinaryMessage(buffer, terminal);
}

function handleBinaryMessage(buffer: ArrayBuffer, terminal: TerminalController | null) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length === 0) {
    return;
  }

  switch (bytes[0]) {
    case BinaryMessageType.ttyOutput:
      terminal?.write(bytes.subarray(1));
      return;
    default:
      return;
  }
}

function readSessionId() {
  if (typeof window === "undefined") {
    return null;
  }

  const match = window.location.pathname.match(/^\/s\/([23456789abcdefghjkmnpqrstuvwxyz]{3}-[23456789abcdefghjkmnpqrstuvwxyz]{3})$/);
  return match?.[1] ?? null;
}

function PlatformButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-xl px-3 py-2 text-sm transition ${
        active
          ? "bg-white text-stone-950 shadow-sm"
          : "text-stone-400 hover:text-stone-200"
      }`}
    >
      {label}
    </button>
  );
}

function detectPlatformTab(): PlatformTab {
  if (typeof window === "undefined") {
    return "macos";
  }

  const platform = window.navigator.userAgent.toLowerCase();
  if (platform.includes("win")) {
    return "windows";
  }
  if (platform.includes("linux")) {
    return "linux";
  }
  return "macos";
}

function viewerSocketURL(sessionId: string) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${protocol}//${window.location.host}/api/session/${sessionId}/viewer`);
  const viewerToken = readViewerToken(sessionId);
  if (viewerToken) {
    url.searchParams.set("viewerToken", viewerToken);
  }
  return url.toString();
}

function sessionStatusURL(sessionId: string) {
  const url = new URL(`/api/session/${sessionId}`, window.location.origin);
  const viewerToken = readViewerToken(sessionId);
  if (viewerToken) {
    url.searchParams.set("viewerToken", viewerToken);
  }
  return url.toString();
}

function buildSessionInfo(sessionId: string | null): SessionInfo | null {
  if (!sessionId || typeof window === "undefined") {
    return null;
  }

  return normalizeSessionInfo({
    sessionId,
    viewerUrl: `/s/${sessionId}`,
    hostWebSocketUrl: `/api/session/${sessionId}/host`,
    viewerWebSocketUrl: `/api/session/${sessionId}/viewer`,
  });
}

function normalizeSessionInfo(info: SessionInfo): SessionInfo {
  if (typeof window === "undefined") {
    return info;
  }

  const viewerUrl = new URL(info.viewerUrl, window.location.origin).toString();
  const origin = new URL(viewerUrl).origin;
  const viewerProtocol = origin.startsWith("https:") ? "wss:" : "ws:";
  const hostProtocol = viewerProtocol;

  return {
    sessionId: info.sessionId,
    viewerUrl,
    hostWebSocketUrl: normalizeWebSocketURL(info.hostWebSocketUrl, hostProtocol),
    viewerWebSocketUrl: normalizeWebSocketURL(info.viewerWebSocketUrl, viewerProtocol),
  };
}

function normalizeWebSocketURL(value: string, protocol: string) {
  if (value.startsWith("ws://") || value.startsWith("wss://")) {
    return value;
  }

  if (typeof window === "undefined") {
    return value;
  }

  const resolved = new URL(value, window.location.origin);
  resolved.protocol = protocol;
  return resolved.toString();
}

function viewerTokenStorageKey(sessionId: string) {
  return `ttys.viewerToken.${sessionId}`;
}

function readViewerToken(sessionId: string) {
  if (typeof window === "undefined") {
    return null;
  }
  return window.sessionStorage.getItem(viewerTokenStorageKey(sessionId));
}

function storeViewerToken(sessionId: string, token: string | null) {
  if (!token || typeof window === "undefined") {
    return;
  }
  window.sessionStorage.setItem(viewerTokenStorageKey(sessionId), token);
}

function formatDeadline(timestamp: number | null, now: number) {
  if (!timestamp) {
    return null;
  }

  const remainingMs = timestamp - now;
  if (remainingMs <= 0) {
    return "Expired";
  }

  const remainingSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  const relative =
    minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s left` : `${seconds}s left`;

  return `${new Date(timestamp).toLocaleTimeString()} (${relative})`;
}

function transportLabel(value: string) {
  switch (value) {
    case "connected":
      return "Live";
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
    case "closed":
      return "Offline";
    case "error":
      return "Connection issue";
    default:
      return "Idle";
  }
}

function shouldRetrySessionStatus(response: Response) {
  return response.status === 429 || response.status >= 500;
}

function pickFlashPalette(): FlashPalette {
  const firstHue = Math.floor(Math.random() * 360);
  const firstSaturation = Math.floor(Math.random() * 101);
  const firstLightness = 35 + Math.floor(Math.random() * 41);
  const secondHue = Math.floor(Math.random() * 360);
  const secondSaturation = Math.floor(Math.random() * 101);
  const secondLightness = 35 + Math.floor(Math.random() * 41);

  return {
    first: `hsl(${firstHue} ${firstSaturation}% ${firstLightness}%)`,
    firstGlow: `hsl(${firstHue} ${firstSaturation}% ${firstLightness}% / 0.22)`,
    second: `hsl(${secondHue} ${secondSaturation}% ${secondLightness}%)`,
    secondGlow: `hsl(${secondHue} ${secondSaturation}% ${secondLightness}% / 0.18)`,
  };
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
