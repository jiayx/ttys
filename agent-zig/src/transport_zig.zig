const std = @import("std");
const sync = @import("sync.zig");
const websocket = @import("websocket.zig");

const Allocator = std.mem.Allocator;
const Io = std.Io;
const Mutex = sync.Mutex;

pub fn globalInit() !void {}
pub fn globalDeinit() void {}

pub const WebSocketClient = struct {
    io: Io,
    client: *std.http.Client,
    connection: *std.http.Client.Connection,
    codec: websocket.Codec,
    write_lock: Mutex = .{},

    pub fn connect(allocator: Allocator, io: Io, url: []const u8) !WebSocketClient {
        const client = try allocator.create(std.http.Client);
        errdefer allocator.destroy(client);

        client.* = .{
            .allocator = allocator,
            .io = io,
        };
        errdefer client.deinit();

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
            .codec = websocket.Codec.init(allocator, .{}),
        };
    }

    pub fn close(self: *WebSocketClient) void {
        self.codec.deinit();
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
            const message = try self.codec.readMessageAlloc(self.connection.reader());
            defer self.codec.allocator.free(message.payload);

            switch (message.kind) {
                .pong => continue,
                .ping => {
                    try self.writeMessage(message.payload, .pong);
                    continue;
                },
                .close => {
                    self.writeMessage(message.payload, .close) catch {};
                    return error.ConnectionClosed;
                },
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

        const writer = self.connection.writer();
        try websocket.writeClientFrame(writer, opcode, data, mask_key);
        try self.connection.flush();
    }
};

const Opcode = websocket.MessageKind;

fn verifyUpgradeHeaders(head: std.http.Client.Response.Head, key_b64: []const u8) !void {
    const expected_accept = websocket.acceptKey(key_b64);

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
