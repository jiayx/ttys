import { DurableObject } from "cloudflare:workers";
import {
  BinaryMessageType,
  binaryMessageType,
  binarySocketDataToArrayBuffer,
} from "../protocol";

type SessionState = "idle" | "ready" | "active" | "closed";
type SessionRole = "host" | "viewer";
type HostState = "waiting" | "online" | "reconnecting" | "offline";
type ViewerInfo = {
  id: string;
  socket: WebSocket;
};
type ControlRequest = {
  viewerId: string;
  leaseSeconds: number;
};
type SocketAttachment =
  | {
      role: "host";
    }
  | {
      role: "viewer";
      viewerId: string;
    };
type Env = Record<string, unknown>;

const DEFAULT_CONTROL_LEASE_SECONDS = 30 * 60;
const SESSION_IDLE_TTL_MS = 2 * 60 * 60 * 1000;
const SESSION_MAX_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_RENEW_THRESHOLD_MS = 30 * 60 * 1000;
const HOST_DISCONNECT_GRACE_MS = 60 * 1000;
const PENDING_REQUEST_TIMEOUT_MS = 30 * 1000;
const REPLAY_BUFFER_MAX_BYTES = 2 * 1024 * 1024;

export class TTYSession extends DurableObject {
  private host: WebSocket | null = null;
  private viewers = new Map<WebSocket, ViewerInfo>();
  private state: SessionState = "idle";
  private hostConnected = false;
  private buffer: ArrayBuffer[] = [];
  private bufferBytes = 0;
  private currentControllerId: string | null = null;
  private controlLeaseExpiresAt: number | null = null;
  private pendingRequest: ControlRequest | null = null;
  private pendingRequestExpiresAt: number | null = null;
  private createdAt = Date.now();
  private maxExpiresAt = this.createdAt + SESSION_MAX_TTL_MS;
  private sessionExpiresAt = this.createdAt + SESSION_IDLE_TTL_MS;
  private hostDisconnectDeadline: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.restoreSockets();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/init" && request.method === "POST") {
      if (this.state !== "idle" && this.state !== "closed") {
        return new Response("session id already exists", { status: 409 });
      }
      this.state = "ready";
      this.createdAt = Date.now();
      this.maxExpiresAt = this.createdAt + SESSION_MAX_TTL_MS;
      this.sessionExpiresAt = Math.min(this.createdAt + SESSION_IDLE_TTL_MS, this.maxExpiresAt);
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
    void this.touchSession();

    if (role === "host") {
      this.host?.close(1012, "replaced by new host");
      server.serializeAttachment({ role });
      this.ctx.acceptWebSocket(server, [role]);
      this.host = server;
      this.hostConnected = true;
      this.hostDisconnectDeadline = null;
      this.state = "active";
    } else {
      const viewerId = crypto.randomUUID().slice(0, 8);
      server.serializeAttachment({ role, viewerId });
      this.ctx.acceptWebSocket(server, [role]);
      this.viewers.set(server, {
        id: viewerId,
        socket: server,
      });
    }

    this.sendSocket(
      server,
      JSON.stringify({
        type: "session.status",
        payload: this.snapshot(server, role),
      }),
    );
    if (role === "viewer" && this.buffer.length > 0) {
      for (const chunk of this.buffer) {
        if (!this.sendSocket(server, chunk)) {
          break;
        }
      }
    }
    this.broadcastStatus();
    void this.scheduleNextAlarm();

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(socket: WebSocket, data: string | ArrayBuffer) {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (!attachment) {
      socket.close(1003, "missing socket attachment");
      return;
    }

    await this.handleMessage(attachment.role, socket, data);
  }

  async webSocketClose(socket: WebSocket) {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (!attachment) {
      return;
    }

    await this.handleClose(attachment.role, socket);
  }

  async webSocketError(socket: WebSocket) {
    await this.webSocketClose(socket);
  }

  private restoreSockets() {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (!attachment) {
        socket.close(1003, "missing socket attachment");
        continue;
      }

      if (attachment.role === "host") {
        if (this.host && this.host !== socket) {
          socket.close(1012, "replaced by newer host");
          continue;
        }
        this.host = socket;
        this.hostConnected = true;
        this.hostDisconnectDeadline = null;
        this.state = "active";
        continue;
      }

      this.viewers.set(socket, {
        id: attachment.viewerId,
        socket,
      });
    }

