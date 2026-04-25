const builtin = @import("builtin");

const impl = switch (builtin.os.tag) {
    .windows => @import("transport_windows.zig"),
    else => @import("transport_unix.zig"),
};

pub const WebSocketClient = impl.WebSocketClient;
pub const BinaryType = impl.BinaryType;
pub const globalInit = impl.globalInit;
pub const globalDeinit = impl.globalDeinit;
pub const unwrapBinary = @import("transport_message.zig").unwrapBinary;
