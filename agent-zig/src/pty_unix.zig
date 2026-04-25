const std = @import("std");
const builtin = @import("builtin");

const c = if (builtin.os.tag == .linux) @cImport({
    @cInclude("errno.h");
    @cInclude("pty.h");
    @cInclude("poll.h");
    @cInclude("signal.h");
    @cInclude("stdlib.h");
    @cInclude("sys/ioctl.h");
    @cInclude("sys/wait.h");
    @cInclude("unistd.h");
}) else @cImport({
    @cInclude("errno.h");
    @cInclude("poll.h");
    @cInclude("signal.h");
    @cInclude("stdlib.h");
    @cInclude("sys/ioctl.h");
    @cInclude("sys/wait.h");
    @cInclude("unistd.h");
    @cInclude("util.h");
});

pub const PTY = struct {
    master_fd: c_int,
    child_pid: c.pid_t,

    pub fn spawn(shell: []const u8) !PTY {
        var master_fd: c_int = -1;
        const pid = c.forkpty(&master_fd, null, null, null);
        if (pid < 0) return error.ForkPTYFailed;

        if (pid == 0) {
            _ = c.setenv("TTYS_AGENT_ACTIVE", "1", 1);

            const shell_z = std.heap.c_allocator.dupeZ(u8, shell) catch c._exit(127);
            defer std.heap.c_allocator.free(shell_z);

            var argv = [_:null]?[*:0]u8{ shell_z.ptr, null };
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

    pub fn read(self: *const PTY, buf: []u8) !usize {
        const n = c.read(self.master_fd, buf.ptr, buf.len);
        if (n < 0) {
            if (errno() == c.EINTR) return error.Interrupted;
            // Linux reports EIO on the PTY master when the slave side closes.
            // Treat it like EOF so Ctrl-D / exit ends the session cleanly.
            if (errno() == c.EIO) return 0;
            return error.PTYReadFailed;
        }
        return @intCast(n);
    }

    pub fn write(self: *const PTY, buf: []const u8) !usize {
        const n = c.write(self.master_fd, buf.ptr, buf.len);
        if (n < 0) {
            if (errno() == c.EINTR) return error.Interrupted;
            return error.PTYWriteFailed;
        }
        return @intCast(n);
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
        if (c.WIFEXITED(status)) {
            const code = c.WEXITSTATUS(status);
            if (code != 0) return error.ChildExitedNonZero;
            return;
        }
        if (c.WIFSIGNALED(status)) return error.ChildSignaled;
    }
};

fn errno() c_int {
    return std.posix.system._errno().*;
}
