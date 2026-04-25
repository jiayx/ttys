const std = @import("std");

const Allocator = std.mem.Allocator;
const ByteList = std.array_list.Managed(u8);

const magic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

pub const default_max_message_size = 1 << 20;

pub const Options = struct {
    max_message_size: usize = default_max_message_size,
};

pub const MessageKind = enum {
    text,
    binary,
    close,
    ping,
    pong,
};

pub const Message = struct {
    kind: MessageKind,
    payload: []u8,
};

pub const Codec = struct {
    allocator: Allocator,
    options: Options,
    fragmented_kind: ?MessageKind = null,
    fragmented_payload: ByteList,

    pub fn init(allocator: Allocator, options: Options) Codec {
        return .{
            .allocator = allocator,
            .options = options,
            .fragmented_payload = ByteList.init(allocator),
        };
    }

    pub fn deinit(self: *Codec) void {
        self.fragmented_payload.deinit();
    }

    pub fn readMessageAlloc(self: *Codec, reader: *std.Io.Reader) !Message {
        while (true) {
            const frame = try readFrameAlloc(self.allocator, reader, self.options.max_message_size);
            defer self.allocator.free(frame.payload);

            switch (frame.opcode) {
                .text, .binary => {
                    if (self.fragmented_kind != null) return error.UnexpectedDataFrame;

                    const kind = messageKind(frame.opcode);
                    if (frame.fin) {
                        return .{
                            .kind = kind,
                            .payload = try self.allocator.dupe(u8, frame.payload),
                        };
                    }

                    self.fragmented_kind = kind;
                    self.fragmented_payload.clearRetainingCapacity();
                    try appendChecked(&self.fragmented_payload, frame.payload, self.options.max_message_size);
                },
                .continuation => {
                    const kind = self.fragmented_kind orelse return error.UnexpectedContinuation;
                    try appendChecked(&self.fragmented_payload, frame.payload, self.options.max_message_size);

                    if (frame.fin) {
                        self.fragmented_kind = null;
                        return .{
                            .kind = kind,
                            .payload = try self.fragmented_payload.toOwnedSlice(),
                        };
                    }
                },
                .close, .ping, .pong => {
                    return .{
                        .kind = messageKind(frame.opcode),
                        .payload = try self.allocator.dupe(u8, frame.payload),
                    };
                },
            }
        }
    }
};

pub fn writeClientFrame(writer: *std.Io.Writer, kind: MessageKind, payload: []const u8, mask_key: [4]u8) !void {
    try writeFrame(writer, kind, payload, mask_key);
}

fn writeFrame(writer: *std.Io.Writer, kind: MessageKind, payload: []const u8, mask_key: [4]u8) !void {
    const opcode = opcodeForMessage(kind);
    if (isControl(opcode) and payload.len > 125) return error.ControlFrameTooLarge;

    var header: [14]u8 = undefined;
    var index: usize = 0;

    header[index] = 0x80 | @as(u8, @intFromEnum(opcode));
    index += 1;

    switch (payload.len) {
        0...125 => {
            header[index] = 0x80 | @as(u8, @intCast(payload.len));
            index += 1;
        },
        126...0xffff => {
            if (isControl(opcode)) return error.ControlFrameTooLarge;
            header[index] = 0x80 | 126;
            index += 1;
            std.mem.writeInt(u16, header[index..][0..2], @intCast(payload.len), .big);
            index += 2;
        },
        else => {
            if (isControl(opcode)) return error.ControlFrameTooLarge;
            header[index] = 0x80 | 127;
            index += 1;
            std.mem.writeInt(u64, header[index..][0..8], payload.len, .big);
            index += 8;
        },
    }

    @memcpy(header[index..][0..4], &mask_key);
    index += 4;

    try writer.writeAll(header[0..index]);

    var offset: usize = 0;
    var chunk: [4096]u8 = undefined;
    while (offset < payload.len) {
        const chunk_len = @min(chunk.len, payload.len - offset);
        for (payload[offset .. offset + chunk_len], 0..) |byte, chunk_index| {
            chunk[chunk_index] = byte ^ mask_key[(offset + chunk_index) % mask_key.len];
        }
        try writer.writeAll(chunk[0..chunk_len]);
        offset += chunk_len;
    }
}

