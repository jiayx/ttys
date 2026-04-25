const std = @import("std");
const sync = @import("sync.zig");
const transport_message = @import("transport_message.zig");

const c = @cImport({
    @cDefine("_WIN32_WINNT", "0x0A00");
    @cInclude("windows.h");
    @cInclude("winhttp.h");
});

const Allocator = std.mem.Allocator;
const ByteList = std.array_list.Managed(u8);
const Mutex = sync.Mutex;

pub const MessageKind = transport_message.Kind;
pub const Message = transport_message.Message;
pub const BinaryType = transport_message.BinaryType;

pub fn globalInit() !void {}
pub fn globalDeinit() void {}

pub const WebSocketClient = struct {
    allocator: Allocator,
    session: c.HINTERNET,
    connection: c.HINTERNET,
    websocket: c.HINTERNET,
    lock: Mutex = .{},

    pub fn connect(allocator: Allocator, _: std.Io, url: []const u8) !WebSocketClient {
        const uri = try std.Uri.parse(url);
        const secure = std.mem.eql(u8, uri.scheme, "wss");
        const host = uri.host orelse return error.InvalidWebSocketURL;
        const host_utf8 = try host.toRawMaybeAlloc(allocator);
        const host_w = try std.unicode.utf8ToUtf16LeAllocZ(allocator, host_utf8);
        defer allocator.free(host_w);

        const path = try buildPathAndQuery(allocator, uri);
        defer allocator.free(path);
        const path_w = try std.unicode.utf8ToUtf16LeAllocZ(allocator, path);
        defer allocator.free(path_w);

        const user_agent = try std.unicode.utf8ToUtf16LeAllocZ(allocator, "ttys-agent-zig");
        defer allocator.free(user_agent);

        const session = c.WinHttpOpen(user_agent.ptr, c.WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, null, null, 0);
        if (session == null) return error.WinHttpOpenFailed;
        errdefer _ = c.WinHttpCloseHandle(session);

        const default_port: u16 = if (secure) 443 else 80;
        const port: c.INTERNET_PORT = @intCast(uri.port orelse default_port);
        const connection = c.WinHttpConnect(session, host_w.ptr, port, 0);
        if (connection == null) return error.WinHttpConnectFailed;
        errdefer _ = c.WinHttpCloseHandle(connection);

        const request = c.WinHttpOpenRequest(
            connection,
            std.unicode.utf8ToUtf16LeStringLiteral("GET"),
            path_w.ptr,
            null,
            null,
            null,
            if (secure) c.WINHTTP_FLAG_SECURE else 0,
        );
        if (request == null) return error.WinHttpOpenRequestFailed;
        defer _ = c.WinHttpCloseHandle(request);

        if (c.WinHttpSetOption(request, c.WINHTTP_OPTION_UPGRADE_TO_WEB_SOCKET, null, 0) == 0) {
            return error.WinHttpSetOptionFailed;
        }

        if (c.WinHttpSendRequest(request, null, 0, null, 0, 0, 0) == 0) {
            return error.WinHttpSendRequestFailed;
        }
        if (c.WinHttpReceiveResponse(request, null) == 0) {
            return error.WinHttpReceiveResponseFailed;
        }

        var status_code: c.DWORD = 0;
        var size: c.DWORD = @sizeOf(c.DWORD);
        if (c.WinHttpQueryHeaders(request, c.WINHTTP_QUERY_STATUS_CODE | c.WINHTTP_QUERY_FLAG_NUMBER, null, &status_code, &size, null) == 0) {
            return error.WinHttpQueryHeadersFailed;
        }
        if (status_code != 101) return error.WebSocketUpgradeFailed;

        const websocket = c.WinHttpWebSocketCompleteUpgrade(request, 0);
        if (websocket == null) return error.WebSocketUpgradeFailed;

        return .{
            .allocator = allocator,
            .session = session,
            .connection = connection,
            .websocket = websocket,
        };
    }

    pub fn close(self: *WebSocketClient) void {
        _ = c.WinHttpWebSocketClose(self.websocket, 1000, null, 0);
        _ = c.WinHttpCloseHandle(self.websocket);
        _ = c.WinHttpCloseHandle(self.connection);
        _ = c.WinHttpCloseHandle(self.session);
    }

    pub fn writeBinaryMessage(self: *WebSocketClient, kind: BinaryType, bytes: []const u8) !void {
        const wrapped = try transport_message.wrapBinary(self.allocator, kind, bytes);
        defer self.allocator.free(wrapped);
        try self.writeMessage(wrapped, .binary);
    }

    fn writeMessage(self: *WebSocketClient, bytes: []const u8, kind: MessageKind) !void {
        if (bytes.len == 0) return;
        self.lock.lock();
        defer self.lock.unlock();

        var offset: usize = 0;
        while (offset < bytes.len) {
            const remaining = bytes.len - offset;
            const chunk_len: usize = @min(remaining, std.math.maxInt(c.DWORD));
            const buffer_type = winhttpBufferType(kind, offset + chunk_len == bytes.len);
            const rc = c.WinHttpWebSocketSend(self.websocket, buffer_type, @constCast(bytes.ptr + offset), @intCast(chunk_len));
            if (rc != c.NO_ERROR) return error.WebSocketSendFailed;
            offset += chunk_len;
        }
    }

    pub fn writeJSON(self: *WebSocketClient, text: []const u8) !void {
        try self.writeMessage(text, .text);
    }

    pub fn readMessageAlloc(self: *WebSocketClient, allocator: Allocator) !?Message {
        var result = ByteList.init(allocator);
        errdefer result.deinit();

        var message_kind: ?MessageKind = null;

        while (true) {
            var buf: [4096]u8 = undefined;
            var read_len: c.DWORD = 0;
            var buffer_type: c.WINHTTP_WEB_SOCKET_BUFFER_TYPE = c.WINHTTP_WEB_SOCKET_BINARY_MESSAGE_BUFFER_TYPE;

            const rc = c.WinHttpWebSocketReceive(self.websocket, &buf, buf.len, &read_len, &buffer_type);

            if (rc == c.ERROR_IO_PENDING or rc == c.WSAEWOULDBLOCK) {
                if (result.items.len > 0) break;
                return null;
            }
            if (rc != c.NO_ERROR) {
                if (rc == c.ERROR_WINHTTP_CONNECTION_ERROR) return error.ConnectionClosed;
                return error.WebSocketReceiveFailed;
            }

            switch (buffer_type) {
                c.WINHTTP_WEB_SOCKET_CLOSE_BUFFER_TYPE => return error.ConnectionClosed,
                c.WINHTTP_WEB_SOCKET_UTF8_FRAGMENT_BUFFER_TYPE => {
                    if (message_kind != null and message_kind.? != .text) return error.MixedWebSocketFragments;
                    message_kind = .text;
                    try result.appendSlice(buf[0..read_len]);
                },
                c.WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE => {
                    if (message_kind != null and message_kind.? != .text) return error.MixedWebSocketFragments;
                    try result.appendSlice(buf[0..read_len]);
                    return .{ .kind = .text, .payload = try result.toOwnedSlice() };
                },
                c.WINHTTP_WEB_SOCKET_BINARY_FRAGMENT_BUFFER_TYPE => {
                    if (message_kind != null and message_kind.? != .binary) return error.MixedWebSocketFragments;
                    message_kind = .binary;
                    try result.appendSlice(buf[0..read_len]);
                },
                c.WINHTTP_WEB_SOCKET_BINARY_MESSAGE_BUFFER_TYPE => {
                    if (message_kind != null and message_kind.? != .binary) return error.MixedWebSocketFragments;
                    try result.appendSlice(buf[0..read_len]);
                    return .{ .kind = .binary, .payload = try result.toOwnedSlice() };
                },
                else => {
                    if (result.items.len == 0) return null;
                },
            }
        }

        return .{
            .kind = message_kind orelse .text,
            .payload = try result.toOwnedSlice(),
        };
    }

};

fn winhttpBufferType(kind: MessageKind, final: bool) c.WINHTTP_WEB_SOCKET_BUFFER_TYPE {
    return switch (kind) {
        .text => if (final)
            c.WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE
        else
            c.WINHTTP_WEB_SOCKET_UTF8_FRAGMENT_BUFFER_TYPE,
        .binary => if (final)
            c.WINHTTP_WEB_SOCKET_BINARY_MESSAGE_BUFFER_TYPE
        else
            c.WINHTTP_WEB_SOCKET_BINARY_FRAGMENT_BUFFER_TYPE,
    };
}

fn buildPathAndQuery(allocator: Allocator, uri: std.Uri) ![]u8 {
    var list = std.array_list.Managed(u8).init(allocator);
    errdefer list.deinit();

    const raw_path = if (uri.path.raw.len == 0) "/" else uri.path.raw;
    try list.appendSlice(raw_path);
    if (uri.query) |query| {
        try list.append('?');
        switch (query) {
            .raw => |value| try list.appendSlice(value),
            .percent_encoded => |value| try list.appendSlice(value),
        }
    }
    return try list.toOwnedSlice();
}
