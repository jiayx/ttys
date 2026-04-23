const c = @cImport({
    @cInclude("sys/ioctl.h");
    @cInclude("termios.h");
});

pub const RawTerminal = struct {
    state: c.termios,

    pub fn enter() !RawTerminal {
        var state: c.termios = undefined;
        if (c.tcgetattr(0, &state) != 0) return error.TerminalState;

        var raw = state;
        c.cfmakeraw(&raw);
        if (c.tcsetattr(0, c.TCSANOW, &raw) != 0) return error.TerminalState;

        return .{ .state = state };
    }

    pub fn leave(self: *const RawTerminal) void {
        _ = c.tcsetattr(0, c.TCSANOW, &self.state);
    }
};

pub const TerminalSize = struct {
    cols: u16,
    rows: u16,
};

pub fn getTerminalSize() !TerminalSize {
    var winsize: c.winsize = undefined;
    if (c.ioctl(0, c.TIOCGWINSZ, &winsize) != 0) return error.TerminalSize;
    return .{
        .cols = winsize.ws_col,
        .rows = winsize.ws_row,
    };
}
