const std = @import("std");
const builtin = @import("builtin");
const platform = @import("platform.zig");
const pty_mod = @import("pty.zig");
const sync = @import("sync.zig");
const terminal_mod = @import("terminal.zig");
const transport_mod = @import("transport.zig");

const posix_c = if (builtin.os.tag == .windows) struct {} else @cImport({
    @cInclude("errno.h");
    @cInclude("poll.h");
    @cInclude("time.h");
    @cInclude("unistd.h");
});

const win_c = if (builtin.os.tag == .windows) @cImport({
    @cDefine("_WIN32_WINNT", "0x0A00");
    @cInclude("windows.h");
}) else struct {};

const Allocator = std.mem.Allocator;
const ByteList = std.array_list.Managed(u8);
const PTY = pty_mod.PTY;
const RawTerminal = terminal_mod.RawTerminal;
const TerminalSize = terminal_mod.TerminalSize;
const getTerminalSize = terminal_mod.getTerminalSize;
const WebSocketClient = transport_mod.WebSocketClient;
const Mutex = sync.Mutex;
const nested_agent_env = "TTYS_AGENT_ACTIVE";
const remote_output_flush_ns = 1 * std.time.ns_per_ms;
const remote_output_max_batch = 16 * 1024;

const Config = struct {
    server_url: []const u8 = "http://localhost:5173",
    session_id: ?[]const u8 = null,
    shell: ?[]const u8 = null,
};

const ConnectInfo = struct {
    viewer_url: []const u8,
    host_websocket_url: []const u8,
};

const CreateSessionResponse = struct {
    sessionId: []const u8 = "",
    viewerUrl: []const u8,
    hostWebSocketUrl: []const u8,
};

const Envelope = struct {
    type: []const u8,
    payload: std.json.Value,
};

const ControlRequestPayload = struct {
    viewerId: []const u8,
    leaseSeconds: i32,
};

const SessionStatusPayload = struct {
    pendingControlRequest: ?ControlRequestPayload = null,
};

const ModalAction = enum {
    approve,
    reject,
};

const ModalDecision = struct {
    action: ModalAction,
    viewer_id: []u8,
    lease_seconds: i32,
};

const StdinRead = union(enum) {
    data: usize,
    would_block,
    eof,
};

const RunState = struct {
    allocator: Allocator,
    done: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),
    result: Mutex = .{},
    completed: bool = false,
    err: ?[]u8 = null,

    fn finishOk(self: *RunState) void {
        self.finish(null);
    }

    fn finishErrFmt(self: *RunState, comptime fmt: []const u8, args: anytype) void {
        const message = std.fmt.allocPrint(self.allocator, fmt, args) catch return self.finishStatic("out of memory");
        self.finish(message);
    }

    fn finishStatic(self: *RunState, message: []const u8) void {
        const owned = self.allocator.dupe(u8, message) catch return;
        self.finish(owned);
    }

    fn finish(self: *RunState, err: ?[]u8) void {
        if (self.done.swap(true, .seq_cst)) {
            if (err) |owned| self.allocator.free(owned);
            return;
        }

        self.result.lock();
        defer self.result.unlock();
        self.completed = true;
        self.err = err;
    }

    fn wait(self: *RunState) ?[]u8 {
        while (!self.done.load(.seq_cst)) {
            sleepMillis(10);
        }
        self.result.lock();
        defer self.result.unlock();
        return self.err;
    }

    fn isDone(self: *RunState) bool {
        return self.done.load(.seq_cst);
    }
};

const WebSocketSlot = struct {
    lock: Mutex = .{},
    client: ?*WebSocketClient = null,

    fn setConnected(self: *WebSocketSlot, client: *WebSocketClient) void {
        self.lock.lock();
        defer self.lock.unlock();
        self.client = client;
    }

    fn setDisconnected(self: *WebSocketSlot, client: *WebSocketClient) void {
        self.lock.lock();
        defer self.lock.unlock();
        if (self.client == client) {
            self.client = null;
        }
    }

    fn closeCurrent(self: *WebSocketSlot) void {
        self.lock.lock();
        const client = self.client;
        self.client = null;
        self.lock.unlock();

        if (client) |value| {
            value.close();
        }
    }

    fn writeBinaryMessage(self: *WebSocketSlot, kind: transport_mod.BinaryType, bytes: []const u8) !void {
        self.lock.lock();
        defer self.lock.unlock();
        const client = self.client orelse return error.WebSocketDisconnected;
        try client.writeBinaryMessage(kind, bytes);
    }

    fn writeJSON(self: *WebSocketSlot, text: []const u8) !void {
        self.lock.lock();
        defer self.lock.unlock();
        const client = self.client orelse return error.WebSocketDisconnected;
        try client.writeJSON(text);
    }
};

