/** Shared CLI failure output (#5928): when `--json` is set, emit a parseable `{ ok: false, error }` object on
 *  stdout (matching each command's success-path JSON stream); otherwise log plain text to stderr. */
export function reportCliFailure(wantsJson, message, exitCode = 2) {
    if (wantsJson) {
        console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    }
    else {
        console.error(message);
    }
    return exitCode;
}
/** True when argv includes `--json` or `--json=...` (used before a full parse result exists). */
export function argsWantJson(args) {
    return args.some((arg) => arg === "--json" || arg?.startsWith("--json=") === true);
}
/** Normalize a thrown value to a safe error string for CLI output. */
export function describeCliError(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2xpLWVycm9yLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiY2xpLWVycm9yLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBO3FHQUNxRztBQUVyRyxNQUFNLFVBQVUsZ0JBQWdCLENBQUMsU0FBa0IsRUFBRSxPQUFlLEVBQUUsUUFBUSxHQUFHLENBQUM7SUFDaEYsSUFBSSxTQUFTLEVBQUUsQ0FBQztRQUNkLE9BQU8sQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLEVBQUUsRUFBRSxLQUFLLEVBQUUsS0FBSyxFQUFFLE9BQU8sRUFBRSxFQUFFLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ3RFLENBQUM7U0FBTSxDQUFDO1FBQ04sT0FBTyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUN6QixDQUFDO0lBQ0QsT0FBTyxRQUFRLENBQUM7QUFDbEIsQ0FBQztBQUVELGlHQUFpRztBQUNqRyxNQUFNLFVBQVUsWUFBWSxDQUFDLElBQXNDO0lBQ2pFLE9BQU8sSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLEdBQUcsRUFBRSxFQUFFLENBQUMsR0FBRyxLQUFLLFFBQVEsSUFBSSxHQUFHLEVBQUUsVUFBVSxDQUFDLFNBQVMsQ0FBQyxLQUFLLElBQUksQ0FBQyxDQUFDO0FBQ3JGLENBQUM7QUFFRCxzRUFBc0U7QUFDdEUsTUFBTSxVQUFVLGdCQUFnQixDQUFDLEtBQWM7SUFDN0MsT0FBTyxLQUFLLFlBQVksS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUM7QUFDaEUsQ0FBQyJ9