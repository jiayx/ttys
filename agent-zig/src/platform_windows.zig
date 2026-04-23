const std = @import("std");
const c = @cImport({
    @cDefine("_WIN32_WINNT", "0x0A00");
    @cInclude("windows.h");
});

pub fn defaultShell() []const u8 {
    const candidates = [_]struct {
        utf8: []const u8,
        utf16: [:0]const u16,
    }{
        .{
            .utf8 = "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
            .utf16 = std.unicode.utf8ToUtf16LeStringLiteral("C:\\Program Files\\PowerShell\\7\\pwsh.exe"),
        },
        .{
            .utf8 = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            .utf16 = std.unicode.utf8ToUtf16LeStringLiteral("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"),
        },
        .{
            .utf8 = "C:\\Windows\\System32\\cmd.exe",
            .utf16 = std.unicode.utf8ToUtf16LeStringLiteral("C:\\Windows\\System32\\cmd.exe"),
        },
    };

    for (candidates) |candidate| {
        if (c.GetFileAttributesW(candidate.utf16.ptr) != c.INVALID_FILE_ATTRIBUTES) {
            return candidate.utf8;
        }
    }

    return "cmd.exe";
}