const SharedOutput = struct {
    stdout_lock: Mutex = .{},
    remote_lock: Mutex = .{},
    websocket: *WebSocketSlot,
    pending_remote: [remote_output_max_batch]u8 = undefined,
    pending_remote_len: usize = 0,
    last_remote_send_ns: i128 = 0,

    fn forward(self: *SharedOutput, bytes: []const u8) !void {
        if (bytes.len == 0) return;

        {
            self.stdout_lock.lock();
            defer self.stdout_lock.unlock();
            try writeStdoutAll(bytes);
        }

        self.forwardRemote(bytes);
    }

    fn beep(self: *SharedOutput) !void {
        self.stdout_lock.lock();
        defer self.stdout_lock.unlock();
        try writeStdoutAll("\x07");
    }

    fn writeDirect(self: *SharedOutput, text: []const u8) !void {
        self.stdout_lock.lock();
        defer self.stdout_lock.unlock();
        try writeStdoutAll(text);
    }

    fn forwardRemote(self: *SharedOutput, bytes: []const u8) void {
        self.remote_lock.lock();
        defer self.remote_lock.unlock();

        const now = monotonicNanoTimestamp();
        if (self.pending_remote_len == 0 and shouldSendImmediately(self.last_remote_send_ns, now)) {
            self.last_remote_send_ns = now;
            self.websocket.writeBinaryMessage(.tty_output, bytes) catch {};
            return;
        }

        if (bytes.len > self.pending_remote.len - self.pending_remote_len) {
            self.flushRemoteLocked(now);
        }

        if (bytes.len > self.pending_remote.len) {
            self.last_remote_send_ns = now;
            self.websocket.writeBinaryMessage(.tty_output, bytes) catch {};
            return;
        }

        @memcpy(self.pending_remote[self.pending_remote_len..][0..bytes.len], bytes);
        self.pending_remote_len += bytes.len;

        if (self.pending_remote_len == self.pending_remote.len) {
            self.flushRemoteLocked(now);
        }
    }

    fn flushRemoteDue(self: *SharedOutput, force: bool) void {
        self.remote_lock.lock();
        defer self.remote_lock.unlock();

        if (self.pending_remote_len == 0) return;

        const now = monotonicNanoTimestamp();
        if (!force and now - self.last_remote_send_ns < remote_output_flush_ns) return;

        self.flushRemoteLocked(now);
    }

    fn flushRemoteLocked(self: *SharedOutput, now: i128) void {
        if (self.pending_remote_len == 0) return;

        const bytes = self.pending_remote[0..self.pending_remote_len];
        self.pending_remote_len = 0;
        self.last_remote_send_ns = now;
        self.websocket.writeBinaryMessage(.tty_output, bytes) catch {};
    }
};

fn shouldSendImmediately(last_send_ns: i128, now: i128) bool {
    return last_send_ns == 0 or now - last_send_ns >= remote_output_flush_ns;
}

fn monotonicNanoTimestamp() i128 {
    if (builtin.os.tag == .windows) {
        return @as(i128, win_c.GetTickCount64()) * std.time.ns_per_ms;
    }

    var ts: posix_c.timespec = undefined;
    if (posix_c.clock_gettime(posix_c.CLOCK_MONOTONIC, &ts) != 0) return 0;
    return @as(i128, ts.tv_sec) * std.time.ns_per_s + @as(i128, ts.tv_nsec);
}

