const c = @cImport({
    @cDefine("_WIN32_WINNT", "0x0A00");
    @cInclude("windows.h");
});

pub const RawTerminal = struct {
    input_handle: c.HANDLE,
    input_mode: c.DWORD,
    output_handle: c.HANDLE,
    output_mode: c.DWORD,
    output_mode_active: bool,

    pub fn enter() !RawTerminal {
        const input_handle = c.GetStdHandle(c.STD_INPUT_HANDLE);
        if (input_handle == null or input_handle == c.INVALID_HANDLE_VALUE) return error.TerminalState;

        var input_mode: c.DWORD = 0;
        if (c.GetConsoleMode(input_handle, &input_mode) == 0) return error.TerminalState;

        var raw_mode = input_mode;
        raw_mode &= ~@as(c.DWORD, c.ENABLE_ECHO_INPUT);
        raw_mode &= ~@as(c.DWORD, c.ENABLE_LINE_INPUT);
        raw_mode &= ~@as(c.DWORD, c.ENABLE_PROCESSED_INPUT);
        if (c.SetConsoleMode(input_handle, raw_mode) == 0) return error.TerminalState;

        const output_handle = c.GetStdHandle(c.STD_OUTPUT_HANDLE);
        var output_mode: c.DWORD = 0;
        var output_mode_active = false;
        if (output_handle != null and output_handle != c.INVALID_HANDLE_VALUE and c.GetConsoleMode(output_handle, &output_mode) != 0) {
            const vt_mode = output_mode |
                @as(c.DWORD, c.ENABLE_PROCESSED_OUTPUT) |
                @as(c.DWORD, c.ENABLE_VIRTUAL_TERMINAL_PROCESSING);
            output_mode_active = c.SetConsoleMode(output_handle, vt_mode) != 0;
        }

        return .{
            .input_handle = input_handle,
            .input_mode = input_mode,
            .output_handle = output_handle,
            .output_mode = output_mode,
            .output_mode_active = output_mode_active,
        };
    }

    pub fn leave(self: *const RawTerminal) void {
        _ = c.SetConsoleMode(self.input_handle, self.input_mode);
        if (self.output_mode_active) {
            _ = c.SetConsoleMode(self.output_handle, self.output_mode);
        }
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
