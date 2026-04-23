const std = @import("std");
const builtin = @import("builtin");

const c = if (builtin.os.tag == .linux) @cImport({
    @cInclude("pty.h");
    @cInclude("stdlib.h");
    @cInclude("sys/ioctl.h");
    @cInclude("sys/wait.h");
    @cInclude("unistd.h");
}) else @cImport({
    @cInclude("stdlib.h");
    @cInclude("sys/ioctl.h");
    @cInclude("sys/wait.h");
    @cInclude("unistd.h");
    @cInclude("util.h");
});

extern "c" var environ: [*:null]?[*:0]u8;

pub const PTY = struct {
    master_fd: c_int,
    child_pid: c.pid_t,

    pub fn spawn(shell: []const u8) !PTY {
        var master_fd: c_int = -1;
        const pid = c.forkpty(&master_fd, null, null, null);
        if (pid < 0) return error.ForkPTYFailed;

        if (pid == 0) {
            const shell_z = std.heap.c_allocator.dupeZ(u8, shell) catch c._exit(127);
            defer std.heap.c_allocator.free(shell_z);

            const envp = buildEnvp() catch c._exit(127);
            defer freeEnvp(envp);

            var argv = [_:null]?[*c]u8{ @constCast(shell_z.ptr), null };
            _ = c.execve(shell_z.ptr, @ptrCast(&argv), envp.items.ptr);
            _ = c.execvp(shell_z.ptr, @ptrCast(&argv));
            c._exit(127);
        }

        return .{
            .master_fd = master_fd,
            .child_pid = pid,
        };
    }

    pub fn close(self: *const PTY) void {
        _ = c.close(self.master_fd);
    }

    pub fn read(self: *const PTY, buf: []u8) isize {
        return c.read(self.master_fd, buf.ptr, buf.len);
    }

    pub fn write(self: *const PTY, buf: []const u8) isize {
        return c.write(self.master_fd, buf.ptr, buf.len);
    }

    pub fn resize(self: *const PTY, cols: u16, rows: u16) void {
        var winsize = c.winsize{
            .ws_row = rows,
            .ws_col = cols,
            .ws_xpixel = 0,
            .ws_ypixel = 0,
        };
        _ = c.ioctl(self.master_fd, c.TIOCSWINSZ, &winsize);
    }

    pub fn wait(self: *const PTY) !void {
        var status: c_int = 0;
        if (c.waitpid(self.child_pid, &status, 0) < 0) return error.WaitPidFailed;
    }
};

fn buildEnvp() !std.array_list.Managed(?[*:0]u8) {
    var envp = std.array_list.Managed(?[*:0]u8).init(std.heap.c_allocator);
    errdefer {
        for (envp.items) |entry| {
            if (entry) |ptr| std.heap.c_allocator.free(std.mem.span(ptr));
        }
        envp.deinit();
    }

    var current = environ;
    while (current[0] != null) : (current += 1) {
        const value = std.mem.span(current[0].?);
        const z = try std.heap.c_allocator.dupeZ(u8, value);
        try envp.append(z.ptr);
    }
    try envp.append(null);
    return envp;
}

fn freeEnvp(envp: std.array_list.Managed(?[*:0]u8)) void {
    for (envp.items) |entry| {
        if (entry) |ptr| std.heap.c_allocator.free(std.mem.span(ptr));
    }
    var owned = envp;
    owned.deinit();
}
