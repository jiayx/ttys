const std = @import("std");

const c = @cImport({
    @cInclude("curl/curl.h");
    @cInclude("fcntl.h");
    @cInclude("unistd.h");
});

const Allocator = std.mem.Allocator;

const Mutex = struct {
    state: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),

    fn lock(self: *Mutex) void {
        while (true) {
            if (self.state.cmpxchgWeak(false, true, .acquire, .monotonic) == null) return;
            std.atomic.spinLoopHint();
            sleepMillis(1);
        }
    }

    fn unlock(self: *Mutex) void {
        self.state.store(false, .release);
    }
};

pub fn globalInit() !void {
    try curlCode(c.curl_global_init(c.CURL_GLOBAL_DEFAULT));
}

pub fn globalDeinit() void {
    c.curl_global_cleanup();
}

pub const WebSocketClient = struct {
    easy: *c.CURL,
    lock: Mutex = .{},

    pub fn connect(allocator: Allocator, _: std.Io, url: []const u8) !WebSocketClient {
        const easy = c.curl_easy_init() orelse return error.CurlInitFailed;
        errdefer c.curl_easy_cleanup(easy);

        const url_z = try allocator.dupeZ(u8, url);
        defer allocator.free(url_z);

        try curlCode(c.curl_easy_setopt(easy, c.CURLOPT_URL, url_z.ptr));
        try curlCode(c.curl_easy_setopt(easy, c.CURLOPT_CONNECT_ONLY, @as(c_long, 2)));
        try curlCode(c.curl_easy_setopt(easy, c.CURLOPT_TCP_KEEPALIVE, @as(c_long, 1)));
        try curlCode(c.curl_easy_perform(easy));

        var socket_fd: c.curl_socket_t = 0;
        try curlCode(c.curl_easy_getinfo(easy, c.CURLINFO_ACTIVESOCKET, &socket_fd));
        if (socket_fd == c.CURL_SOCKET_BAD) return error.WebSocketSocketFailed;

        const flags = c.fcntl(@intCast(socket_fd), c.F_GETFL, @as(c_int, 0));
        if (flags >= 0) _ = c.fcntl(@intCast(socket_fd), c.F_SETFL, flags | c.O_NONBLOCK);

        return .{ .easy = easy };
    }

    pub fn close(self: *WebSocketClient) void {
        c.curl_easy_cleanup(self.easy);
    }

    pub fn writeText(self: *WebSocketClient, bytes: []const u8) !void {
        if (bytes.len == 0) return;

        self.lock.lock();
        defer self.lock.unlock();

        var offset: usize = 0;
        while (offset < bytes.len) {
            var sent: usize = 0;
            const code = c.curl_ws_send(self.easy, bytes.ptr + offset, bytes.len - offset, &sent, 0, c.CURLWS_TEXT);
            if (code == c.CURLE_AGAIN) {
                sleepMillis(10);
                continue;
            }
            try curlCode(code);
            offset += sent;
        }
    }

    pub fn writeJSON(self: *WebSocketClient, text: []const u8) !void {
        try self.writeText(text);
    }

    pub fn readTextAlloc(self: *WebSocketClient, allocator: Allocator) !?[]u8 {
        var result = std.array_list.Managed(u8).init(allocator);
        errdefer result.deinit();

        while (true) {
            var buf: [4096]u8 = undefined;
            var received: usize = 0;
            var meta_ptr: ?*const c.struct_curl_ws_frame = null;

            self.lock.lock();
            const code = c.curl_ws_recv(self.easy, &buf, buf.len, &received, &meta_ptr);
            self.lock.unlock();

            if (code == c.CURLE_AGAIN) {
                if (result.items.len > 0) break;
                return null;
            }
            try curlCode(code);

            if (meta_ptr == null) return null;
            const meta = meta_ptr.?;

            if ((meta.flags & c.CURLWS_PING) != 0) {
                continue;
            }
            if ((meta.flags & c.CURLWS_CLOSE) != 0) return error.ConnectionClosed;
            if ((meta.flags & c.CURLWS_TEXT) == 0) {
                if ((meta.bytesleft == 0) and result.items.len == 0) return null;
                continue;
            }

            try result.appendSlice(buf[0..received]);
            if (meta.bytesleft == 0) break;
        }

        return try result.toOwnedSlice();
    }
};

fn curlCode(code: c.CURLcode) !void {
    if (code == c.CURLE_OK) return;

    return switch (code) {
        c.CURLE_UNSUPPORTED_PROTOCOL => error.CurlUnsupportedProtocol,
        c.CURLE_URL_MALFORMAT => error.CurlUrlMalformed,
        c.CURLE_NOT_BUILT_IN => error.CurlNotBuiltIn,
        c.CURLE_COULDNT_RESOLVE_HOST => error.CurlCouldntResolveHost,
        c.CURLE_COULDNT_CONNECT => error.CurlCouldntConnect,
        c.CURLE_WEIRD_SERVER_REPLY => error.CurlWeirdServerReply,
        c.CURLE_SEND_ERROR => error.CurlSendError,
        c.CURLE_RECV_ERROR => error.CurlRecvError,
        c.CURLE_GOT_NOTHING => error.ConnectionClosed,
        else => error.CurlFailed,
    };
}

fn sleepMillis(ms: u64) void {
    _ = c.usleep(@intCast(ms * 1000));
}
