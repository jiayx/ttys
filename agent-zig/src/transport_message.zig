pub const Kind = enum {
    text,
    binary,
};

pub const Message = struct {
    kind: Kind,
    payload: []u8,
};

pub const BinaryType = enum(u8) {
    tty_output = 0x01,
    stdin = 0x02,
};

pub fn binaryTypeByte(kind: BinaryType) u8 {
    return @intFromEnum(kind);
}

pub fn wrapBinary(allocator: @import("std").mem.Allocator, kind: BinaryType, payload: []const u8) ![]u8 {
    const out = try allocator.alloc(u8, payload.len + 1);
    out[0] = binaryTypeByte(kind);
    @memcpy(out[1..], payload);
    return out;
}

pub fn unwrapBinary(payload: []const u8) !struct {
    kind: BinaryType,
    data: []const u8,
} {
    if (payload.len == 0) return error.EmptyBinaryMessage;
    return .{
        .kind = switch (payload[0]) {
            binaryTypeByte(.tty_output) => .tty_output,
            binaryTypeByte(.stdin) => .stdin,
            else => return error.UnknownBinaryMessageType,
        },
        .data = payload[1..],
    };
}
