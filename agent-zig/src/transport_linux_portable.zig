const std = @import("std");

const c = @cImport({
    @cInclude("unistd.h");
});

const Allocator = std.mem.Allocator;
const Io = std.Io;

const websocket_magic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

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

pub fn globalInit() !void {}
pub fn globalDeinit() void {}

pub const WebSocketClient = struct {
    io: Io,
    client: *std.http.Client,
    connection: *std.http.Client.Connection,
    write_lock: Mutex = .{},

    const Header0 = packed struct(u8) {
        opcode: Opcode,
        rsv3: u1 = 0,
        rsv2: u1 = 0,
        rsv1: u1 = 0,
        fin: bool,
    };

    const Header1 = packed struct(u8) {
        payload_len: enum(u7) {
            len16 = 126,
            len64 = 127,
            _,
        },
        mask: bool,
    };

    const Opcode = enum(u4) {
        continuation = 0,
        text = 1,
        binary = 2,
        connection_close = 8,
        ping = 9,
        pong = 10,
        _,
    };

    pub fn connect(allocator: Allocator, io: Io, url: []const u8) !WebSocketClient {
        const client = try allocator.create(std.http.Client);
        errdefer allocator.destroy(client);

        client.* = .{
            .allocator = allocator,
            .io = io,
        };

        const uri = try std.Uri.parse(url);

        var key_raw: [16]u8 = undefined;
        io.random(&key_raw);

        var key_b64: [std.base64.standard.Encoder.calcSize(key_raw.len)]u8 = undefined;
        _ = std.base64.standard.Encoder.encode(&key_b64, &key_raw);

        const extra_headers = [_]std.http.Header{
            .{ .name = "Upgrade", .value = "websocket" },
            .{ .name = "Sec-WebSocket-Version", .value = "13" },
            .{ .name = "Sec-WebSocket-Key", .value = &key_b64 },
        };

        var request = try std.http.Client.request(client, .GET, uri, .{
            .headers = .{
                .connection = .{ .override = "Upgrade" },
                .user_agent = .{ .override = "ttys-agent-zig" },
                .accept_encoding = .omit,
            },
            .extra_headers = &extra_headers,
            .redirect_behavior = .unhandled,
            .keep_alive = true,
        });
        errdefer request.deinit();

        try request.sendBodiless();
        const response = try request.receiveHead(&.{});
        if (response.head.status != .switching_protocols) return error.WebSocketUpgradeFailed;

        try verifyUpgradeHeaders(response.head, &key_b64);

        const connection = request.connection orelse return error.WebSocketUpgradeFailed;
        request.connection = null;
        request.deinit();

        return .{
            .io = io,
            .client = client,
            .connection = connection,
        };
    }

    pub fn close(self: *WebSocketClient) void {
        self.connection.closing = true;
        self.client.connection_pool.release(self.connection, self.io);
        self.client.deinit();
        self.client.allocator.destroy(self.client);
    }

    pub fn writeText(self: *WebSocketClient, bytes: []const u8) !void {
        try self.writeMessage(bytes, .text);
    }

    pub fn writeJSON(self: *WebSocketClient, text: []const u8) !void {
        try self.writeText(text);
    }

    pub fn readTextAlloc(self: *WebSocketClient, allocator: Allocator) !?[]u8 {
        var result = std.array_list.Managed(u8).init(allocator);
        errdefer result.deinit();

        while (true) {
            const message = try self.readMessageAlloc(allocator);
            defer allocator.free(message.payload);

            switch (message.opcode) {
                .pong => continue,
                .ping => {
                    try self.writeMessage(message.payload, .pong);
                    continue;
                },
                .connection_close => return error.ConnectionClosed,
                .text => {
                    try result.appendSlice(message.payload);
                    return try result.toOwnedSlice();
                },
                else => continue,
            }
        }
    }

    fn writeMessage(self: *WebSocketClient, data: []const u8, opcode: Opcode) !void {
        self.write_lock.lock();
        defer self.write_lock.unlock();

        var mask_key: [4]u8 = undefined;
        self.io.random(&mask_key);

        var header: [14]u8 = undefined;
        var index: usize = 0;
        header[index] = @bitCast(@as(Header0, .{ .opcode = opcode, .fin = true }));
        index += 1;

        switch (data.len) {
            0...125 => {
                header[index] = @bitCast(@as(Header1, .{
                    .payload_len = @enumFromInt(data.len),
                    .mask = true,
                }));
                index += 1;
            },
            126...0xffff => {
                header[index] = @bitCast(@as(Header1, .{
                    .payload_len = .len16,
                    .mask = true,
                }));
                index += 1;
                std.mem.writeInt(u16, header[index..][0..2], @intCast(data.len), .big);
                index += 2;
            },
            else => {
                header[index] = @bitCast(@as(Header1, .{
                    .payload_len = .len64,
                    .mask = true,
                }));
                index += 1;
                std.mem.writeInt(u64, header[index..][0..8], data.len, .big);
                index += 8;
            },
        }

        @memcpy(header[index..][0..4], &mask_key);
        index += 4;

        var writer = self.connection.writer();
        try writer.writeAll(header[0..index]);

        var offset: usize = 0;
        var chunk: [4096]u8 = undefined;
        while (offset < data.len) {
            const chunk_len = @min(chunk.len, data.len - offset);
            for (data[offset .. offset + chunk_len], 0..) |byte, chunk_index| {
                chunk[chunk_index] = byte ^ mask_key[(offset + chunk_index) % mask_key.len];
            }
            try writer.writeAll(chunk[0..chunk_len]);
            offset += chunk_len;
        }

        try self.connection.flush();
    }

    const Message = struct {
        opcode: Opcode,
        payload: []u8,
    };

    fn readMessageAlloc(self: *WebSocketClient, allocator: Allocator) !Message {
        var payload = std.array_list.Managed(u8).init(allocator);
        errdefer payload.deinit();

        var current_opcode: ?Opcode = null;

        while (true) {
            const header0_byte = self.connection.reader().takeByte() catch return error.ConnectionClosed;
            const header1_byte = self.connection.reader().takeByte() catch return error.ConnectionClosed;
            const header0: Header0 = @bitCast(header0_byte);
            const header1: Header1 = @bitCast(header1_byte);

            const payload_len: usize = switch (header1.payload_len) {
                .len16 => try self.connection.reader().takeInt(u16, .big),
                .len64 => std.math.cast(usize, try self.connection.reader().takeInt(u64, .big)) orelse return error.MessageTooLarge,
                else => @intFromEnum(header1.payload_len),
            };

            var mask_key: [4]u8 = .{ 0, 0, 0, 0 };
            if (header1.mask) {
                const raw_mask = try self.connection.reader().takeArray(4);
                @memcpy(&mask_key, raw_mask);
            }

            const start = payload.items.len;
            try payload.resize(start + payload_len);
            for (payload.items[start .. start + payload_len], 0..) |*byte, idx| {
                byte.* = try self.connection.reader().takeByte();
                if (header1.mask) byte.* ^= mask_key[idx % mask_key.len];
            }

            switch (header0.opcode) {
                .ping, .pong, .connection_close => {
                    return .{
                        .opcode = header0.opcode,
                        .payload = try payload.toOwnedSlice(),
                    };
                },
                .text => current_opcode = .text,
                .continuation => {
                    if (current_opcode == null) return error.UnexpectedContinuation;
                },
                else => return error.UnsupportedFrame,
            }

            if (header0.fin) {
                return .{
                    .opcode = current_opcode orelse header0.opcode,
                    .payload = try payload.toOwnedSlice(),
                };
            }
        }
    }
};

