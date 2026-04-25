const builtin = @import("builtin");

const impl = switch (builtin.os.tag) {
    .windows => @import("transport_windows.zig"),
    else => @import("transport_zig.zig"),
};

pub const WebSocketClient = impl.WebSocketClient;
pub const globalInit = impl.globalInit;
pub const globalDeinit = impl.globalDeinit;