const ApprovalModal = struct {
    allocator: Allocator,
    lock: Mutex = .{},
    width: i32 = 80,
    height: i32 = 24,
    active: bool = false,
    request: ?ControlRequestPayload = null,
    buffer: ByteList,
    dismissed_viewer_id: ?[]u8 = null,

    fn init(allocator: Allocator) ApprovalModal {
        return .{
            .allocator = allocator,
            .buffer = ByteList.init(allocator),
        };
    }

    fn deinit(self: *ApprovalModal) void {
        self.buffer.deinit();
        self.freeRequest();
        self.freeDismissed();
    }

    fn setSize(self: *ApprovalModal, width: i32, height: i32, output: *SharedOutput) !void {
        self.lock.lock();
        defer self.lock.unlock();

        if (width > 0) self.width = width;
        if (height > 0) self.height = height;
        if (self.active) try self.renderLocked(output);
    }

    fn handlePTYOutput(self: *ApprovalModal, chunk: []const u8, output: *SharedOutput) !void {
        self.lock.lock();
        defer self.lock.unlock();

        if (self.active) {
            try self.buffer.appendSlice(chunk);
            return;
        }

        try output.forward(chunk);
    }

    fn handleLocalInput(self: *ApprovalModal, chunk: []const u8, output: *SharedOutput) !?ModalDecision {
        self.lock.lock();
        defer self.lock.unlock();

        if (!self.active or self.request == null) return null;

        for (chunk) |byte| {
            switch (byte) {
                'y', 'Y' => {
                    const request = self.request.?;
                    const viewer_id = try self.allocator.dupe(u8, request.viewerId);
                    try self.replaceDismissedLocked(request.viewerId);
                    try self.closeLocked(output);
                    return .{
                        .action = .approve,
                        .viewer_id = viewer_id,
                        .lease_seconds = request.leaseSeconds,
                    };
                },
                'n', 'N', '\r', '\n', 0x03, 0x1b => {
                    const request = self.request.?;
                    const viewer_id = try self.allocator.dupe(u8, request.viewerId);
                    try self.replaceDismissedLocked(request.viewerId);
                    try self.closeLocked(output);
                    return .{
                        .action = .reject,
                        .viewer_id = viewer_id,
                        .lease_seconds = request.leaseSeconds,
                    };
                },
                else => {},
            }
        }

        return null;
    }

    fn syncPendingRequest(self: *ApprovalModal, request: ?ControlRequestPayload, output: *SharedOutput) !void {
        self.lock.lock();
        defer self.lock.unlock();

        if (request == null) {
            if (self.active) try self.closeLocked(output);
            self.freeDismissed();
            self.freeRequest();
            return;
        }

        const req = request.?;
        if (!self.active) {
            if (self.dismissed_viewer_id) |dismissed| {
                if (std.mem.eql(u8, dismissed, req.viewerId)) return;
            }
        }

        if (self.active) {
            if (self.request) |current| {
                if (current.leaseSeconds == req.leaseSeconds and std.mem.eql(u8, current.viewerId, req.viewerId)) {
                    return;
                }
            }
        }

        try self.storeRequestLocked(req);
        self.active = true;
        try output.beep();
        try self.renderLocked(output);
    }

    fn closeLocked(self: *ApprovalModal, output: *SharedOutput) !void {
        if (!self.active) return;

        self.active = false;
        self.freeRequest();
        try output.writeDirect("\x1b[?25h\x1b[?1049l");

        if (self.buffer.items.len == 0) return;

        const buffered = try self.allocator.dupe(u8, self.buffer.items);
        defer self.allocator.free(buffered);
        self.buffer.clearRetainingCapacity();
        try output.forward(buffered);
    }

    fn renderLocked(self: *ApprovalModal, output: *SharedOutput) !void {
        const width = clampInt(self.width, 48, 80);
        var box_width = @min(width - 4, 72);
        if (box_width < 36) box_width = 36;
        const inner_width = box_width - 2;

        const viewer_id = if (self.request) |request| request.viewerId else "unknown";
        const lease_seconds = if (self.request) |request| request.leaseSeconds else 0;
        const lease_minutes = @max(@divTrunc(lease_seconds, 60), 1);

        var rendered = ByteList.init(self.allocator);
        defer rendered.deinit();

        const start_col = @max(@divTrunc(self.width - box_width, 2), 1);
        const start_row = @max(@divTrunc(self.height - 9, 2), 1);

        try rendered.appendSlice("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H");
        try rendered.print("\x1b[{d};{d}H┌", .{ start_row, start_col });
        try appendRepeat(&rendered, "─", inner_width);
        try rendered.appendSlice("┐");

        var lines = [_][]const u8{
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
        };

        lines[0] = try centerText(self.allocator, inner_width, "Control Request");
        defer self.allocator.free(lines[0]);
        lines[1] = "";
        const viewer_line = try std.fmt.allocPrint(self.allocator, "Viewer {s} wants control.", .{viewer_id});
        defer self.allocator.free(viewer_line);
        lines[2] = try truncateText(self.allocator, inner_width, viewer_line);
        defer self.allocator.free(lines[2]);
        const lease_line = try std.fmt.allocPrint(self.allocator, "Lease: {d} minutes", .{lease_minutes});
        defer self.allocator.free(lease_line);
        lines[3] = try truncateText(self.allocator, inner_width, lease_line);
        defer self.allocator.free(lines[3]);
        lines[4] = "";
        lines[5] = try truncateText(self.allocator, inner_width, "Press Y to approve or N to deny.");
        defer self.allocator.free(lines[5]);
        lines[6] = "";
        lines[7] = try truncateText(self.allocator, inner_width, "Session output is paused until you decide.");
        defer self.allocator.free(lines[7]);

        for (lines, 0..) |line, index| {
            try rendered.print("\x1b[{d};{d}H│", .{ start_row + 1 + @as(i32, @intCast(index)), start_col });
            try appendPadded(&rendered, line, inner_width);
            try rendered.appendSlice("│");
        }

        try rendered.print("\x1b[{d};{d}H└", .{ start_row + 1 + @as(i32, @intCast(lines.len)), start_col });
        try appendRepeat(&rendered, "─", inner_width);
        try rendered.appendSlice("┘");

        try output.writeDirect(rendered.items);
    }

    fn storeRequestLocked(self: *ApprovalModal, request: ControlRequestPayload) !void {
        self.freeRequest();
        self.request = .{
            .viewerId = try self.allocator.dupe(u8, request.viewerId),
            .leaseSeconds = request.leaseSeconds,
        };
    }

    fn replaceDismissedLocked(self: *ApprovalModal, viewer_id: []const u8) !void {
        self.freeDismissed();
        self.dismissed_viewer_id = try self.allocator.dupe(u8, viewer_id);
    }

    fn freeRequest(self: *ApprovalModal) void {
        if (self.request) |request| self.allocator.free(request.viewerId);
        self.request = null;
    }

    fn freeDismissed(self: *ApprovalModal) void {
        if (self.dismissed_viewer_id) |value| self.allocator.free(value);
        self.dismissed_viewer_id = null;
    }
};

const ThreadContext = struct {
    allocator: Allocator,
    io: std.Io,
    host_websocket_url: []const u8,
    state: *RunState,
    pty: *PTY,
    modal: *ApprovalModal,
    output: *SharedOutput,
    ws: *WebSocketSlot,
};