    if (!this.hostConnected && this.viewers.size > 0 && this.state === "idle") {
      this.state = "ready";
    }
  }

  private async handleMessage(
    role: SessionRole,
    socket: WebSocket,
    data: unknown,
  ) {
    this.advanceState();

    if (role === "host") {
      if (typeof data === "string") {
        const frame = parseEnvelope(data);
        if (frame?.type === "control.approve") {
          this.handleControlApprove(frame.payload);
          await this.touchSession();
          return;
        }
        if (frame?.type === "control.reject") {
          this.handleControlReject(frame.payload);
          await this.touchSession();
          return;
        }
        if (frame?.type === "control.revoke") {
          this.handleControlRevoke();
          await this.touchSession();
          return;
        }
        return;
      }

      const buffer = await binarySocketDataToArrayBuffer(data);
      if (!buffer) {
        socket.close(1003, "unsupported binary message container");
        return;
      }

      if (binaryMessageType(buffer) !== BinaryMessageType.ttyOutput) {
        socket.close(1003, "invalid host binary message");
        return;
      }

      void this.touchSession();
      this.pushBuffer(buffer);

      for (const viewer of this.viewers.values()) {
        this.sendViewer(viewer, buffer);
      }
      return;
    }

    if (typeof data !== "string") {
      const buffer = await binarySocketDataToArrayBuffer(data);
      if (!buffer) {
        socket.close(1003, "unsupported binary message container");
        return;
      }

      if (binaryMessageType(buffer) !== BinaryMessageType.stdin) {
        socket.close(1003, "invalid viewer binary message");
        return;
      }

      if (this.canWrite(socket)) {
        void this.touchSession();
        this.sendHost(buffer);
      }
      return;
    }

    const frame = parseEnvelope(data);
    if (frame?.type === "control.request") {
      this.handleControlRequest(socket, frame.payload);
      await this.touchSession();
      return;
    }
  }

  private async handleClose(role: SessionRole, socket: WebSocket) {
    if (role === "host") {
      if (this.host !== socket) {
        return;
      }

      this.clearHost();
      await this.scheduleNextAlarm();
      return;
    }

    this.removeViewer(socket);
    this.broadcastStatus();
    await this.scheduleNextAlarm();
  }

  private clearHost() {
    this.host = null;
    this.hostConnected = false;
    this.hostDisconnectDeadline = Date.now() + HOST_DISCONNECT_GRACE_MS;
    this.currentControllerId = null;
    this.controlLeaseExpiresAt = null;
    this.pendingRequest = null;
    this.pendingRequestExpiresAt = null;
    this.state = "ready";
    this.broadcastStatus();
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

    this.sendHost(
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

  private pushBuffer(chunk: ArrayBuffer) {
    const copy = chunk.slice(0);
    this.buffer.push(copy);
    this.bufferBytes += copy.byteLength;

    while (this.bufferBytes > REPLAY_BUFFER_MAX_BYTES && this.buffer.length > 0) {
      const removed = this.buffer.shift();
      this.bufferBytes -= removed?.byteLength ?? 0;
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
      hostState: this.hostState(),
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

  private hostState(): HostState {
    if (this.state === "closed") {
      return "offline";
    }
    if (this.hostConnected) {
      return "online";
    }
    if (this.hostDisconnectDeadline) {
      return "reconnecting";
    }
    return "waiting";
  }

  private broadcastStatus() {
    this.advanceState();
    if (this.host) {
      this.sendHost(
        JSON.stringify({
          type: "session.status",
          payload: this.snapshot(this.host, "host"),
        }),
      );
    }

    for (const viewer of this.viewers.values()) {
      this.sendViewer(
        viewer,
        JSON.stringify({
          type: "session.status",
          payload: this.snapshot(viewer.socket, "viewer"),
        }),
      );
    }
  }

  private sendHost(message: string | ArrayBuffer) {
    if (!this.host) {
      return false;
    }

    if (this.sendSocket(this.host, message)) {
      return true;
    }

    this.clearHost();
    return false;
  }

  private sendViewer(viewer: ViewerInfo, message: string | ArrayBuffer) {
    if (this.sendSocket(viewer.socket, message)) {
      return true;
    }

    this.removeViewer(viewer.socket);
    return false;
  }

  private sendSocket(socket: WebSocket, message: string | ArrayBuffer) {
    if (socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      socket.send(message);
      return true;
    } catch {
      return false;
    }
  }

  private removeViewer(socket: WebSocket) {
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

  private async touchSession() {
    if (this.state === "closed") return;

    const now = Date.now();
    const remaining = this.sessionExpiresAt - now;
    if (remaining > SESSION_RENEW_THRESHOLD_MS) return;

    const nextExpiresAt = Math.min(now + SESSION_IDLE_TTL_MS, this.maxExpiresAt);
    if (nextExpiresAt <= this.sessionExpiresAt) return;

    this.sessionExpiresAt = nextExpiresAt;
    await this.scheduleNextAlarm();
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
