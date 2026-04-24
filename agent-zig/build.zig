const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const LinuxTransport = enum {
        system,
        portable,
    };
    const linux_transport = b.option(LinuxTransport, "linux_transport", "Linux transport implementation: system or portable") orelse .portable;
    const options = b.addOptions();
    options.addOption(LinuxTransport, "linux_transport", linux_transport);

    const exe = b.addExecutable(.{
        .name = "ttys-agent-zig",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = .ReleaseSmall,
            .strip = true,
            .link_libc = true,
        }),
    });
    exe.root_module.addOptions("build_options", options);

    switch (target.result.os.tag) {
        .linux => {
            exe.root_module.linkSystemLibrary("util", .{});
            if (linux_transport == .system) {
                exe.root_module.linkSystemLibrary("curl", .{});
            }
        },
        .macos => exe.root_module.linkSystemLibrary("curl", .{}),
        .windows => exe.root_module.linkSystemLibrary("winhttp", .{}),
        else => {},
    }

    b.installArtifact(exe);

    const run_cmd = b.addRunArtifact(exe);
    if (b.args) |args| run_cmd.addArgs(args);

    const run_step = b.step("run", "Run the Zig agent prototype");
    run_step.dependOn(&run_cmd.step);
}