pub fn main(init: std.process.Init) !void {
    try transport_mod.globalInit();
    defer transport_mod.globalDeinit();

    if (init.environ_map.contains(nested_agent_env)) {
        try writeStderrAll("ttys-agent is already active in this terminal session.\n");
        try writeStderrAll("Open a new local terminal, or exit the current shared shell before starting another agent.\n");
        return;
    }

    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    const config = try parseArgs(allocator, init.minimal.args);
    const connect_info = try resolveConnection(allocator, init.io, config);

    const shell = config.shell orelse platform.defaultShell();

    var pty = try PTY.spawn(shell);

    try printSessionStarted(connect_info.viewer_url);

    const raw_terminal = try RawTerminal.enter();
    defer raw_terminal.leave();

    var ws = WebSocketSlot{};

    var output = SharedOutput{ .websocket = &ws };
    var modal = ApprovalModal.init(allocator);
    defer modal.deinit();

    if (getTerminalSize()) |size| {
        pty.resize(size.cols, size.rows);
        try modal.setSize(size.cols, size.rows, &output);
    } else |_| {}

    var state = RunState{ .allocator = allocator };
    var context = ThreadContext{
        .allocator = allocator,
        .io = init.io,
        .host_websocket_url = connect_info.host_websocket_url,
        .state = &state,
        .pty = &pty,
        .modal = &modal,
        .output = &output,
        .ws = &ws,
    };

    const pty_reader_thread = try std.Thread.spawn(.{}, ptyReaderMain, .{&context});
    pty_reader_thread.detach();
    const websocket_reader_thread = try std.Thread.spawn(.{}, websocketMain, .{&context});
    websocket_reader_thread.detach();
    const stdin_thread = try std.Thread.spawn(.{}, stdinMain, .{&context});
    stdin_thread.detach();
    const output_flusher_thread = try std.Thread.spawn(.{}, outputFlusherMain, .{&context});
    output_flusher_thread.detach();
    const resize_thread = try std.Thread.spawn(.{}, resizeMain, .{&context});
    resize_thread.detach();
    const child_wait_thread = try std.Thread.spawn(.{}, childWaitMain, .{&context});
    child_wait_thread.detach();

    const err = state.wait();
    output.flushRemoteDue(true);
    ws.closeCurrent();

    if (err) |message| {
        try printSessionEnded(true);
        try writeStderrAll(message);
        try writeStderrAll("\n");
        return error.RunFailed;
    }

    try printSessionEnded(false);
}

fn ptyReaderMain(ctx: *ThreadContext) void {
    var buf: [4096]u8 = undefined;
    while (!ctx.state.isDone()) {
        const n = ctx.pty.read(&buf) catch |err| switch (err) {
            error.Interrupted => continue,
            else => {
                ctx.state.finishErrFmt("PTY read failed: {s}", .{@errorName(err)});
                return;
            },
        };
        if (n == 0) {
            ctx.output.flushRemoteDue(true);
            ctx.state.finishOk();
            return;
        }

        ctx.modal.handlePTYOutput(buf[0..n], ctx.output) catch |err| {
            ctx.state.finishErrFmt("PTY output failed: {s}", .{@errorName(err)});
            return;
        };
    }
}

fn outputFlusherMain(ctx: *ThreadContext) void {
    while (!ctx.state.isDone()) {
        sleepMillis(1);
        ctx.output.flushRemoteDue(false);
    }
    ctx.output.flushRemoteDue(true);
}

fn websocketMain(ctx: *ThreadContext) void {
    var delay_ms: u64 = 250;
    while (!ctx.state.isDone()) {
        var ws = WebSocketClient.connect(ctx.allocator, ctx.io, ctx.host_websocket_url) catch {
            sleepMillis(delay_ms);
            delay_ms = @min(delay_ms * 2, 5000);
            continue;
        };
        delay_ms = 250;
        ctx.ws.setConnected(&ws);

        readWebSocketLoop(ctx, &ws);

        ctx.ws.setDisconnected(&ws);
        ws.close();
        if (!ctx.state.isDone()) {
            sleepMillis(delay_ms);
        }
    }
}

fn readWebSocketLoop(ctx: *ThreadContext, ws: *WebSocketClient) void {
    while (!ctx.state.isDone()) {
        const maybe_message = ws.readMessageAlloc(ctx.allocator) catch return;
        if (maybe_message == null) {
            sleepMillis(10);
            continue;
        }

        const message = maybe_message.?;
        defer ctx.allocator.free(message.payload);
        switch (message.kind) {
            .text => handleControlFrame(ctx, message.payload) catch |err| {
                ctx.state.finishErrFmt("frame handling failed: {s}", .{@errorName(err)});
                return;
            },
            .binary => handleBinaryFrame(ctx, message.payload) catch |err| {
                ctx.state.finishErrFmt("binary frame handling failed: {s}", .{@errorName(err)});
                return;
            },
        }
    }
}

fn stdinMain(ctx: *ThreadContext) void {
    var buf: [4096]u8 = undefined;
    while (!ctx.state.isDone()) {
        const n = switch (readStdin(&buf) catch |err| switch (err) {
            error.Interrupted => continue,
            else => {
                ctx.state.finishErrFmt("stdin read failed: {s}", .{@errorName(err)});
                return;
            },
        }) {
            .data => |n| n,
            .would_block => continue,
            .eof => return,
        };

        const chunk = buf[0..n];
        const maybe_decision = ctx.modal.handleLocalInput(chunk, ctx.output) catch |err| {
            ctx.state.finishErrFmt("local input failed: {s}", .{@errorName(err)});
            return;
        };

        if (maybe_decision) |decision| {
            defer ctx.allocator.free(decision.viewer_id);
            sendDecision(ctx, decision) catch |err| {
                ctx.state.finishErrFmt("control decision failed: {s}", .{@errorName(err)});
                return;
            };
            continue;
        }

        if (ctx.modal.active) continue;
        writeAllPTY(ctx.pty, chunk) catch |err| {
            ctx.state.finishErrFmt("PTY write failed: {s}", .{@errorName(err)});
            return;
        };
    }
}

