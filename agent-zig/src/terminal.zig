const builtin = @import("builtin");

const impl = if (builtin.os.tag == .windows)
    @import("terminal_windows.zig")
else
    @import("terminal_unix.zig");

pub const RawTerminal = impl.RawTerminal;
pub const TerminalSize = impl.TerminalSize;
pub const getTerminalSize = impl.getTerminalSize;
