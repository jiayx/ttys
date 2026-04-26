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
  token: string;
  socket: WebSocket;
};
type ControlRequest = {
  viewerId: string;
  leaseSeconds: number;
};
type SessionRecord = {
  state: SessionState;
  currentControllerId: string | null;
  controlLeaseExpiresAt: number | null;
  pendingRequest: ControlRequest | null;
  pendingRequestExpiresAt: number | null;
  viewerIdentities: Record<string, string>;
  createdAt: number;
  maxExpiresAt: number;
  sessionExpiresAt: number;
  hostDisconnectDeadline: number | null;
};
type SocketAttachment =
  | {
      role: "host";
    }
  | {
      role: "viewer";
      viewerId: string;
      viewerToken: string;
    };
type Env = Record<string, unknown>;

const DEFAULT_CONTROL_LEASE_SECONDS = 30 * 60;
const SESSION_IDLE_TTL_MS = 2 * 60 * 60 * 1000;
const SESSION_MAX_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_RENEW_THRESHOLD_MS = 30 * 60 * 1000;
const HOST_DISCONNECT_GRACE_MS = 60 * 1000;
const PENDING_REQUEST_TIMEOUT_MS = 30 * 1000;
const REPLAY_BUFFER_MAX_BYTES = 2 * 1024 * 1024;
const SESSION_RECORD_KEY = "session";

function createInitialSessionRecord(state: SessionState = "idle"): SessionRecord {
  const createdAt = Date.now();
  return {
    state,
    currentControllerId: null,
    controlLeaseExpiresAt: null,
    pendingRequest: null,
    pendingRequestExpiresAt: null,
    viewerIdentities: {},
    createdAt,
    maxExpiresAt: createdAt + SESSION_MAX_TTL_MS,
    sessionExpiresAt: Math.min(createdAt + SESSION_IDLE_TTL_MS, createdAt + SESSION_MAX_TTL_MS),
    hostDisconnectDeadline: null,
  };
}

export class TTYSession extends DurableObject {
  private host: WebSocket | null = null;
  private viewers = new Map<WebSocket, ViewerInfo>();
  private hostConnected = false;
  private buffer: ArrayBuffer[] = [];
  private bufferBytes = 0;
  private record: SessionRecord = createInitialSessionRecord();
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      await this.restoreSessionRecord();
      if (this.restoreSockets()) {
        await this.persistRecord();
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/init" && request.method === "POST") {
      if (this.record.state !== "idle" && this.record.state !== "closed") {
        return new Response("session id already exists", { status: 409 });
      }
      this.record = createInitialSessionRecord("ready");
      await this.persistRecord();
      await this.scheduleNextAlarm();
      return Response.json(this.snapshot());
    }

    if (url.pathname === "/status" && request.method === "GET") {
      await this.advanceRecordAndPersist();
      return Response.json(this.snapshotForViewerToken(url.searchParams.get("viewerToken")));
    }

    if (url.pathname === "/connect/host") {
      return this.acceptSocket("host", request);
    }

    if (url.pathname === "/connect/viewer") {
      return this.acceptSocket("viewer", request);
    }

    return new Response("Not Found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const changed = await this.advanceRecordAndPersist();
    if (changed) {
      this.broadcastStatus();
    }
    await this.scheduleNextAlarm();
  }