fn resizeMain(ctx: *ThreadContext) void {
    var last = getTerminalSize() catch TerminalSize{ .cols = 80, .rows = 24 };
    while (!ctx.state.isDone()) {
        sleepMillis(250);
        const current = getTerminalSize() catch continue;
        if (current.cols == last.cols and current.rows == last.rows) continue;
        last = current;
        ctx.pty.resize(current.cols, current.rows);
        ctx.modal.setSize(current.cols, current.rows, ctx.output) catch |err| {
            ctx.state.finishErrFmt("modal resize failed: {s}", .{@errorName(err)});
            return;
        };
    }
}

fn childWaitMain(ctx: *ThreadContext) void {
    ctx.pty.wait() catch |err| {
        ctx.state.finishErrFmt("shell wait failed: {s}", .{@errorName(err)});
        return;
    };
    ctx.state.finishOk();
}

fn handleControlFrame(ctx: *ThreadContext, payload: []const u8) !void {
    var parsed = std.json.parseFromSlice(std.json.Value, ctx.allocator, payload, .{}) catch return;
    defer parsed.deinit();

    const root = parsed.value.object;
    const frame_type = root.get("type") orelse return;
    const payload_value = root.get("payload") orelse return;
    const frame_type_string = frame_type.string;

    if (std.mem.eql(u8, frame_type_string, "session.status")) {
        const status = try std.json.parseFromValue(SessionStatusPayload, ctx.allocator, payload_value, .{ .ignore_unknown_fields = true });
        defer status.deinit();
        try ctx.modal.syncPendingRequest(status.value.pendingControlRequest, ctx.output);
    }
}

fn handleBinaryFrame(ctx: *ThreadContext, payload: []const u8) !void {
    const frame = try transport_mod.unwrapBinary(payload);
    switch (frame.kind) {
        .stdin => try writeAllPTY(ctx.pty, frame.data),
        .tty_output => {},
    }
}

fn sendDecision(ctx: *ThreadContext, decision: ModalDecision) !void {
    var message = ByteList.init(ctx.allocator);
    defer message.deinit();

    switch (decision.action) {
        .approve => {
            const viewer_id = try jsonEscapeAlloc(ctx.allocator, decision.viewer_id);
            defer ctx.allocator.free(viewer_id);
            try message.print(
                "{{\"type\":\"control.approve\",\"payload\":{{\"viewerId\":\"{s}\",\"leaseSeconds\":{d}}}}}",
                .{ viewer_id, decision.lease_seconds },
            );
        },
        .reject => {
            const viewer_id = try jsonEscapeAlloc(ctx.allocator, decision.viewer_id);
            defer ctx.allocator.free(viewer_id);
            try message.print(
                "{{\"type\":\"control.reject\",\"payload\":{{\"viewerId\":\"{s}\"}}}}",
                .{viewer_id},
            );
        },
    }

    ctx.ws.writeJSON(message.items) catch {};
}

fn parseArgs(allocator: Allocator, process_args: std.process.Args) !Config {
    var config = Config{};
    var args = try std.process.Args.Iterator.initAllocator(process_args, allocator);
    defer args.deinit();

    var argv = std.array_list.Managed([]const u8).init(allocator);
    defer argv.deinit();

    while (args.next()) |arg| {
        try argv.append(arg);
    }

    var index: usize = 1;
    while (index < argv.items.len) : (index += 1) {
        const arg = argv.items[index];
        const next_arg = if (index + 1 < argv.items.len) argv.items[index + 1] else null;

        if (try parseFlagValue(arg, next_arg, "--server", "-server")) |value| {
            config.server_url = value.value;
            if (value.consumed_next) index += 1;
        } else if (try parseFlagValue(arg, next_arg, "--session", "-session")) |value| {
            config.session_id = value.value;
            if (value.consumed_next) index += 1;
        } else if (try parseFlagValue(arg, next_arg, "--shell", "-shell")) |value| {
            config.shell = value.value;
            if (value.consumed_next) index += 1;
        } else {
            return error.UnknownArgument;
        }
    }

    return config;
}

fn resolveConnection(allocator: Allocator, io: std.Io, config: Config) !ConnectInfo {
    const base = try std.Uri.parse(config.server_url);
    const scheme = base.scheme;
    if (scheme.len == 0) return error.InvalidServerURL;

    if (std.mem.eql(u8, scheme, "ws") or std.mem.eql(u8, scheme, "wss")) {
        if (config.session_id != null) return error.SessionFlagNotSupportedForWebSocket;
        return .{
            .viewer_url = try viewerURLFromWebSocket(allocator, config.server_url),
            .host_websocket_url = try allocator.dupe(u8, config.server_url),
        };
    }

    if (std.mem.eql(u8, scheme, "http") or std.mem.eql(u8, scheme, "https")) {
        if (config.session_id) |session_id| {
            const viewer_path = try std.fmt.allocPrint(allocator, "/s/{s}", .{session_id});
            const ws_path = try std.fmt.allocPrint(allocator, "/api/session/{s}/host", .{session_id});
            return .{
                .viewer_url = try resolveRelativeURL(allocator, config.server_url, viewer_path),
                .host_websocket_url = try websocketURL(allocator, config.server_url, ws_path),
            };
        }
        return try createSession(allocator, io, config.server_url);
    }

    return error.UnsupportedScheme;
}

