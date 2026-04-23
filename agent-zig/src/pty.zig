const builtin = @import("builtin");

const impl = if (builtin.os.tag == .windows)
    @import("pty_windows.zig")
else
    @import("pty_unix.zig");

pub const PTY = impl.PTY;