  private async acceptSocket(role: SessionRole, request: Request): Promise<Response> {
    await this.advanceRecordAndPersist();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    await this.touchSession();

    if (role === "host") {
      this.host?.close(1012, "replaced by new host");
      server.serializeAttachment({ role });
      this.ctx.acceptWebSocket(server, [role]);
      this.host = server;
      this.hostConnected = true;
      await this.updateRecord((record) => {
        record.hostDisconnectDeadline = null;
        record.state = "active";
      });
    } else {
      const viewerIdentity = await this.resolveViewerIdentity(request);
      server.serializeAttachment({
        role,
        viewerId: viewerIdentity.id,
        viewerToken: viewerIdentity.token,
      });
      this.ctx.acceptWebSocket(server, [role]);
      this.viewers.set(server, {
        id: viewerIdentity.id,
        token: viewerIdentity.token,
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
        continue;
      }

      this.viewers.set(socket, {
        id: attachment.viewerId,
        token: attachment.viewerToken,
        socket,
      });
    }

    return this.reconcileRecordWithSockets();
  }

  private reconcileRecordWithSockets() {
    if (this.hostConnected) {
      const changed =
        this.record.hostDisconnectDeadline !== null || this.record.state !== "active";
      this.record.hostDisconnectDeadline = null;
      this.record.state = "active";
      return changed;
    }

    if (this.viewers.size > 0 && this.record.state === "idle") {
      this.record.state = "ready";
      return true;
    }

    if (this.record.state === "active") {
      this.record.state = "ready";
      return true;
    }

    return false;
  }

  private async restoreSessionRecord() {
    const record = await this.ctx.storage.get<SessionRecord>(SESSION_RECORD_KEY);
    if (!record) {
      return;
    }

    this.record = {
      ...record,
      viewerIdentities: record.viewerIdentities ?? {},
    };
  }

  private async resolveViewerIdentity(request: Request) {
    const token = validViewerToken(new URL(request.url).searchParams.get("viewerToken"));
    if (token) {
      const existingViewerId = this.record.viewerIdentities[token];
      if (existingViewerId) {
        return { id: existingViewerId, token };
      }
    }

    const viewerToken = randomViewerToken();
    const viewerId = crypto.randomUUID().slice(0, 8);
    await this.updateRecord((record) => {
      record.viewerIdentities[viewerToken] = viewerId;
    });
    return { id: viewerId, token: viewerToken };
  }

  private async persistRecord() {
    const record = { ...this.record };
    const write = this.persistQueue.then(() => this.ctx.storage.put(SESSION_RECORD_KEY, record));
    this.persistQueue = write.catch(() => {});
    await write;
  }

  private async updateRecord(mutator: (record: SessionRecord) => void) {
    mutator(this.record);
    await this.persistRecord();
    await this.scheduleNextAlarm();
  }

  private async handleMessage(
    role: SessionRole,
    socket: WebSocket,
    data: unknown,
  ) {
    const advanced = await this.advanceRecordAndPersist();
    if (advanced) {
      this.broadcastStatus();
    }

    if (role === "host") {
      if (typeof data === "string") {
        const frame = parseEnvelope(data);
        if (frame?.type === "control.approve") {
          await this.handleControlApprove(frame.payload);
          await this.touchSession();
          return;
        }
        if (frame?.type === "control.reject") {
          await this.handleControlReject(frame.payload);
          await this.touchSession();
          return;
        }
        if (frame?.type === "control.revoke") {
          await this.handleControlRevoke();
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
      await this.handleControlRequest(socket, frame.payload);
      await this.touchSession();
      return;
    }
  }

  private async handleClose(role: SessionRole, socket: WebSocket) {
    if (role === "host") {
      if (this.host !== socket) {
        return;
      }

      await this.clearHost();
      await this.scheduleNextAlarm();
      return;
    }

    await this.removeViewer(socket);
    this.broadcastStatus();
    await this.scheduleNextAlarm();
  }

  private async clearHost() {
    this.host = null;
    this.hostConnected = false;
    await this.updateRecord((record) => {
      record.hostDisconnectDeadline = Date.now() + HOST_DISCONNECT_GRACE_MS;
      record.state = "ready";
    });
    this.broadcastStatus();
  }

  private async handleControlRequest(socket: WebSocket, payload: unknown) {
    await this.advanceRecordAndPersist();
    const viewer = this.viewers.get(socket);
    if (
      !viewer ||
      !this.hostConnected ||
      this.record.currentControllerId ||
      this.record.pendingRequest
    ) {
      return;
    }

    await this.updateRecord((record) => {
      record.pendingRequest = {
        viewerId: viewer.id,
        leaseSeconds: normalizeLeaseSeconds(payload),
      };
      record.pendingRequestExpiresAt = Date.now() + PENDING_REQUEST_TIMEOUT_MS;
    });

    this.sendHost(
      JSON.stringify({
        type: "control.request",
        payload: this.record.pendingRequest,
      }),
    );
    this.broadcastStatus();
  }

  private async handleControlApprove(payload: unknown) {
    if (!this.record.pendingRequest) {
      return;
    }

    const approved = payload as { viewerId?: string };
    if (approved.viewerId !== this.record.pendingRequest.viewerId) {
      return;
    }

    await this.updateRecord((record) => {
      record.currentControllerId = record.pendingRequest!.viewerId;
      record.controlLeaseExpiresAt =
        Date.now() + normalizeLeaseSeconds(payload, record.pendingRequest!.leaseSeconds) * 1000;
      record.pendingRequest = null;
      record.pendingRequestExpiresAt = null;
    });
    this.broadcastStatus();
  }

  private async handleControlReject(payload: unknown) {
    if (!this.record.pendingRequest) {
      return;
    }

    const rejected = payload as { viewerId?: string };
    if (rejected.viewerId !== this.record.pendingRequest.viewerId) {
      return;
    }

    await this.updateRecord((record) => {
      record.pendingRequest = null;
      record.pendingRequestExpiresAt = null;
    });
    this.broadcastStatus();
  }

  private async handleControlRevoke() {
    if (!this.record.currentControllerId) {
      return;
    }

    await this.updateRecord((record) => {
      record.currentControllerId = null;
      record.controlLeaseExpiresAt = null;
    });
    this.broadcastStatus();
  }

  private canWrite(socket: WebSocket) {
    const viewer = this.viewers.get(socket);
    return viewer?.id === this.record.currentControllerId;
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
    const viewer = socket ? this.viewers.get(socket) : null;
    return this.snapshotForViewer(viewer ?? null, role ?? null);
  }

  private snapshotForViewerToken(viewerToken: string | null) {
    const token = validViewerToken(viewerToken);
    const viewerId = token ? this.record.viewerIdentities[token] : null;
    const viewer = token && viewerId ? { id: viewerId, token } : null;
    return this.snapshotForViewer(viewer, viewer ? "viewer" : null);
  }

  private snapshotForViewer(
    viewer: Pick<ViewerInfo, "id" | "token"> | null,
    role: SessionRole | null,
  ) {
    let pendingControlRequest: ControlRequest | null = null;
    if (role === "host") {
      pendingControlRequest = this.record.pendingRequest;
    } else if (viewer?.id && this.record.pendingRequest?.viewerId === viewer.id) {
      pendingControlRequest = this.record.pendingRequest;
    }

    return {
      role: role ?? null,
      state: this.record.state,
      hostState: this.hostState(),
      hostConnected: this.hostConnected,
      viewerCount: this.viewers.size,
      viewerId: viewer?.id ?? null,
      viewerToken: viewer?.token ?? null,
      canWrite: viewer?.id === this.record.currentControllerId,
      controllerViewerId: this.record.currentControllerId,
      controlLeaseExpiresAt: this.record.controlLeaseExpiresAt,
      pendingControlRequest,
      hasPendingControlRequest: this.record.pendingRequest !== null,
      sessionExpiresAt: this.record.sessionExpiresAt,
      hostDisconnectDeadline: this.record.hostDisconnectDeadline,
      pendingRequestExpiresAt: this.record.pendingRequestExpiresAt,
    };
  }

  private hostState(): HostState {
    if (this.record.state === "closed") {
      return "offline";
    }
    if (this.hostConnected) {
      return "online";
    }
    if (this.record.hostDisconnectDeadline) {
      return "reconnecting";
    }
    return "waiting";
  }

  private broadcastStatus() {
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

    void this.clearHost();
    return false;
  }

  private sendViewer(viewer: ViewerInfo, message: string | ArrayBuffer) {
    if (this.sendSocket(viewer.socket, message)) {
      return true;
    }

    void this.removeViewer(viewer.socket);
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

  private async removeViewer(socket: WebSocket) {
    const viewer = this.viewers.get(socket);
    this.viewers.delete(socket);

    if (viewer?.id !== this.record.pendingRequest?.viewerId) {
      return;
    }

    await this.updateRecord((record) => {
      if (viewer?.id === record.pendingRequest?.viewerId) {
        record.pendingRequest = null;
        record.pendingRequestExpiresAt = null;
      }
    });
  }

  private advanceRecord() {
    const now = Date.now();
    let changed = false;

    if (this.record.sessionExpiresAt && now >= this.record.sessionExpiresAt) {
      this.closeSession("session expired");
      return true;
    }

    if (this.record.pendingRequestExpiresAt && now >= this.record.pendingRequestExpiresAt) {
      this.record.pendingRequest = null;
      this.record.pendingRequestExpiresAt = null;
      changed = true;
    }

    if (this.record.controlLeaseExpiresAt && now >= this.record.controlLeaseExpiresAt) {
      this.record.currentControllerId = null;
      this.record.controlLeaseExpiresAt = null;
      changed = true;
    }

    if (
      !this.hostConnected &&
      this.record.hostDisconnectDeadline &&
      now >= this.record.hostDisconnectDeadline
    ) {
      this.closeSession("host disconnected");
      return true;
    }

    if (this.record.state !== "closed") {
      if (this.hostConnected) {
        if (this.record.state !== "active") {
          this.record.state = "active";
          changed = true;
        }
      } else if (this.record.state !== "idle") {
        if (this.record.state !== "ready") {
          this.record.state = "ready";
          changed = true;
        }
      }
    }

    return changed;
  }

  private async advanceRecordAndPersist() {
    const changed = this.advanceRecord();
    if (changed) {
      await this.persistRecord();
    }
    return changed;
  }

  private closeSession(reason: string) {
    if (this.record.state === "closed") {
      return;
    }

    this.hostConnected = false;
    this.record.state = "closed";
    this.record.hostDisconnectDeadline = null;
    this.record.pendingRequest = null;
    this.record.pendingRequestExpiresAt = null;
    this.record.currentControllerId = null;
    this.record.controlLeaseExpiresAt = null;

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
    if (this.record.state === "closed") return;

    const now = Date.now();
    const remaining = this.record.sessionExpiresAt - now;
    if (remaining > SESSION_RENEW_THRESHOLD_MS) return;

    const nextExpiresAt = Math.min(now + SESSION_IDLE_TTL_MS, this.record.maxExpiresAt);
    if (nextExpiresAt <= this.record.sessionExpiresAt) return;

    await this.updateRecord((record) => {
      record.sessionExpiresAt = nextExpiresAt;
    });
    await this.scheduleNextAlarm();
  }

  private async scheduleNextAlarm() {
    const deadlines = [
      this.record.sessionExpiresAt,
      this.record.hostDisconnectDeadline,
      this.record.pendingRequestExpiresAt,
      this.record.controlLeaseExpiresAt,
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

function randomViewerToken() {
  return crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
}

function validViewerToken(value: string | null) {
  if (!value || !/^[0-9a-f]{64}$/.test(value)) {
    return null;
  }
  return value;
}
