import { spawn } from "node:child_process";
import { addWorktree, removeWorktree, shouldRetainWorktree } from "@loopover/engine";
import { ensureRepoCloned } from "./repo-clone.js";
// Real attempt-worktree preparation (#5132, Wave 3.5 follow-up). Composes ensureRepoCloned (repo-clone.js,
// the missing base-clone-management step) with @loopover/engine's already-built, already-tested
// addWorktree/removeWorktree primitives -- which existed but were never called from this package, so
// `workingDirectory` handed to runIterateLoop was always just an empty directory with no real git repo in
// it. This is the caller that finally exercises them for real.
const DEFAULT_TIMEOUT_MS = 120_000;
/**
 * Real child_process-backed implementation of the engine's WorktreeExecFn contract. Resolves (never
 * rejects) on error/timeout, mirroring coding-agent-construction.js's createRealCliSubprocessSpawn -- a
 * failed `git worktree add`'s stderr is the diagnosable signal, not something to lose to an unhandled
 * rejection.
 */
export function createRealWorktreeExec(timeoutMs = DEFAULT_TIMEOUT_MS) {
    return (cmd, args, opts) => new Promise((resolve) => {
        const child = spawn(cmd, [...args], { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve({ code: null, stdout, stderr: `${stderr}\ntimed_out_after_${timeoutMs}ms`.trim() });
        }, timeoutMs);
        child.stdout?.on("data", (chunk) => {
            stdout += chunk.toString("utf8");
        });
        child.stderr?.on("data", (chunk) => {
            stderr += chunk.toString("utf8");
        });
        child.on("error", (err) => {
            clearTimeout(timer);
            resolve({ code: null, stdout, stderr: err.message });
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
    });
}
/**
 * Prepare a real, isolated git worktree for one attempt: ensure the target repo's base clone exists and is
 * current, then create a fresh `git worktree` off it on a deterministically-named branch. Fails closed
 * (`ok: false`) on any step's failure rather than handing back a half-prepared directory.
 */
export async function prepareAttemptWorktree(repoFullName, attemptId, options = {}) {
    // Spread-omit rather than pass `undefined` explicitly -- EnsureRepoClonedOptions' optional fields don't
    // declare `| undefined`, and exactOptionalPropertyTypes treats those as different.
    const cloneResult = await ensureRepoCloned(repoFullName, {
        ...(options.baseBranch !== undefined ? { baseBranch: options.baseBranch } : {}),
        ...(options.cloneBaseDir !== undefined ? { cloneBaseDir: options.cloneBaseDir } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.remoteUrl !== undefined ? { remoteUrl: options.remoteUrl } : {}),
        ...(options.runGit !== undefined ? { runGit: options.runGit } : {}),
    });
    // ensureRepoCloned's own EnsureRepoClonedResult declares `error` optional, but every one of its real ok:false
    // return sites (repo-clone.ts) sets a real, non-empty error string -- a non-null assertion here rather than a
    // fake fallback string, since that fallback would be genuinely unreachable dead code.
    if (!cloneResult.ok)
        return { ok: false, error: cloneResult.error };
    const exec = options.exec ?? createRealWorktreeExec(options.timeoutMs);
    const baseBranch = typeof options.baseBranch === "string" && options.baseBranch.trim() ? options.baseBranch.trim() : "main";
    const added = await addWorktree({ exec, repoPath: cloneResult.repoPath, baseBranch, attemptId });
    // Same reasoning as above: the engine's addWorktree always sets a real error string (git stderr or a synthetic
    // exit-code message) on ok:false -- see worktree-plan.ts's addWorktree.
    if (!added.ok)
        return { ok: false, repoPath: cloneResult.repoPath, error: added.error };
    return { ok: true, worktreePath: added.plan.worktreePath, branchName: added.plan.branchName, repoPath: cloneResult.repoPath };
}
/**
 * Tear down an attempt's worktree once the attempt concludes, per the engine's own retention policy: a
 * failed attempt's worktree is RETAINED for post-mortem inspection, a succeeded one is removed.
 */
export async function cleanupAttemptWorktree(repoPath, worktreePath, attemptOk, options = {}) {
    const exec = options.exec ?? createRealWorktreeExec(options.timeoutMs);
    return removeWorktree({ exec, repoPath, worktreePath, retain: shouldRetainWorktree(attemptOk) });
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXR0ZW1wdC13b3JrdHJlZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImF0dGVtcHQtd29ya3RyZWUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLEtBQUssRUFBRSxNQUFNLG9CQUFvQixDQUFDO0FBQzNDLE9BQU8sRUFBRSxXQUFXLEVBQUUsY0FBYyxFQUFFLG9CQUFvQixFQUFFLE1BQU0sa0JBQWtCLENBQUM7QUFFckYsT0FBTyxFQUFFLGdCQUFnQixFQUFFLE1BQU0saUJBQWlCLENBQUM7QUFHbkQsMkdBQTJHO0FBQzNHLGdHQUFnRztBQUNoRyxxR0FBcUc7QUFDckcsMEdBQTBHO0FBQzFHLCtEQUErRDtBQUUvRCxNQUFNLGtCQUFrQixHQUFHLE9BQU8sQ0FBQztBQUVuQzs7Ozs7R0FLRztBQUNILE1BQU0sVUFBVSxzQkFBc0IsQ0FBQyxTQUFTLEdBQUcsa0JBQWtCO0lBQ25FLE9BQU8sQ0FBQyxHQUFHLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxFQUFFLENBQ3pCLElBQUksT0FBTyxDQUFDLENBQUMsT0FBTyxFQUFFLEVBQUU7UUFDdEIsTUFBTSxLQUFLLEdBQUcsS0FBSyxDQUFDLEdBQUcsRUFBRSxDQUFDLEdBQUcsSUFBSSxDQUFDLEVBQUUsRUFBRSxHQUFHLEVBQUUsSUFBSSxDQUFDLEdBQUcsRUFBRSxLQUFLLEVBQUUsQ0FBQyxRQUFRLEVBQUUsTUFBTSxFQUFFLE1BQU0sQ0FBQyxFQUFFLENBQUMsQ0FBQztRQUMxRixJQUFJLE1BQU0sR0FBRyxFQUFFLENBQUM7UUFDaEIsSUFBSSxNQUFNLEdBQUcsRUFBRSxDQUFDO1FBQ2hCLE1BQU0sS0FBSyxHQUFHLFVBQVUsQ0FBQyxHQUFHLEVBQUU7WUFDNUIsS0FBSyxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQztZQUN0QixPQUFPLENBQUMsRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxNQUFNLEVBQUUsR0FBRyxNQUFNLHFCQUFxQixT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