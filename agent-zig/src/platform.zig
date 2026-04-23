const builtin = @import("builtin");

const impl = if (builtin.os.tag == .windows)
    @import("platform_windows.zig")
else
    @import("platform_unix.zig");

pub const defaultShell = impl.defaultShell;
