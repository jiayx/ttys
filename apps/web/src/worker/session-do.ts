import { DurableObject } from "cloudflare:workers";

type SessionState = "idle" | "ready" | "active" | "closed";
type SessionRole = "host" | "viewer";
type ViewerInfo = {
  id: string;
  socket: WebSocket;
};
type ControlRequest = {
  viewerId: string;
  leaseSeconds: number;
};

const DEFAULT_CONTROL_LEASE_SECONDS = 30 * 60;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const HOST_DISCONNECT_GRACE_MS = 60 * 1000;
const PENDING_REQUEST_TIMEOUT_MS = 30 * 1000;

export class TTYSession extends DurableObject {
  private host: WebSocket | null = null;
  private viewers = new Map<WebSocket, ViewerInfo>();
  private state: SessionState = "idle";
  private hostConnected = false;
  private buffer: string[] = [];
  private currentControllerId: string | null = null;
  private controlLeaseExpiresAt: number | null = null;
  private pendingRequest: ControlRequest | null = null;
  private pendingRequestExpiresAt: number | null = null;
  private createdAt = Date.now();
  private sessionExpiresAt = this.createdAt + SESSION_TTL_MS;
  private hostDisconnectDeadline: number | null = null;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/init" && request.method === "POST") {
      this.state = "ready";
      this.createdAt = Date.now();
      this.sessionExpiresAt = this.createdAt + SESSION_TTL_MS;
      await this.scheduleNextAlarm();
      return Response.json(this.snapshot());
    }

    if (url.pathname === "/status" && request.method === "GET") {
      this.advanceState();
      return Response.json(this.snapshot());
    }

    if (url.pathname === "/connect/host") {
      return this.acceptSocket("host");
    }

    if (url.pathname === "/connect/viewer") {
      return this.acceptSocket("viewer");
    }

    return new Response("Not Found", { status: 404 });
  }

  async alarm(): Promise<void> {
    this.advanceState();
    await this.scheduleNextAlarm();
  }

  private acceptSocket(role: SessionRole): Response {
    this.advanceState();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    server.accept();
    server.addEventListener("message", (event) => {
      void this.handleMessage(role, server, event.data);
    });
    server.addEventListener("close", () => {
      void this.handleClose(role, server);
    });

    if (role === "host") {
      this.host?.close(1012, "replaced by new host");
      this.host = server;
      this.hostConnected = true;
      this.hostDisconnectDeadline = null;
      this.state = "active";
    } else {
      this.viewers.set(server, {
        id: crypto.randomUUID().slice(0, 8),
        socket: server,
      });
    }

    server.send(
      JSON.stringify({
        type: "session.status",
        payload: this.snapshot(server, role),
      }),
    );
    if (role === "viewer" && this.buffer.length > 0) {
      server.send(
        JSON.stringify({
          type: "session.backfill",
          payload: {
            chunks: this.buffer,
          },
        }),
      );
    }
    this.broadcastStatus();
    void this.scheduleNextAlarm();

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private async handleMessage(
    role: SessionRole,
    socket: WebSocket,
    data: string | ArrayBuffer,
  ) {
    this.advanceState();

    if (role === "host") {
      if (typeof data === "string") {
        const frame = parseEnvelope(data);
        if (frame?.type === "control.approve") {
          this.handleControlApprove(frame.payload);
          await this.scheduleNextAlarm();
          return;
        }
        if (frame?.type === "control.reject") {
          this.handleControlReject(frame.payload);
          await this.scheduleNextAlarm();
          return;
        }
        if (frame?.type === "control.revoke") {
          this.handleControlRevoke();
          await this.scheduleNextAlarm();
          return;
        }
        this.pushBuffer(data);
      }

      for (const viewer of this.viewers.values()) {
        viewer.socket.send(data);
      }
      return;
    }

    const frame = typeof data === "string" ? parseEnvelope(data) : null;
    if (frame?.type === "control.request") {
      this.handleControlRequest(socket, frame.payload);
      await this.scheduleNextAlarm();
      return;
    }

    if ((frame?.type === "stdin" || frame?.type === "resize") && this.canWrite(socket)) {
      this.host?.send(data);
    }
  }

  private async handleClose(role: SessionRole, socket: WebSocket) {
    if (role === "host" && this.host === socket) {
      this.host = null;
      this.hostConnected = false;
      this.hostDisconnectDeadline = Date.now() + HOST_DISCONNECT_GRACE_MS;
      this.currentControllerId = null;
      this.controlLeaseExpiresAt = null;
      this.pendingRequest = null;
      this.pendingRequestExpiresAt = null;
      this.state = "ready";
      this.broadcastStatus();
      await this.scheduleNextAlarm();
      return;
    }

    const viewer = this.viewers.get(socket);
    if (viewer?.id === this.currentControllerId) {
      this.currentControllerId = null;
      this.controlLeaseExpiresAt = null;
    }
    if (viewer?.id === this.pendingRequest?.viewerId) {
      this.pendingRequest = null;
      this.pendingRequestExpiresAt = null;
    }
    this.viewers.delete(socket);
    this.broadcastStatus();
    await this.scheduleNextAlarm();
  }

  private handleControlRequest(socket: WebSocket, payload: unknown) {
    this.advanceState();
    const viewer = this.viewers.get(socket);
    if (!viewer || !this.hostConnected || this.currentControllerId || this.pendingRequest) {
      return;
    }

    this.pendingRequest = {
      viewerId: viewer.id,
      leaseSeconds: normalizeLeaseSeconds(payload),
    };
    this.pendingRequestExpiresAt = Date.now() + PENDING_REQUEST_TIMEOUT_MS;

    this.host?.send(
      JSON.stringify({
        type: "control.request",
        payload: this.pendingRequest,
      }),
    );
    this.broadcastStatus();
  }

  private handleControlApprove(payload: unknown) {
    if (!this.pendingRequest) {
      return;
    }

    const approved = payload as { viewerId?: string };
    if (approved.viewerId !== this.pendingRequest.viewerId) {
      return;
    }

    this.currentControllerId = this.pendingRequest.viewerId;
    this.controlLeaseExpiresAt =
      Date.now() + normalizeLeaseSeconds(payload, this.pendingRequest.leaseSeconds) * 1000;
    this.pendingRequest = null;
    this.pendingRequestExpiresAt = null;
    this.broadcastStatus();
  }

  private handleControlReject(payload: unknown) {
    if (!this.pendingRequest) {
      return;
    }

    const rejected = payload as { viewerId?: string };
    if (rejected.viewerId !== this.pendingRequest.viewerId) {
      return;
    }

    this.pendingRequest = null;
    this.pendingRequestExpiresAt = null;
    this.broadcastStatus();
  }

  private handleControlRevoke() {
    if (!this.currentControllerId) {
      return;
    }

    this.currentControllerId = null;
    this.controlLeaseExpiresAt = null;
    this.broadcastStatus();
  }

  private canWrite(socket: WebSocket) {
    this.advanceState();
    const viewer = this.viewers.get(socket);
    return viewer?.id === this.currentControllerId;
  }

  private pushBuffer(chunk: string) {
    this.buffer.push(chunk);
    if (this.buffer.length > 64) {
      this.buffer.shift();
    }
  }

  private snapshot(socket?: WebSocket, role?: SessionRole) {
    this.advanceState();
    const viewer = socket ? this.viewers.get(socket) : null;
    const pendingControlRequest =
      role === "host"
        ? this.pendingRequest
        : viewer?.id && this.pendingRequest?.viewerId === viewer.id
          ? this.pendingRequest
          : null;
    return {
      role: role ?? null,
      state: this.state,
      hostConnected: this.hostConnected,
      viewerCount: this.viewers.size,
      viewerId: viewer?.id ?? null,
      canWrite: viewer ? this.canWrite(socket!) : false,
      controllerViewerId: this.currentControllerId,
      controlLeaseExpiresAt: this.controlLeaseExpiresAt,
      pendingControlRequest,
      hasPendingControlRequest: this.pendingRequest !== null,
      sessionExpiresAt: this.sessionExpiresAt,
      hostDisconnectDeadline: this.hostDisconnectDeadline,
      pendingRequestExpiresAt: this.pendingRequestExpiresAt,
    };
  }

  private broadcastStatus() {
    this.advanceState();
    if (this.host) {
      this.host.send(
        JSON.stringify({
          type: "session.status",
          payload: this.snapshot(this.host, "host"),
        }),
      );
    }

    for (const viewer of this.viewers.values()) {
      viewer.socket.send(
        JSON.stringify({
          type: "session.status",
          payload: this.snapshot(viewer.socket, "viewer"),
        }),
      );
    }
  }

  private advanceState() {
    const now = Date.now();

    if (this.sessionExpiresAt && now >= this.sessionExpiresAt) {
      this.closeSession("session expired");
      return;
    }

    if (this.pendingRequestExpiresAt && now >= this.pendingRequestExpiresAt) {
      this.pendingRequest = null;
      this.pendingRequestExpiresAt = null;
    }

    if (this.controlLeaseExpiresAt && now >= this.controlLeaseExpiresAt) {
      this.currentControllerId = null;
      this.controlLeaseExpiresAt = null;
    }

    if (
      !this.hostConnected &&
      this.hostDisconnectDeadline &&
      now >= this.hostDisconnectDeadline
    ) {
      this.closeSession("host disconnected");
      return;
    }

    if (this.state !== "closed") {
      if (this.hostConnected) {
        this.state = "active";
      } else if (this.state !== "idle") {
        this.state = "ready";
      }
    }
  }

  private closeSession(reason: string) {
    if (this.state === "closed") {
      return;
    }

    this.state = "closed";
    this.hostConnected = false;
    this.hostDisconnectDeadline = null;
    this.pendingRequest = null;
    this.pendingRequestExpiresAt = null;
    this.currentControllerId = null;
    this.controlLeaseExpiresAt = null;

    if (this.host) {
      this.host.close(1000, reason);
      this.host = null;
    }
    for (const viewer of this.viewers.values()) {
      viewer.socket.close(1000, reason);
    }
    this.viewers.clear();
  }

  private async scheduleNextAlarm() {
    const deadlines = [
      this.sessionExpiresAt,
      this.hostDisconnectDeadline,
      this.pendingRequestExpiresAt,
      this.controlLeaseExpiresAt,
    ].filter((value): value is number => typeof value === "number" && value > Date.now());

    if (deadlines.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    await this.ctx.storage.setAlarm(Math.min(...deadlines));
  }
}

function parseEnvelope(value: string): { type?: string; payload?: unknown } | null {
  try {
    return JSON.parse(value) as { type?: string; payload?: unknown };
  } catch {
    return null;
  }
}

function normalizeLeaseSeconds(payload: unknown, fallback = DEFAULT_CONTROL_LEASE_SECONDS) {
  const value = (payload as { leaseSeconds?: unknown })?.leaseSeconds;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(60, Math.min(Math.trunc(value), DEFAULT_CONTROL_LEASE_SECONDS));
}
