import { closeSync, constants, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { discoverMinerGoalSpecPath, parseMinerGoalSpecContent } from "@loopover/engine";
const MAX_MINER_GOAL_SPEC_BYTES = 32_768;
// Same convention as packages/loopover-mcp/bin/loopover-mcp.js's readCliTextFile: O_NOFOLLOW on open
// atomically rejects a symlinked path (no separate pre-open lstat -- that would be a check-then-open race, since
// a symlink can be swapped in between the lstat and the open). Bounds the READ itself, not just fstat's
// reported size, since a regular file can still grow between fstatSync and the read below.
function readRegularUtf8File(path, options) {
    const openImpl = options.openSync ?? openSync;
    const fstatImpl = options.fstatSync ?? fstatSync;
    const readImpl = options.readSync ?? readSync;
    const closeImpl = options.closeSync ?? closeSync;
    const fd = openImpl(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stats = fstatImpl(fd);
        if (!stats.isFile() || stats.size > MAX_MINER_GOAL_SPEC_BYTES)
            return null;
        const buffer = Buffer.alloc(MAX_MINER_GOAL_SPEC_BYTES + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
            const n = readImpl(fd, buffer, bytesRead, buffer.length - bytesRead, null);
            if (n === 0)
                break;
            bytesRead += n;
        }
        if (bytesRead > MAX_MINER_GOAL_SPEC_BYTES)
            return null;
        return buffer.subarray(0, bytesRead).toString("utf8");
    }
    finally {
        closeImpl(fd);
    }
}
/**
 * Resolve the real, parsed MinerGoalSpec for an already-cloned repo at `repoPath`, trying each
 * MINER_GOAL_SPEC_FILENAMES candidate in the documented discovery order. Never throws: a missing file, an
 * unreadable file, or malformed content all degrade to the tolerant parser's own absent/safe-default result.
 *
 * Injected filesystem operations receive the FULL joined path (same convention as `node:fs`'s own
 * functions), not a repoPath-relative candidate.
 */
export function resolveMinerGoalSpec(repoPath, options = {}) {
    const existsImpl = options.existsSync ?? existsSync;
    const relativePath = discoverMinerGoalSpecPath((candidate) => existsImpl(join(repoPath, candidate)));
    if (!relativePath)
        return parseMinerGoalSpecContent(null);
    try {
        const content = readRegularUtf8File(join(repoPath, relativePath), options);
        return parseMinerGoalSpecContent(content);
    }
    catch {
        return parseMinerGoalSpecContent(null);
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWluZXItZ29hbC1zcGVjLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibWluZXItZ29hbC1zcGVjLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sRUFBRSxTQUFTLEVBQUUsU0FBUyxFQUFFLFVBQVUsRUFBRSxTQUFTLEVBQUUsUUFBUSxFQUFFLFFBQVEsRUFBYyxNQUFNLFNBQVMsQ0FBQztBQUN0RyxPQUFPLEVBQUUsSUFBSSxFQUFFLE1BQU0sV0FBVyxDQUFDO0FBQ2pDLE9BQU8sRUFBRSx5QkFBeUIsRUFBRSx5QkFBeUIsRUFBNEIsTUFBTSxrQkFBa0IsQ0FBQztBQUVsSCxNQUFNLHlCQUF5QixHQUFHLE1BQU0sQ0FBQztBQWtCekMscUdBQXFHO0FBQ3JHLGlIQUFpSDtBQUNqSCx3R0FBd0c7QUFDeEcsMkZBQTJGO0FBQzNGLFNBQVMsbUJBQW1CLENBQUMsSUFBWSxFQUFFLE9BQW9DO0lBQzdFLE1BQU0sUUFBUSxHQUFHLE9BQU8sQ0FBQyxRQUFRLElBQUksUUFBUSxDQUFDO0lBQzlDLE1BQU0sU0FBUyxHQUFHLE9BQU8sQ0FBQyxTQUFTLElBQUksU0FBUyxDQUFDO0lBQ2pELE1BQU0sUUFBUSxHQUFHLE9BQU8sQ0FBQyxRQUFRLElBQUksUUFBUSxDQUFDO0lBQzlDLE1BQU0sU0FBUyxHQUFHLE9BQU8sQ0FBQyxTQUFTLElBQUksU0FBUyxDQUFDO0lBRWpELE1BQU0sRUFBRSxHQUFHLFFBQVEsQ0FBQyxJQUFJLEVBQUUsU0FBUyxDQUFDLFFBQVEsR0FBRyxTQUFTLENBQUMsVUFBVSxDQUFDLENBQUM7SUFDckUsSUFBSSxDQUFDO1FBQ0gsTUFBTSxLQUFLLEdBQUcsU0FBUyxDQUFDLEVBQUUsQ0FBQyxDQUFDO1FBQzVCLElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxFQUFFLElBQUksS0FBSyxDQUFDLElBQUksR0FBRyx5QkFBeUI7WUFBRSxPQUFPLElBQUksQ0FBQztRQUMzRSxNQUFNLE1BQU0sR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDLHlCQUF5QixHQUFHLENBQUMsQ0FBQyxDQUFDO1FBQzNELElBQUksU0FBUyxHQUFHLENBQUMsQ0FBQztRQUNsQixPQUFPLFNBQVMsR0FBRyxNQUFNLENBQUMsTUFBTSxFQUFFLENBQUM7WUFDakMsTUFBTSxDQUFDLEdBQUcsUUFBUSxDQUFDLEVBQUUsRUFBRSxNQUFNLEVBQUUsU0FBUyxFQUFFLE1BQU0sQ0FBQyxNQUFNLEdBQUcsU0FBUyxFQUFFLElBQUksQ0FBQyxDQUFDO1lBQzNFLElBQUksQ0FBQyxLQUFLLENBQUM7Z0JBQUUsTUFBTTtZQUNuQixTQUFTLElBQUksQ0FBQyxDQUFDO1FBQ2pCLENBQUM7UUFDRCxJQUFJLFNBQVMsR0FBRyx5QkFBeUI7WUFBRSxPQUFPLElBQUksQ0FBQztRQUN2RCxPQUFPLE1BQU0sQ0FBQyxRQUFRLENBQUMsQ0FBQyxFQUFFLFNBQVMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUN4RCxDQUFDO1lBQVMsQ0FBQztRQUNULFNBQVMsQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUNoQixDQUFDO0FBQ0gsQ0FBQztBQUVEOzs7Ozs7O0dBT0c7QUFDSCxNQUFNLFVBQVUsb0JBQW9CLENBQUMsUUFBZ0IsRUFBRSxVQUF1QyxFQUFFO0lBQzlGLE1BQU0sVUFBVSxHQUFHLE9BQU8sQ0FBQyxVQUFVLElBQUksVUFBVSxDQUFDO0lBRXBELE1BQU0sWUFBWSxHQUFHLHlCQUF5QixDQUFDLENBQUMsU0FBUyxFQUFFLEVBQUUsQ0FBQyxVQUFVLENBQUMsSUFBSSxDQUFDLFFBQVEsRUFBRSxTQUFTLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDckcsSUFBSSxDQUFDLFlBQVk7UUFBRSxPQUFPLHlCQUF5QixDQUFDLElBQUksQ0FBQyxDQUFDO0lBRTFELElBQUksQ0FBQztRQUNILE1BQU0sT0FBTyxHQUFHLG1CQUFtQixDQUFDLElBQUksQ0FBQyxRQUFRLEVBQUUsWUFBWSxDQUFDLEVBQUUsT0FBTyxDQUFDLENBQUM7UUFDM0UsT0FBTyx5QkFBeUIsQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUM1QyxDQUFDO0lBQUMsTUFBTSxDQUFDO1FBQ1AsT0FBTyx5QkFBeUIsQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUN6QyxDQUFDO0FBQ0gsQ0FBQyJ9