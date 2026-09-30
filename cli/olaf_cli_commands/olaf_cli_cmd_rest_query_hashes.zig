const std = @import("std");
const Io = std.Io;
const olaf_cli_rest_client = @import("../olaf_cli_rest_client.zig");
const olaf_cli_util = @import("../olaf_cli_util.zig");
const types = @import("../olaf_cli_types.zig");

pub const CommandInfo = struct {
    pub const name = "rest query-hashes";
    pub const description = "Match fingerprints a client already extracted (for example the browser module) against an olaf rest serve endpoint. The fingerprints JSON is read from stdin: {\"fingerprints\":[{\"t1\":<int>,\"hash\":<int>}]}; it prints what 'olaf query' does.";
    pub const options = &[_]types.Option{
        .{ .name = "url", .text = "The endpoint, e.g. http://127.0.0.1:8920 (default: the olaf rest serve on config rest_listen)." },
        .{ .name = "--format <csv|json>", .text = "Output format (default: csv)." },
    };
    pub const help = "[url] [--format <csv|json>]   (fingerprints JSON on stdin)";
    pub const needs_audio_files = false;
    pub const accepts_endpoint = true;
    pub const flags = &[_]types.Flag{ .format };
};

pub fn execute(allocator: std.mem.Allocator, args: *types.Args) !void {
    if (args.format == .human) {
        olaf_cli_util.print("query output has no human format; use --format csv or json.\n", .{});
        return error.Usage;
    }

    const config = args.config.?;
    const url = try olaf_cli_rest_client.endpointUrl(allocator, args, config);
    defer allocator.free(url);

    var arena_state = std.heap.ArenaAllocator.init(allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    // The fingerprints are the request body: read them all from stdin (bounded by rest_max_body_mb).
    const max_body = @as(usize, config.rest_max_body_mb) * 1024 * 1024;
    const body = readStdin(args.io, arena, max_body) catch |err| {
        olaf_cli_util.print("cannot read fingerprints JSON from stdin: {}\n", .{err});
        return error.Usage;
    };

    try olaf_cli_rest_client.runHashes(allocator, args, url, body);
}

/// Read all of `stdin` into an arena-allocated buffer (at most `max_bytes`).
fn readStdin(io: Io, allocator: std.mem.Allocator, max_bytes: usize) ![]const u8 {
    var buf: [16 * 1024]u8 = undefined;
    // `var` (not const): allocRemaining takes a non-const pointer to the Reader.
    var reader = Io.File.stdin().reader(io, &buf);
    return try reader.interface.allocRemaining(allocator, .limited(max_bytes));
}
