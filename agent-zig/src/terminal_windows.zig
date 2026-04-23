const c = @cImport({
    @cDefine("_WIN32_WINNT", "0x0A00");
    @cInclude("windows.h");
});

pub const RawTerminal = struct {
    handle: c.HANDLE,
    mode: c.DWORD,

    pub fn enter() !RawTerminal {
        const handle = c.GetStdHandle(c.STD_INPUT_HANDLE);
        if (handle == null or handle == c.INVALID_HANDLE_VALUE) return error.TerminalState;

        var mode: c.DWORD = 0;
        if (c.GetConsoleMode(handle, &mode) == 0) return error.TerminalState;

        var raw_mode = mode;
        raw_mode &= ~@as(c.DWORD, c.ENABLE_ECHO_INPUT);
        raw_mode &= ~@as(c.DWORD, c.ENABLE_LINE_INPUT);
        raw_mode &= ~@as(c.DWORD, c.ENABLE_PROCESSED_INPUT);
        if (c.SetConsoleMode(handle, raw_mode) == 0) return error.TerminalState;

        return .{
            .handle = handle,
            .mode = mode,
        };
    }

    pub fn leave(self: *const RawTerminal) void {
        _ = c.SetConsoleMode(self.handle, self.mode);
    }
};

pub const TerminalSize = struct {
    cols: u16,
    rows: u16,
};

pub fn getTerminalSize() !TerminalSize {
    const handle = c.GetStdHandle(c.STD_OUTPUT_HANDLE);
    if (handle == null or handle == c.INVALID_HANDLE_VALUE) return error.TerminalSize;

    var info: c.CONSOLE_SCREEN_BUFFER_INFO = undefined;
    if (c.GetConsoleScreenBufferInfo(handle, &info) == 0) return error.TerminalSize;

    return .{
        .cols = @intCast(info.srWindow.Right - info.srWindow.Left + 1),
        .rows = @intCast(info.srWindow.Bottom - info.srWindow.Top + 1),
    };
}