pub fn acceptKey(key_b64: []const u8) [std.base64.standard.Encoder.calcSize(std.crypto.hash.Sha1.digest_length)]u8 {
    var sha1 = std.crypto.hash.Sha1.init(.{});
    sha1.update(key_b64);
    sha1.update(magic);

    var digest: [std.crypto.hash.Sha1.digest_length]u8 = undefined;
    sha1.final(&digest);

    var expected: [std.base64.standard.Encoder.calcSize(digest.len)]u8 = undefined;
    _ = std.base64.standard.Encoder.encode(&expected, &digest);
    return expected;
}

const Opcode = enum(u4) {
    continuation = 0,
    text = 1,
    binary = 2,
    close = 8,
    ping = 9,
    pong = 10,
};

const Frame = struct {
    fin: bool,
    opcode: Opcode,
    payload: []u8,
};

fn readFrameAlloc(allocator: Allocator, reader: *std.Io.Reader, max_message_size: usize) !Frame {
    const first = reader.takeByte() catch return error.ConnectionClosed;
    const second = reader.takeByte() catch return error.ConnectionClosed;

    const fin = (first & 0x80) != 0;
    const rsv = first & 0x70;
    if (rsv != 0) return error.UnsupportedFrame;

    const opcode = parseOpcode(first & 0x0f) orelse return error.UnsupportedFrame;
    const masked = (second & 0x80) != 0;
    if (masked) return error.MaskedServerFrame;

    var payload_len: usize = second & 0x7f;
    if (payload_len == 126) {
        payload_len = try reader.takeInt(u16, .big);
        if (payload_len < 126) return error.NonCanonicalLength;
    } else if (payload_len == 127) {
        const raw_len = try reader.takeInt(u64, .big);
        if ((raw_len & (@as(u64, 1) << 63)) != 0) return error.MessageTooLarge;
        payload_len = std.math.cast(usize, raw_len) orelse return error.MessageTooLarge;
        if (payload_len <= 0xffff) return error.NonCanonicalLength;
    }

    if (isControl(opcode)) {
        if (!fin) return error.FragmentedControlFrame;
        if (payload_len > 125) return error.ControlFrameTooLarge;
    }
    if (payload_len > max_message_size) return error.MessageTooLarge;

    const payload = try reader.readAlloc(allocator, payload_len);
    errdefer allocator.free(payload);
    if (opcode == .close) try validateClosePayload(payload);

    return .{
        .fin = fin,
        .opcode = opcode,
        .payload = payload,
    };
}

fn appendChecked(list: *ByteList, bytes: []const u8, max_message_size: usize) !void {
    if (bytes.len > max_message_size - list.items.len) return error.MessageTooLarge;
    try list.appendSlice(bytes);
}

fn messageKind(opcode: Opcode) MessageKind {
    return switch (opcode) {
        .text => .text,
        .binary => .binary,
        .close => .close,
        .ping => .ping,
        .pong => .pong,
        .continuation => unreachable,
    };
}

fn opcodeForMessage(kind: MessageKind) Opcode {
    return switch (kind) {
        .text => .text,
        .binary => .binary,
        .close => .close,
        .ping => .ping,
        .pong => .pong,
    };
}

fn isControl(opcode: Opcode) bool {
    return switch (opcode) {
        .close, .ping, .pong => true,
        .continuation, .text, .binary => false,
    };
}

fn parseOpcode(value: u8) ?Opcode {
    return switch (value) {
        0 => .continuation,
        1 => .text,
        2 => .binary,
        8 => .close,
        9 => .ping,
        10 => .pong,
        else => null,
    };
}

fn validateClosePayload(payload: []const u8) !void {
    if (payload.len == 0) return;
    if (payload.len == 1) return error.InvalidCloseFrame;

    const code = std.mem.readInt(u16, payload[0..2], .big);
    if (!isValidCloseCode(code)) return error.InvalidCloseCode;
    if (!std.unicode.utf8ValidateSlice(payload[2..])) return error.InvalidCloseReason;
}

fn isValidCloseCode(code: u16) bool {
    return switch (code) {
        1000...1003, 1007...1014 => true,
        3000...4999 => true,
        else => false,
    };
}

test "acceptKey matches RFC example" {
    const actual = acceptKey("dGhlIHNhbXBsZSBub25jZQ==");
    try std.testing.expectEqualStrings("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", &actual);
}