fn verifyUpgradeHeaders(head: std.http.Client.Response.Head, key_b64: []const u8) !void {
    var sha1 = std.crypto.hash.Sha1.init(.{});
    sha1.update(key_b64);
    sha1.update(websocket_magic);

    var digest: [std.crypto.hash.Sha1.digest_length]u8 = undefined;
    sha1.final(&digest);

    var expected_accept: [std.base64.standard.Encoder.calcSize(digest.len)]u8 = undefined;
    _ = std.base64.standard.Encoder.encode(&expected_accept, &digest);

    var saw_upgrade = false;
    var saw_accept = false;
    var it = head.iterateHeaders();
    while (it.next()) |header| {
        if (std.ascii.eqlIgnoreCase(header.name, "upgrade")) {
            if (!std.ascii.eqlIgnoreCase(header.value, "websocket")) return error.WebSocketUpgradeFailed;
            saw_upgrade = true;
        } else if (std.ascii.eqlIgnoreCase(header.name, "sec-websocket-accept")) {
            if (!std.mem.eql(u8, header.value, &expected_accept)) return error.WebSocketUpgradeFailed;
            saw_accept = true;
        }
    }

    if (!saw_upgrade or !saw_accept) return error.WebSocketUpgradeFailed;
}

fn sleepMillis(ms: u64) void {
    _ = c.usleep(@intCast(ms * 1000));
}
