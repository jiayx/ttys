const std = @import("std");

const c = @cImport({
    @cInclude("stdlib.h");
});

pub fn defaultShell() []const u8 {
    const value = c.getenv("SHELL") orelse return "/bin/sh";
    return std.mem.span(value);
}