test "writeClientFrame masks text payload" {
    var out: [64]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&out);

    try writeClientFrame(&writer, .text, "Hi", .{ 1, 2, 3, 4 });

    const bytes = writer.buffered();
    try std.testing.expectEqualSlices(u8, &.{ 0x81, 0x82, 1, 2, 3, 4, 'H' ^ 1, 'i' ^ 2 }, bytes);
}

test "readMessageAlloc rejects oversized payload" {
    var input = [_]u8{ 0x81, 126, 0x04, 0x00 };
    var reader: std.Io.Reader = .fixed(&input);
    var codec = Codec.init(std.testing.allocator, .{ .max_message_size = 32 });
    defer codec.deinit();

    try std.testing.expectError(error.MessageTooLarge, codec.readMessageAlloc(&reader));
}

test "readMessageAlloc rejects masked server frame" {
    var input = [_]u8{ 0x81, 0x80, 1, 2, 3, 4 };
    var reader: std.Io.Reader = .fixed(&input);
    var codec = Codec.init(std.testing.allocator, .{});
    defer codec.deinit();

    try std.testing.expectError(error.MaskedServerFrame, codec.readMessageAlloc(&reader));
}

test "readMessageAlloc rejects compressed or reserved frame bits" {
    var input = [_]u8{ 0xc1, 0x00 };
    var reader: std.Io.Reader = .fixed(&input);
    var codec = Codec.init(std.testing.allocator, .{});
    defer codec.deinit();

    try std.testing.expectError(error.UnsupportedFrame, codec.readMessageAlloc(&reader));
}

test "readMessageAlloc rejects fragmented control frame" {
    var input = [_]u8{ 0x09, 0x00 };
    var reader: std.Io.Reader = .fixed(&input);
    var codec = Codec.init(std.testing.allocator, .{});
    defer codec.deinit();

    try std.testing.expectError(error.FragmentedControlFrame, codec.readMessageAlloc(&reader));
}

test "readMessageAlloc rejects non-canonical extended length" {
    var input = [_]u8{ 0x81, 126, 0x00, 0x7d };
    var reader: std.Io.Reader = .fixed(&input);
    var codec = Codec.init(std.testing.allocator, .{});
    defer codec.deinit();

    try std.testing.expectError(error.NonCanonicalLength, codec.readMessageAlloc(&reader));
}

test "readMessageAlloc rejects invalid close payloads" {
    {
        var input = [_]u8{ 0x88, 0x01, 0x03 };
        var reader: std.Io.Reader = .fixed(&input);
        var codec = Codec.init(std.testing.allocator, .{});
        defer codec.deinit();

        try std.testing.expectError(error.InvalidCloseFrame, codec.readMessageAlloc(&reader));
    }

    {
        var input = [_]u8{ 0x88, 0x02, 0x03, 0xee };
        var reader: std.Io.Reader = .fixed(&input);
        var codec = Codec.init(std.testing.allocator, .{});
        defer codec.deinit();

        try std.testing.expectError(error.InvalidCloseCode, codec.readMessageAlloc(&reader));
    }

    {
        var input = [_]u8{ 0x88, 0x03, 0x03, 0xe8, 0xff };
        var reader: std.Io.Reader = .fixed(&input);
        var codec = Codec.init(std.testing.allocator, .{});
        defer codec.deinit();

        try std.testing.expectError(error.InvalidCloseReason, codec.readMessageAlloc(&reader));
    }
}

test "readMessageAlloc combines fragmented text with interleaved ping" {
    const input = [_]u8{
        0x01, 0x02, 'h', 'e',
        0x89, 0x01, '?', 0x80,
        0x03, 'l',  'l', 'o',
    };
    var reader: std.Io.Reader = .fixed(&input);
    var codec = Codec.init(std.testing.allocator, .{});
    defer codec.deinit();

    const ping = try codec.readMessageAlloc(&reader);
    defer std.testing.allocator.free(ping.payload);
    try std.testing.expectEqual(MessageKind.ping, ping.kind);
    try std.testing.expectEqualStrings("?", ping.payload);

    const text = try codec.readMessageAlloc(&reader);
    defer std.testing.allocator.free(text.payload);
    try std.testing.expectEqual(MessageKind.text, text.kind);
    try std.testing.expectEqualStrings("hello", text.payload);
}
