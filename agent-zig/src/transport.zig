const builtin = @import("builtin");
const build_options = @import("build_options");

const impl = switch (builtin.os.tag) {
    .windows => @import("transport_windows.zig"),
    .linux => switch (build_options.linux_transport) {
        .system => @import("transport_unix.zig"),
        .portable => @import("transport_linux_portable.zig"),
    },
    else => @import("transport_unix.zig"),
};

pub const WebSocketClient = impl.WebSocketClient;
pub const globalInit = impl.globalInit;
pub const globalDeinit = impl.globalDeinit;
