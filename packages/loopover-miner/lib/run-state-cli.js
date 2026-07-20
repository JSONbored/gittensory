import { RUN_STATES, getRunState, setRunState } from "./run-state.js";
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";
const STATE_GET_USAGE = "Usage: loopover-miner state get <owner/repo> [--api-base-url <url>] [--json]";
const STATE_SET_USAGE = "Usage: loopover-miner state set <owner/repo> <idle|discovering|planning|preparing> [--api-base-url <url>] [--dry-run] [--json]";
const allowedRunStates = new Set(RUN_STATES);
function parseRepoArg(value, usage) {
    if (!value)
        return { error: usage };
    const trimmed = value.trim();
    const [owner, repo, extra] = trimmed.split("/");
    if (!owner || !repo || extra !== undefined) {
        return { error: "Repository must be in owner/repo form." };
    }
    return { repoFullName: `${owner}/${repo}` };
}
export function parseStateGetArgs(args) {
    const options = { json: false, apiBaseUrl: undefined };
    const positional = [];
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--json") {
            options.json = true;
            continue;
        }
        // #5563: scope the lookup to a non-default forge host, so it doesn't collide with (or get confused for) a
        // same-named repo on the default github.com host.
        if (token === "--api-base-url") {
            const value = args[index + 1];
            if (!value || value.startsWith("-")) {
                return { error: STATE_GET_USAGE };
            }
            options.apiBaseUrl = value;
            index += 1;
            continue;
        }
        if (token.startsWith("-")) {
            return { error: `Unknown option: ${token}` };
        }
        positional.push(token);
    }
    if (positional.length !== 1) {
        return { error: STATE_GET_USAGE };
    }
    const repo = parseRepoArg(positional[0], STATE_GET_USAGE);
    if ("error" in repo)
        return repo;
    return { repoFullName: repo.repoFullName, ...options };
}
export function parseStateSetArgs(args) {
    const options = {
        json: false,
        dryRun: false,
        apiBaseUrl: undefined,
    };
    const positional = [];
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--json") {
            options.json = true;
            continue;
        }
        // #4847: reports what a real state set would do and returns before writing to the run-state store.
        if (token === "--dry-run") {
            options.dryRun = true;
            continue;
        }
        if (token === "--api-base-url") {
            const value = args[index + 1];
            if (!value || value.startsWith("-")) {
                return { error: STATE_SET_USAGE };
            }
            options.apiBaseUrl = value;
            index += 1;
            continue;
        }
        if (token.startsWith("-")) {
            return { error: `Unknown option: ${token}` };
        }
        positional.push(token);
    }
    if (positional.length !== 2) {
        return { error: STATE_SET_USAGE };
    }
    const repo = parseRepoArg(positional[0], STATE_SET_USAGE);
    if ("error" in repo)
        return repo;
    const state = positional[1];
    if (!allowedRunStates.has(state)) {
        return { error: `Invalid state: ${state}. Expected one of ${RUN_STATES.join(", ")}.` };
    }
    return { repoFullName: repo.repoFullName, state: state, ...options };
}
export function runStateGet(args) {
    const parsed = parseStateGetArgs(args);
    if ("error" in parsed) {
        return reportCliFailure(argsWantJson(args), parsed.error);
    }
    try {
        const state = getRunState(parsed.repoFullName, parsed.apiBaseUrl);
        if (parsed.json) {
            console.log(JSON.stringify({ repoFullName: parsed.repoFullName, state }));
        }
        else {
            console.log(state ?? "none");
        }
        return 0;
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
}
export function runStateSet(args) {
    const parsed = parseStateSetArgs(args);
    if ("error" in parsed) {
        return reportCliFailure(argsWantJson(args), parsed.error);
    }
    if (parsed.dryRun) {
        const dryRunResult = { outcome: "dry_run", repoFullName: parsed.repoFullName, state: parsed.state };
        if (parsed.json) {
            console.log(JSON.stringify(dryRunResult));
        }
        else {
            console.log(`DRY RUN: would set ${parsed.repoFullName}'s run state to "${parsed.state}". No run-state write was made.`);
        }
        return 0;
    }
    try {
        const write = setRunState(parsed.repoFullName, parsed.state, parsed.apiBaseUrl);
        if (parsed.json) {
            console.log(JSON.stringify(write));
        }
        else {
            console.log(write.state);
        }
        return 0;
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
}
export function runStateCli(subcommand, args) {
    if (subcommand === "get")
        return runStateGet(args);
    if (subcommand === "set")
        return runStateSet(args);
    return reportCliFailure(argsWantJson(args), `Unknown state subcommand: ${subcommand ?? ""}. ${STATE_GET_USAGE}`);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicnVuLXN0YXRlLWNsaS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInJ1bi1zdGF0ZS1jbGkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLFVBQVUsRUFBRSxXQUFXLEVBQUUsV0FBVyxFQUFFLE1BQU0sZ0JBQWdCLENBQUM7QUFFdEUsT0FBTyxFQUFFLFlBQVksRUFBRSxnQkFBZ0IsRUFBRSxnQkFBZ0IsRUFBRSxNQUFNLGdCQUFnQixDQUFDO0FBRWxGLE1BQU0sZUFBZSxHQUFHLDhFQUE4RSxDQUFDO0FBQ3ZHLE1BQU0sZUFBZSxHQUNuQixnSUFBZ0ksQ0FBQztBQUVuSSxNQUFNLGdCQUFnQixHQUFnQixJQUFJLEdBQUcsQ0FBQyxVQUFVLENBQUMsQ0FBQztBQXNCMUQsU0FBUyxZQUFZLENBQUMsS0FBeUIsRUFBRSxLQUFhO0lBQzVELElBQUksQ0FBQyxLQUFLO1FBQUUsT0FBTyxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsQ0FBQztJQUNwQyxNQUFNLE9BQU8sR0FBRyxLQUFLLENBQUMsSUFBSSxFQUFFLENBQUM7SUFDN0IsTUFBTSxDQUFDLEtBQUssRUFBRSxJQUFJLEVBQUUsS0FBSyxDQUFDLEdBQUcsT0FBTyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUNoRCxJQUFJLENBQUMsS0FBSyxJQUFJLENBQUMsSUFBSSxJQUFJLEtBQUssS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUMzQyxPQUFPLEVBQUUsS0FBSyxFQUFFLHdDQUF3QyxFQUFFLENBQUM7SUFDN0QsQ0FBQztJQUNELE9BQU8sRUFBRSxZQUFZLEVBQUUsR0FBRyxLQUFLLElBQUksSUFBSSxFQUFFLEVBQUUsQ0FBQztBQUM5QyxDQUFDO0FBRUQsTUFBTSxVQUFVLGlCQUFpQixDQUFDLElBQWM7SUFDOUMsTUFBTSxPQUFPLEdBQXNELEVBQUUsSUFBSSxFQUFFLEtBQUssRUFBRSxVQUFVLEVBQUUsU0FBUyxFQUFFLENBQUM7SUFDMUcsTUFBTSxVQUFVLEdBQWEsRUFBRSxDQUFDO0lBRWhDLEtBQUssSUFBSSxLQUFLLEdBQUcsQ0FBQyxFQUFFLEtBQUssR0FBRyxJQUFJLENBQUMsTUFBTSxFQUFFLEtBQUssSUFBSSxDQUFDLEVBQUUsQ0FBQztRQUNwRCxNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFFLENBQUM7UUFDM0IsSUFBSSxLQUFLLEtBQUssUUFBUSxFQUFFLENBQUM7WUFDdkIsT0FBTyxDQUFDLElBQUksR0FBRyxJQUFJLENBQUM7WUFDcEIsU0FBUztRQUNYLENBQUM7UUFDRCwwR0FBMEc7UUFDMUcsa0RBQWtEO1FBQ2xELElBQUksS0FBSyxLQUFLLGdCQUFnQixFQUFFLENBQUM7WUFDL0IsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLEtBQUssR0FBRyxDQUFDLENBQUMsQ0FBQztZQUM5QixJQUFJLENBQUMsS0FBSyxJQUFJLEtBQUssQ0FBQyxVQUFVLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQztnQkFDcEMsT0FBTyxFQUFFLEtBQUssRUFBRSxlQUFlLEVBQUUsQ0FBQztZQUNwQyxDQUFDO1lBQ0QsT0FBTyxDQUFDLFVBQVUsR0FBRyxLQUFLLENBQUM7WUFDM0IsS0FBSyxJQUFJLENBQUMsQ0FBQztZQUNYLFNBQVM7UUFDWCxDQUFDO1FBQ0QsSUFBSSxLQUFLLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUM7WUFDMUIsT0FBTyxFQUFFLEtBQUssRUFBRSxtQkFBbUIsS0FBSyxFQUFFLEVBQUUsQ0FBQztRQUMvQyxDQUFDO1FBQ0QsVUFBVSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUN6QixDQUFDO0lBRUQsSUFBSSxVQUFVLENBQUMsTUFBTSxLQUFLLENBQUMsRUFBRSxDQUFDO1FBQzVCLE9BQU8sRUFBRSxLQUFLLEVBQUUsZUFBZSxFQUFFLENBQUM7SUFDcEMsQ0FBQztJQUVELE1BQU0sSUFBSSxHQUFHLFlBQVksQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLEVBQUUsZUFBZSxDQUFDLENBQUM7SUFDMUQsSUFBSSxPQUFPLElBQUksSUFBSTtRQUFFLE9BQU8sSUFBSSxDQUFDO0lBRWpDLE9BQU8sRUFBRSxZQUFZLEVBQUUsSUFBSSxDQUFDLFlBQVksRUFBRSxHQUFHLE9BQU8sRUFBRSxDQUFDO0FBQ3pELENBQUM7QUFFRCxNQUFNLFVBQVUsaUJBQWlCLENBQUMsSUFBYztJQUM5QyxNQUFNLE9BQU8sR0FBdUU7UUFDbEYsSUFBSSxFQUFFLEtBQUs7UUFDWCxNQUFNLEVBQUUsS0FBSztRQUNiLFVBQVUsRUFBRSxTQUFTO0tBQ3RCLENBQUM7SUFDRixNQUFNLFVBQVUsR0FBYSxFQUFFLENBQUM7SUFFaEMsS0FBSyxJQUFJLEtBQUssR0FBRyxDQUFDLEVBQUUsS0FBSyxHQUFHLElBQUksQ0FBQyxNQUFNLEVBQUUsS0FBSyxJQUFJLENBQUMsRUFBRSxDQUFDO1FBQ3BELE1BQU0sS0FBSyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUUsQ0FBQztRQUMzQixJQUFJLEtBQUssS0FBSyxRQUFRLEVBQUUsQ0FBQztZQUN2QixPQUFPLENBQUMsSUFBSSxHQUFHLElBQUksQ0FBQztZQUNwQixTQUFTO1FBQ1gsQ0FBQztRQUNELG1HQUFtRztRQUNuRyxJQUFJLEtBQUssS0FBSyxXQUFXLEVBQUUsQ0FBQztZQUMxQixPQUFPLENBQUMsTUFBTSxHQUFHLElBQUksQ0FBQztZQUN0QixTQUFTO1FBQ1gsQ0FBQztRQUNELElBQUksS0FBSyxLQUFLLGdCQUFnQixFQUFFLENBQUM7WUFDL0IsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLEtBQUssR0FBRyxDQUFDLENBQUMsQ0FBQztZQUM5QixJQUFJLENBQUMsS0FBSyxJQUFJLEtBQUssQ0FBQyxVQUFVLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQztnQkFDcEMsT0FBTyxFQUFFLEtBQUssRUFBRSxlQUFlLEVBQUUsQ0FBQztZQUNwQyxDQUFDO1lBQ0QsT0FBTyxDQUFDLFVBQVUsR0FBRyxLQUFLLENBQUM7WUFDM0IsS0FBSyxJQUFJLENBQUMsQ0FBQztZQUNYLFNBQVM7UUFDWCxDQUFDO1FBQ0QsSUFBSSxLQUFLLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUM7WUFDMUIsT0FBTyxFQUFFLEtBQUssRUFBRSxtQkFBbUIsS0FBSyxFQUFFLEVBQUUsQ0FBQztRQUMvQyxDQUFDO1FBQ0QsVUFBVSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUN6QixDQUFDO0lBRUQsSUFBSSxVQUFVLENBQUMsTUFBTSxLQUFLLENBQUMsRUFBRSxDQUFDO1FBQzVCLE9BQU8sRUFBRSxLQUFLLEVBQUUsZUFBZSxFQUFFLENBQUM7SUFDcEMsQ0FBQztJQUVELE1BQU0sSUFBSSxHQUFHLFlBQVksQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLEVBQUUsZUFBZSxDQUFDLENBQUM7SUFDMUQsSUFBSSxPQUFPLElBQUksSUFBSTtRQUFFLE9BQU8sSUFBSSxDQUFDO0lBRWpDLE1BQU0sS0FBSyxHQUFHLFVBQVUsQ0FBQyxDQUFDLENBQUUsQ0FBQztJQUM3QixJQUFJLENBQUMsZ0JBQWdCLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUM7UUFDakMsT0FBTyxFQUFFLEtBQUssRUFBRSxrQkFBa0IsS0FBSyxxQkFBcUIsVUFBVSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsR0FBRyxFQUFFLENBQUM7SUFDekYsQ0FBQztJQUVELE9BQU8sRUFBRSxZQUFZLEVBQUUsSUFBSSxDQUFDLFlBQVksRUFBRSxLQUFLLEVBQUUsS0FBaUIsRUFBRSxHQUFHLE9BQU8sRUFBRSxDQUFDO0FBQ25GLENBQUM7QUFFRCxNQUFNLFVBQVUsV0FBVyxDQUFDLElBQWM7SUFDeEMsTUFBTSxNQUFNLEdBQUcsaUJBQWlCLENBQUMsSUFBSSxDQUFDLENBQUM7SUFDdkMsSUFBSSxPQUFPLElBQUksTUFBTSxFQUFFLENBQUM7UUFDdEIsT0FBTyxnQkFBZ0IsQ0FBQyxZQUFZLENBQUMsSUFBSSxDQUFDLEVBQUUsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQzVELENBQUM7SUFFRCxJQUFJLENBQUM7UUFDSCxNQUFNLEtBQUssR0FBRyxXQUFXLENBQUMsTUFBTSxDQUFDLFlBQVksRUFBRSxNQUFNLENBQUMsVUFBVSxDQUFDLENBQUM7UUFDbEUsSUFBSSxNQUFNLENBQUMsSUFBSSxFQUFFLENBQUM7WUFDaEIsT0FBTyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsWUFBWSxFQUFFLE1BQU0sQ0FBQyxZQUFZLEVBQUUsS0FBSyxFQUFFLENBQUMsQ0FBQyxDQUFDO1FBQzVFLENBQUM7YUFBTSxDQUFDO1lBQ04sT0FBTyxDQUFDLEdBQUcsQ0FBQyxLQUFLLElBQUksTUFBTSxDQUFDLENBQUM7UUFDL0IsQ0FBQztRQUNELE9BQU8sQ0FBQyxDQUFDO0lBQ1gsQ0FBQztJQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7UUFDZixPQUFPLGdCQUFnQixDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsZ0JBQWdCLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztJQUNoRSxDQUFDO0FBQ0gsQ0FBQztBQUVELE1BQU0sVUFBVSxXQUFXLENBQUMsSUFBYztJQUN4QyxNQUFNLE1BQU0sR0FBRyxpQkFBaUIsQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUN2QyxJQUFJLE9BQU8sSUFBSSxNQUFNLEVBQUUsQ0FBQztRQUN0QixPQUFPLGdCQUFnQixDQUFDLFlBQVksQ0FBQyxJQUFJLENBQUMsRUFBRSxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDNUQsQ0FBQztJQUVELElBQUksTUFBTSxDQUFDLE1BQU0sRUFBRSxDQUFDO1FBQ2xCLE1BQU0sWUFBWSxHQUFHLEVBQUUsT0FBTyxFQUFFLFNBQVMsRUFBRSxZQUFZLEVBQUUsTUFBTSxDQUFDLFlBQVksRUFBRSxLQUFLLEVBQUUsTUFBTSxDQUFDLEtBQUssRUFBRSxDQUFDO1FBQ3BHLElBQUksTUFBTSxDQUFDLElBQUksRUFBRSxDQUFDO1lBQ2hCLE9BQU8sQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDO1FBQzVDLENBQUM7YUFBTSxDQUFDO1lBQ04sT0FBTyxDQUFDLEdBQUcsQ0FBQyxzQkFBc0IsTUFBTSxDQUFDLFlBQVksb0JBQW9CLE1BQU0sQ0FBQyxLQUFLLGlDQUFpQyxDQUFDLENBQUM7UUFDMUgsQ0FBQztRQUNELE9BQU8sQ0FBQyxDQUFDO0lBQ1gsQ0FBQztJQUVELElBQUksQ0FBQztRQUNILE1BQU0sS0FBSyxHQUFHLFdBQVcsQ0FBQyxNQUFNLENBQUMsWUFBWSxFQUFFLE1BQU0sQ0FBQyxLQUFLLEVBQUUsTUFBTSxDQUFDLFVBQVUsQ0FBQyxDQUFDO1FBQ2hGLElBQUksTUFBTSxDQUFDLElBQUksRUFBRSxDQUFDO1lBQ2hCLE9BQU8sQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO1FBQ3JDLENBQUM7YUFBTSxDQUFDO1lBQ04sT0FBTyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDM0IsQ0FBQztRQUNELE9BQU8sQ0FBQyxDQUFDO0lBQ1gsQ0FBQztJQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7UUFDZixPQUFPLGdCQUFnQixDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsZ0JBQWdCLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztJQUNoRSxDQUFDO0FBQ0gsQ0FBQztBQUVELE1BQU0sVUFBVSxXQUFXLENBQUMsVUFBOEIsRUFBRSxJQUFjO0lBQ3hFLElBQUksVUFBVSxLQUFLLEtBQUs7UUFBRSxPQUFPLFdBQVcsQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUNuRCxJQUFJLFVBQVUsS0FBSyxLQUFLO1FBQUUsT0FBTyxXQUFXLENBQUMsSUFBSSxDQUFDLENBQUM7SUFDbkQsT0FBTyxnQkFBZ0IsQ0FBQyxZQUFZLENBQUMsSUFBSSxDQUFDLEVBQUUsNkJBQTZCLFVBQVUsSUFBSSxFQUFFLEtBQUssZUFBZSxFQUFFLENBQUMsQ0FBQztBQUNuSCxDQUFDIn0=