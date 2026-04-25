const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});

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

    switch (target.result.os.tag) {
        .linux => exe.root_module.linkSystemLibrary("util", .{}),
        .windows => exe.root_module.linkSystemLibrary("winhttp", .{}),
        else => {},
    }

    b.installArtifact(exe);

    const run_cmd = b.addRunArtifact(exe);
    if (b.args) |args| run_cmd.addArgs(args);

    const run_step = b.step("run", "Run the Zig agent prototype");
    run_step.dependOn(&run_cmd.step);

    const main_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = .Debug,
            .link_libc = true,
        }),
    });

    switch (target.result.os.tag) {
        .linux => main_tests.root_module.linkSystemLibrary("util", .{}),
        .windows => main_tests.root_module.linkSystemLibrary("winhttp", .{}),
        else => {},
    }

    const run_main_tests = b.addRunArtifact(main_tests);

    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&run_main_tests.step);
}
