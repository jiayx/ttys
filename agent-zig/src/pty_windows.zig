const std = @import("std");

const c = @cImport({
    @cDefine("_WIN32_WINNT", "0x0A00");
    @cInclude("windows.h");
});

const proc_thread_attribute_pseudo_console = 0x00020016;
const extended_startup_info_present = 0x00080000;

pub const PTY = struct {
    input: c.HANDLE,
    output: c.HANDLE,
    process: c.HANDLE,
    thread: c.HANDLE,
    console: c.HPCON,

    pub fn spawn(shell: []const u8) !PTY {
        const in_pair = try createPipePair();
        errdefer closeIfValid(in_pair.read_handle);
        errdefer closeIfValid(in_pair.write_handle);

        const out_pair = try createPipePair();
        errdefer closeIfValid(out_pair.read_handle);
        errdefer closeIfValid(out_pair.write_handle);

        const console = try createPseudoConsole(in_pair.read_handle, out_pair.write_handle);
        errdefer _ = c.ClosePseudoConsole(console);

        var attr_storage = try AttributeList.init(console);
        defer attr_storage.deinit();

        var si_ex: c.STARTUPINFOEXW = std.mem.zeroInit(c.STARTUPINFOEXW, .{});
        si_ex.StartupInfo.cb = @sizeOf(c.STARTUPINFOEXW);
        si_ex.lpAttributeList = attr_storage.list;

        const shell_w = try std.unicode.utf8ToUtf16LeAllocZ(std.heap.c_allocator, shell);
        defer std.heap.c_allocator.free(shell_w);

        const cmdline = try buildCommandLine(shell_w);
        defer std.heap.c_allocator.free(cmdline);

        var pi: c.PROCESS_INFORMATION = std.mem.zeroInit(c.PROCESS_INFORMATION, .{});
        if (c.CreateProcessW(
            null,
            cmdline.ptr,
            null,
            null,
            c.FALSE,
            extended_startup_info_present,
            null,
            null,
            &si_ex.StartupInfo,
            &pi,
        ) == 0) return error.CreateProcessFailed;

        closeIfValid(in_pair.read_handle);
        closeIfValid(out_pair.write_handle);

        return .{
            .input = in_pair.write_handle,
            .output = out_pair.read_handle,
            .process = pi.hProcess,
            .thread = pi.hThread,
            .console = console,
        };
    }

    pub fn close(self: *const PTY) void {
        closeIfValid(self.input);
        closeIfValid(self.output);
        closeIfValid(self.thread);
        closeIfValid(self.process);
        c.ClosePseudoConsole(self.console);
    }

    pub fn read(self: *const PTY, buf: []u8) !usize {
        var read_count: c.DWORD = 0;
        if (c.ReadFile(self.output, buf.ptr, @intCast(buf.len), &read_count, null) == 0) {
            if (c.GetLastError() == c.ERROR_OPERATION_ABORTED) return error.Interrupted;
            return error.PTYReadFailed;
        }
        return @intCast(read_count);
    }

    pub fn write(self: *const PTY, buf: []const u8) !usize {
        var written: c.DWORD = 0;
        if (c.WriteFile(self.input, buf.ptr, @intCast(buf.len), &written, null) == 0) {
            if (c.GetLastError() == c.ERROR_OPERATION_ABORTED) return error.Interrupted;
            return error.PTYWriteFailed;
        }
        return @intCast(written);
    }

    pub fn resize(self: *const PTY, cols: u16, rows: u16) void {
        const size: c.COORD = .{ .X = @intCast(cols), .Y = @intCast(rows) };
        _ = c.ResizePseudoConsole(self.console, size);
    }

    pub fn wait(self: *const PTY) !void {
        _ = c.WaitForSingleObject(self.process, c.INFINITE);

        var exit_code: c.DWORD = 0;
        if (c.GetExitCodeProcess(self.process, &exit_code) == 0) return error.WaitProcessFailed;
        if (exit_code != 0) return error.ProcessExitedNonZero;
    }
};

const PipePair = struct {
    read_handle: c.HANDLE,
    write_handle: c.HANDLE,
};

const AttributeList = struct {
    list: c.LPPROC_THREAD_ATTRIBUTE_LIST,
    buffer: []u8,

    fn init(console: c.HPCON) !AttributeList {
        var size: usize = 0;
        _ = c.InitializeProcThreadAttributeList(null, 1, 0, &size);

        const buffer = try std.heap.c_allocator.alloc(u8, size);
        errdefer std.heap.c_allocator.free(buffer);

        const list: c.LPPROC_THREAD_ATTRIBUTE_LIST = @ptrCast(@alignCast(buffer.ptr));
        if (c.InitializeProcThreadAttributeList(list, 1, 0, &size) == 0) return error.AttributeListInitFailed;
        errdefer c.DeleteProcThreadAttributeList(list);

        if (c.UpdateProcThreadAttribute(
            list,
            0,
            proc_thread_attribute_pseudo_console,
            console,
            @sizeOf(c.HPCON),
            null,
            null,
        ) == 0) return error.AttributeListUpdateFailed;

        return .{
            .list = list,
            .buffer = buffer,
        };
    }

    fn deinit(self: *AttributeList) void {
        if (self.list) |list| c.DeleteProcThreadAttributeList(list);
        std.heap.c_allocator.free(self.buffer);
    }
};

fn createPipePair() !PipePair {
    var read_handle: c.HANDLE = null;
    var write_handle: c.HANDLE = null;
    if (c.CreatePipe(&read_handle, &write_handle, null, 0) == 0) return error.CreatePipeFailed;
    return .{
        .read_handle = read_handle,
        .write_handle = write_handle,
    };
}

fn createPseudoConsole(input_read: c.HANDLE, output_write: c.HANDLE) !c.HPCON {
    const size: c.COORD = .{ .X = 120, .Y = 30 };
    var console: c.HPCON = null;
    const hr = c.CreatePseudoConsole(size, input_read, output_write, 0, &console);
    if (hr != c.S_OK) return error.CreatePseudoConsoleFailed;
    return console;
}

fn closeIfValid(handle: c.HANDLE) void {
    if (handle != null and handle != c.INVALID_HANDLE_VALUE) {
        _ = c.CloseHandle(handle);
    }
}

fn buildCommandLine(shell_w: []u16) ![:0]u16 {
    var list = std.array_list.Managed(u16).init(std.heap.c_allocator);
    errdefer list.deinit();

    try appendQuoted(&list, shell_w);
    try list.append(0);
    return try list.toOwnedSliceSentinel(0);
}

fn appendQuoted(list: *std.array_list.Managed(u16), value: []const u16) !void {
    try list.append('"');
    try list.appendSlice(value);
    try list.append('"');
}
