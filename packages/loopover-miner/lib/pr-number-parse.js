// Shared PR-number extraction from a real `gh pr create` executeLocalWrite result (#4848). `gh pr create`
// prints the new PR's URL to stdout on success -- this is the one place that URL is authoritatively parsed,
// so loop-cli.js's CI/gate-status polling and attempt-cli.js's post-submission claim-conflict check agree on
// exactly how a PR number is recovered from a real command's raw output.
/** `gh pr create` (local-write-tools.ts's `buildOpenPrSpec` -- no `--json` flag) prints the created PR's own
 *  URL to stdout on success; this is `gh`'s real, documented, stable CLI behavior, not an invented contract.
 *  Scoped to the exact target repo so an unrelated URL elsewhere in stdout/stderr noise can never match.
 */
export function parsePrNumberFromExecResult(execResult, repoFullName) {
    if (!execResult || execResult.timedOut || execResult.code !== 0 || typeof execResult.stdout !== "string") {
        return null;
    }
    const escapedRepo = repoFullName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = execResult.stdout.match(new RegExp(`github\\.com/${escapedRepo}/pull/(\\d+)`));
    if (!match)
        return null;
    const prNumber = Number(match[1]);
    return Number.isInteger(prNumber) && prNumber > 0 ? prNumber : null;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicHItbnVtYmVyLXBhcnNlLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsicHItbnVtYmVyLXBhcnNlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLDBHQUEwRztBQUMxRyw0R0FBNEc7QUFDNUcsNkdBQTZHO0FBQzdHLHlFQUF5RTtBQUV6RTs7O0dBR0c7QUFDSCxNQUFNLFVBQVUsMkJBQTJCLENBQ3pDLFVBQWdJLEVBQ2hJLFlBQW9CO0lBRXBCLElBQUksQ0FBQyxVQUFVLElBQUksVUFBVSxDQUFDLFFBQVEsSUFBSSxVQUFVLENBQUMsSUFBSSxLQUFLLENBQUMsSUFBSSxPQUFPLFVBQVUsQ0FBQyxNQUFNLEtBQUssUUFBUSxFQUFFLENBQUM7UUFDekcsT0FBTyxJQUFJLENBQUM7SUFDZCxDQUFDO0lBQ0QsTUFBTSxXQUFXLEdBQUcsWUFBWSxDQUFDLE9BQU8sQ0FBQyxxQkFBcUIsRUFBRSxNQUFNLENBQUMsQ0FBQztJQUN4RSxNQUFNLEtBQUssR0FBRyxVQUFVLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxJQUFJLE1BQU0sQ0FBQyxnQkFBZ0IsV0FBVyxjQUFjLENBQUMsQ0FBQyxDQUFDO0lBQzdGLElBQUksQ0FBQyxLQUFLO1FBQUUsT0FBTyxJQUFJLENBQUM7SUFDeEIsTUFBTSxRQUFRLEdBQUcsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ2xDLE9BQU8sTUFBTSxDQUFDLFNBQVMsQ0FBQyxRQUFRLENBQUMsSUFBSSxRQUFRLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztBQUN0RSxDQUFDIn0=