fn createSession(allocator: Allocator, io: std.Io, base_url: []const u8) !ConnectInfo {
    const request_url = try resolveRelativeURL(allocator, base_url, "/api/session");
    const body = try httpPostAlloc(allocator, io, request_url);
    defer allocator.free(body);

    var parsed = try std.json.parseFromSlice(CreateSessionResponse, allocator, body, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();

    return .{
        .viewer_url = try resolveRelativeURL(allocator, base_url, parsed.value.viewerUrl),
        .host_websocket_url = try websocketURL(allocator, base_url, parsed.value.hostWebSocketUrl),
    };
}

fn httpPostAlloc(allocator: Allocator, io: std.Io, url: []const u8) ![]u8 {
    return try httpPostAllocRedirects(allocator, io, url, 3);
}

fn httpPostAllocRedirects(allocator: Allocator, io: std.Io, url: []const u8, redirects_left: usize) ![]u8 {
    var client: std.http.Client = .{
        .allocator = allocator,
        .io = io,
    };
    defer client.deinit();

    const uri = try std.Uri.parse(url);
    var request = try std.http.Client.request(&client, .POST, uri, .{
        .redirect_behavior = .unhandled,
        .keep_alive = false,
    });
    defer request.deinit();

    try request.sendBodiless();

    var response = try request.receiveHead(&.{});
    var reader = response.reader(&.{});
    if (isRedirectStatus(response.head.status)) {
        if (redirects_left == 0) return error.TooManyRedirects;
        const location = responseLocation(response.head) orelse return error.RedirectMissingLocation;
        const next_url = try resolveRelativeURL(allocator, url, location);
        return try httpPostAllocRedirects(allocator, io, next_url, redirects_left - 1);
    }

    if (response.head.status != .ok) {
        const body = try reader.allocRemaining(allocator, .limited(4 << 10));
        defer allocator.free(body);
        const trimmed = std.mem.trim(u8, body, " \t\r\n");
        if (trimmed.len > 0) {
            try writeStderrAll("create session failed: ");
            try writeStderrAll(trimmed);
            try writeStderrAll("\n");
        } else {
            try writeStderrAll("create session failed\n");
        }
        return error.CreateSessionFailed;
    }

    return try reader.allocRemaining(allocator, .limited(4 << 10));
}

fn isRedirectStatus(status: std.http.Status) bool {
    return switch (status) {
        .moved_permanently, .found, .see_other, .temporary_redirect, .permanent_redirect => true,
        else => false,
    };
}

fn responseLocation(head: std.http.Client.Response.Head) ?[]const u8 {
    var it = head.iterateHeaders();
    while (it.next()) |header| {
        if (std.ascii.eqlIgnoreCase(header.name, "location")) return header.value;
    }
    return null;
}

const ParsedFlagValue = struct {
    value: []const u8,
    consumed_next: bool,
};

fn parseFlagValue(arg: []const u8, next_arg: ?[]const u8, long_name: []const u8, short_name: []const u8) !?ParsedFlagValue {
    if (std.mem.eql(u8, arg, long_name) or std.mem.eql(u8, arg, short_name)) {
        return .{
            .value = next_arg orelse return error.MissingFlagValue,
            .consumed_next = true,
        };
    }

    if (std.mem.startsWith(u8, arg, long_name) and arg.len > long_name.len and arg[long_name.len] == '=') {
        return .{
            .value = arg[long_name.len + 1 ..],
            .consumed_next = false,
        };
    }

    if (std.mem.startsWith(u8, arg, short_name) and arg.len > short_name.len and arg[short_name.len] == '=') {
        return .{
            .value = arg[short_name.len + 1 ..],
            .consumed_next = false,
        };
    }

    return null;
}

fn resolveRelativeURL(allocator: Allocator, base_url: []const u8, value: []const u8) ![]u8 {
    if (std.mem.startsWith(u8, value, "http://") or std.mem.startsWith(u8, value, "https://")) {
        return try allocator.dupe(u8, value);
    }

    var base = try std.Uri.parse(base_url);
    var path = value;
    if (!std.mem.startsWith(u8, path, "/")) {
        path = try std.fmt.allocPrint(allocator, "/{s}", .{path});
    }

    base.path = .{ .raw = path };
    base.query = null;
    base.fragment = null;
    return try uriToStringAlloc(allocator, base);
}

fn websocketURL(allocator: Allocator, base_url: []const u8, route: []const u8) ![]u8 {
    var base = try std.Uri.parse(base_url);
    if (std.mem.eql(u8, base.scheme, "https")) {
        base.scheme = "wss";
    } else {
        base.scheme = "ws";
    }
    base.path = .{ .raw = route };
    base.query = null;
    base.fragment = null;
    return try uriToStringAlloc(allocator, base);
}

fn viewerURLFromWebSocket(allocator: Allocator, websocket_url: []const u8) ![]u8 {
    var parsed = try std.Uri.parse(websocket_url);
    if (std.mem.eql(u8, parsed.scheme, "wss")) {
        parsed.scheme = "https";
    } else {
        parsed.scheme = "http";
    }

    var path_buffer: [1024]u8 = undefined;
    const path = try parsed.path.toRaw(&path_buffer);
    var parts = std.mem.splitScalar(u8, std.mem.trim(u8, path, "/"), '/');
    _ = parts.next();
    _ = parts.next();
    if (parts.next()) |session_id| {
        var viewer_path_buffer: [256]u8 = undefined;
        const viewer_path = try std.fmt.bufPrint(&viewer_path_buffer, "/s/{s}", .{session_id});
        parsed.path = .{ .raw = viewer_path };
        parsed.query = null;
        parsed.fragment = null;
    }

    return try uriToStringAlloc(allocator, parsed);
}

fn clampInt(value: i32, min_value: i32, max_value: i32) i32 {
    return @max(min_value, @min(value, max_value));
}

fn appendRepeat(list: *ByteList, value: []const u8, count: i32) !void {
    var i: i32 = 0;
    while (i < count) : (i += 1) {
        try list.appendSlice(value);
    }
}

fn appendPadded(list: *ByteList, value: []const u8, width: i32) !void {
    const truncated = try truncateText(list.allocator, width, value);
    defer list.allocator.free(truncated);
    try list.appendSlice(truncated);
    var remaining = width - @as(i32, @intCast(truncated.len));
    while (remaining > 0) : (remaining -= 1) {
        try list.append(' ');
    }
}

fn centerText(allocator: Allocator, width: i32, value: []const u8) ![]u8 {
    const truncated = try truncateText(allocator, width, value);
    if (truncated.len >= @as(usize, @intCast(width))) return truncated;

    const padding = (@as(usize, @intCast(width)) - truncated.len) / 2;
    var output = ByteList.init(allocator);
    errdefer output.deinit();
    try output.appendNTimes(' ', padding);
    try output.appendSlice(truncated);
    allocator.free(truncated);
    return try output.toOwnedSlice();
}

fn truncateText(allocator: Allocator, width: i32, value: []const u8) ![]u8 {
    if (width <= 0) return allocator.alloc(u8, 0);
    if (value.len <= @as(usize, @intCast(width))) return try allocator.dupe(u8, value);
    if (width == 1) return try allocator.dupe(u8, value[0..1]);

    var output = ByteList.init(allocator);
    errdefer output.deinit();
    try output.appendSlice(value[0..@as(usize, @intCast(width - 1))]);
    try output.appendSlice("…");
    return try output.toOwnedSlice();
}

fn writeAllPTY(pty: *const PTY, bytes: []const u8) !void {
    var offset: usize = 0;
    while (offset < bytes.len) {
        const written = try pty.write(bytes[offset..]);
        if (written == 0) return error.PTYWriteZero;
        offset += written;
    }
}

fn sleepMillis(ms: u64) void {
    if (builtin.os.tag == .windows) {
        _ = win_c.Sleep(@intCast(ms));
        return;
    }
    _ = posix_c.usleep(@intCast(ms * 1000));
}

fn printSessionStarted(viewer_url: []const u8) !void {
    try writeStderrAll("ttys-agent: shared shell is active.\n");
    try writeStderrAll("Share URL: ");
    try writeStderrAll(viewer_url);
    try writeStderrAll("\n");
    try writeStderrAll("Exit the shared shell with Ctrl-D or 'exit'.\n\n");
}

fn printSessionEnded(failed: bool) !void {
    if (failed) {
        try writeStderrAll("\nttys-agent: shared shell ended with an error.\n");
    } else {
        try writeStderrAll("\nttys-agent: shared shell ended. Remote access is closed.\n");
    }
}

fn writeStdoutAll(bytes: []const u8) !void {
    if (builtin.os.tag == .windows) {
        const handle = win_c.GetStdHandle(win_c.STD_OUTPUT_HANDLE);
        if (handle == null or handle == win_c.INVALID_HANDLE_VALUE) return error.StdoutWriteFailed;

        var offset: usize = 0;
        while (offset < bytes.len) {
            var written: win_c.DWORD = 0;
            const chunk_len: usize = @min(bytes.len - offset, std.math.maxInt(win_c.DWORD));
            if (win_c.WriteFile(handle, bytes.ptr + offset, @intCast(chunk_len), &written, null) == 0) {
                return error.StdoutWriteFailed;
            }
            if (written == 0) return error.StdoutWriteFailed;
            offset += written;
        }
        return;
    }

    var offset: usize = 0;
    while (offset < bytes.len) {
        const written = posix_c.write(1, bytes.ptr + offset, bytes.len - offset);
        if (written < 0) {
            if (isInterrupted()) continue;
            return error.StdoutWriteFailed;
        }
        if (written == 0) return error.StdoutWriteFailed;
        offset += @intCast(written);
    }
}

fn writeStderrAll(bytes: []const u8) !void {
    if (builtin.os.tag == .windows) {
        const handle = win_c.GetStdHandle(win_c.STD_ERROR_HANDLE);
        if (handle == null or handle == win_c.INVALID_HANDLE_VALUE) return error.StderrWriteFailed;

        var offset: usize = 0;
        while (offset < bytes.len) {
            var written: win_c.DWORD = 0;
            const chunk_len: usize = @min(bytes.len - offset, std.math.maxInt(win_c.DWORD));
            if (win_c.WriteFile(handle, bytes.ptr + offset, @intCast(chunk_len), &written, null) == 0) {
                return error.StderrWriteFailed;
            }
            if (written == 0) return error.StderrWriteFailed;
            offset += written;
        }
        return;
    }

    var offset: usize = 0;
    while (offset < bytes.len) {
        const written = posix_c.write(2, bytes.ptr + offset, bytes.len - offset);
        if (written < 0) {
            if (isInterrupted()) continue;
            return error.StderrWriteFailed;
        }
        if (written == 0) return error.StderrWriteFailed;
        offset += @intCast(written);
    }
}

fn readStdin(buf: []u8) !StdinRead {
    if (builtin.os.tag == .windows) {
        const handle = win_c.GetStdHandle(win_c.STD_INPUT_HANDLE);
        if (handle == null or handle == win_c.INVALID_HANDLE_VALUE) return error.StdinReadFailed;

        var read_count: win_c.DWORD = 0;
        if (win_c.ReadFile(handle, buf.ptr, @intCast(buf.len), &read_count, null) == 0) {
            if (isInterrupted()) return error.Interrupted;
            return error.StdinReadFailed;
        }
        if (read_count == 0) return .eof;
        return .{ .data = @intCast(read_count) };
    }

    var poll_fd = posix_c.pollfd{
        .fd = 0,
        .events = posix_c.POLLIN,
        .revents = 0,
    };
    const poll_result = posix_c.poll(&poll_fd, 1, 100);
    if (poll_result == 0) return .would_block;
    if (poll_result < 0) {
        if (isInterrupted()) return error.Interrupted;
        return error.StdinReadFailed;
    }

    const read_count = posix_c.read(0, buf.ptr, buf.len);
    if (read_count < 0) {
        if (isInterrupted()) return error.Interrupted;
        return error.StdinReadFailed;
    }
    if (read_count == 0) return .eof;
    return .{ .data = @intCast(read_count) };
}

fn isInterrupted() bool {
    if (builtin.os.tag == .windows) {
        return lastIOErrorCode() == win_c.ERROR_OPERATION_ABORTED;
    }
    return lastIOErrorCode() == posix_c.EINTR;
}

fn lastIOErrorCode() u32 {
    if (builtin.os.tag == .windows) {
        return win_c.GetLastError();
    }
    return @intCast(std.posix.system._errno().*);
}

fn jsonEscapeAlloc(allocator: Allocator, value: []const u8) ![]u8 {
    var list = ByteList.init(allocator);
    errdefer list.deinit();

    for (value) |byte| {
        switch (byte) {
            '\\' => try list.appendSlice("\\\\"),
            '"' => try list.appendSlice("\\\""),
            '\n' => try list.appendSlice("\\n"),
            '\r' => try list.appendSlice("\\r"),
            '\t' => try list.appendSlice("\\t"),
            else => try list.append(byte),
        }
    }

    return try list.toOwnedSlice();
}

fn uriToStringAlloc(allocator: Allocator, uri: std.Uri) ![]u8 {
    return try std.fmt.allocPrint(allocator, "{f}", .{uri});
}

test "parseFlagValue handles split and inline forms" {
    const split = (try parseFlagValue("--server", "http://localhost:5173", "--server", "-server")).?;
    try std.testing.expectEqualStrings("http://localhost:5173", split.value);
    try std.testing.expect(split.consumed_next);

    const inline_long = (try parseFlagValue("--server=http://localhost:5173", null, "--server", "-server")).?;
    try std.testing.expectEqualStrings("http://localhost:5173", inline_long.value);
    try std.testing.expect(!inline_long.consumed_next);

    const inline_short = (try parseFlagValue("-server=http://localhost:5173", null, "--server", "-server")).?;
    try std.testing.expectEqualStrings("http://localhost:5173", inline_short.value);
    try std.testing.expect(!inline_short.consumed_next);

    try std.testing.expectError(error.MissingFlagValue, parseFlagValue("--server", null, "--server", "-server"));
    try std.testing.expectEqual(@as(?ParsedFlagValue, null), try parseFlagValue("--other", null, "--server", "-server"));
}

test "url helpers render HTTP and websocket routes correctly" {
    const allocator = std.testing.allocator;

    const viewer_url = try resolveRelativeURL(allocator, "http://localhost:5173", "/s/abc");
    defer allocator.free(viewer_url);
    try std.testing.expectEqualStrings("http://localhost:5173/s/abc", viewer_url);

    const ws_url = try websocketURL(allocator, "https://example.com", "/api/session/abc/host");
    defer allocator.free(ws_url);
    try std.testing.expectEqualStrings("wss://example.com/api/session/abc/host", ws_url);

    const viewer_from_ws = try viewerURLFromWebSocket(allocator, "ws://localhost:5173/api/session/abc/host");
    defer allocator.free(viewer_from_ws);
    try std.testing.expectEqualStrings("http://localhost:5173/s/abc", viewer_from_ws);
}

test "uriToStringAlloc formats URI text rather than debug output" {
    const allocator = std.testing.allocator;

    var uri = try std.Uri.parse("http://localhost:5173");
    uri.path = .{ .raw = "/api/session" };
    uri.query = null;
    uri.fragment = null;

    const rendered = try uriToStringAlloc(allocator, uri);
    defer allocator.free(rendered);
    try std.testing.expectEqualStrings("http://localhost:5173/api/session", rendered);
}
