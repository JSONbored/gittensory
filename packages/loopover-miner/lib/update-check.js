const defaultPackageName = "@loopover/miner";
const defaultNpmRegistryUrl = "https://registry.npmjs.org";
function isLocalRegistryHost(hostname) {
    const normalized = hostname.toLowerCase().replace(/\.$/, "");
    return (normalized === "localhost" ||
        normalized === "127.0.0.1" ||
        normalized === "::1" ||
        normalized === "[::1]");
}
export function resolveNpmRegistryUrl(env = process.env) {
    const raw = env.LOOPOVER_NPM_REGISTRY_URL?.trim();
    if (!raw)
        return defaultNpmRegistryUrl;
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        return defaultNpmRegistryUrl;
    }
    if (url.username || url.password || url.search || url.hash || !url.hostname) {
        return defaultNpmRegistryUrl;
    }
    const local = isLocalRegistryHost(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
        return defaultNpmRegistryUrl;
    }
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
    return `${url.origin}${path}`;
}
export function resolveUpgradeCommand(packageName = defaultPackageName) {
    return `npm install -g ${packageName}@latest`;
}
export function shouldSkipUpdateCheck(cliArgs, env = process.env) {
    if (/^(1|true|yes)$/i.test(env.LOOPOVER_MINER_NO_UPDATE_CHECK ?? ""))
        return true;
    return cliArgs.includes("--no-update-check");
}
// `version` is always a real string here: this function is private and only ever called by
// compareSemver(a: string, b: string), whose own signature guarantees that -- so trimming it directly
// is safe and equivalent to the historical `String(version ?? "").trim()` for every reachable input.
function parseSemver(version) {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(version.trim());
    if (!match)
        return null;
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        prerelease: match[4] ?? null,
    };
}
// Numeric identifiers are compared as decimal strings, not via Number(), which loses precision beyond
// Number.MAX_SAFE_INTEGER (2^53-1): two distinct digit strings past that width can round to the SAME float,
// making Number(leftId) !== Number(rightId) wrongly report them as equal (mirrors the same fix already applied
// to compareMcpSemver's comparePrerelease in src/services/mcp-compatibility.ts, #3049). With no leading zeros
// (semver's own numeric-identifier rule), a longer digit string is the larger number, and equal-length strings
// compare lexicographically.
function comparePrerelease(a, b) {
    const left = a.split(".");
    const right = b.split(".");
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        const leftId = left[index];
        const rightId = right[index];
        if (leftId === undefined)
            return -1;
        if (rightId === undefined)
            return 1;
        const leftNumeric = /^\d+$/.test(leftId);
        const rightNumeric = /^\d+$/.test(rightId);
        if (leftNumeric && rightNumeric) {
            if (leftId.length !== rightId.length)
                return leftId.length < rightId.length ? -1 : 1;
            if (leftId !== rightId)
                return leftId < rightId ? -1 : 1;
        }
        else if (leftNumeric !== rightNumeric) {
            return leftNumeric ? -1 : 1;
        }
        else if (leftId !== rightId) {
            return leftId < rightId ? -1 : 1;
        }
    }
    // Unreachable via this function's only caller: compareSemver calls comparePrerelease only when the two raw
    // prerelease strings already differ, and if every split segment above compared equal, the two strings would
    // necessarily be identical too -- contradicting that guard. Kept for comparePrerelease's own general "equal"
    // contract (the type signature promises 0 is a possible result) rather than asserting a case that can't occur.
    return 0;
}
export function compareSemver(a, b) {
    const left = parseSemver(a);
    const right = parseSemver(b);
    if (!left || !right)
        return null;
    for (const part of ["major", "minor", "patch"]) {
        if (left[part] !== right[part])
            return left[part] < right[part] ? -1 : 1;
    }
    if (left.prerelease === right.prerelease)
        return 0;
    if (left.prerelease === null)
        return 1;
    if (right.prerelease === null)
        return -1;
    return comparePrerelease(left.prerelease, right.prerelease);
}
export async function fetchLatestPackageVersion(input) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 5000);
    const registrySlug = input.packageName.startsWith("@")
        ? input.packageName.replace("/", "%2F")
        : input.packageName;
    const registryPath = `${input.npmRegistryUrl}/${registrySlug}/latest`;
    try {
        const response = await fetch(registryPath, {
            signal: controller.signal,
            headers: { accept: "application/json" },
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || typeof payload.version !== "string")
            throw new Error("npm_latest_version_unavailable");
        return payload.version;
    }
    finally {
        clearTimeout(timeout);
    }
}
// Non-blocking startup nudge: prints one upgrade line when local is behind npm latest.
// Mirrors packages/loopover-mcp/bin/loopover-mcp.js packageVersion/npmRegistryUrl/upgradeCommand (#2331).
export async function maybePrintUpdateNudge(input) {
    try {
        const latestVersion = await fetchLatestPackageVersion(input);
        const comparison = compareSemver(input.packageVersion, latestVersion);
        if (comparison !== null && comparison < 0) {
            process.stderr.write(`${input.upgradeCommand}\n`);
        }
    }
    catch {
        // Offline or unreachable registry — never block or fail the CLI.
    }
}
export function startUpdateCheck(cliArgs, input) {
    if (shouldSkipUpdateCheck(cliArgs, input.env))
        return Promise.resolve();
    return maybePrintUpdateNudge({
        packageName: input.packageName,
        packageVersion: input.packageVersion,
        npmRegistryUrl: resolveNpmRegistryUrl(input.env),
        upgradeCommand: input.upgradeCommand ?? resolveUpgradeCommand(input.packageName),
        timeoutMs: input.timeoutMs,
    });
}
export const updateCheckExitGraceMs = 250;
// After command output is printed, give a fast registry response time to emit the nudge
// without waiting for the full lookup timeout on slow/offline registries.
export async function awaitOpportunisticUpdateCheck(updateCheck, graceMs = updateCheckExitGraceMs) {
    await Promise.race([
        updateCheck.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, graceMs)),
    ]);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidXBkYXRlLWNoZWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsidXBkYXRlLWNoZWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE1BQU0sa0JBQWtCLEdBQUcsaUJBQWlCLENBQUM7QUFDN0MsTUFBTSxxQkFBcUIsR0FBRyw0QkFBNEIsQ0FBQztBQUUzRCxTQUFTLG1CQUFtQixDQUFDLFFBQWdCO0lBQzNDLE1BQU0sVUFBVSxHQUFHLFFBQVEsQ0FBQyxXQUFXLEVBQUUsQ0FBQyxPQUFPLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO0lBQzdELE9BQU8sQ0FDTCxVQUFVLEtBQUssV0FBVztRQUMxQixVQUFVLEtBQUssV0FBVztRQUMxQixVQUFVLEtBQUssS0FBSztRQUNwQixVQUFVLEtBQUssT0FBTyxDQUN2QixDQUFDO0FBQ0osQ0FBQztBQUVELE1BQU0sVUFBVSxxQkFBcUIsQ0FBQyxNQUEwQyxPQUFPLENBQUMsR0FBRztJQUN6RixNQUFNLEdBQUcsR0FBRyxHQUFHLENBQUMseUJBQXlCLEVBQUUsSUFBSSxFQUFFLENBQUM7SUFDbEQsSUFBSSxDQUFDLEdBQUc7UUFBRSxPQUFPLHFCQUFxQixDQUFDO0lBRXZDLElBQUksR0FBUSxDQUFDO0lBQ2IsSUFBSSxDQUFDO1FBQ0gsR0FBRyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQ3JCLENBQUM7SUFBQyxNQUFNLENBQUM7UUFDUCxPQUFPLHFCQUFxQixDQUFDO0lBQy9CLENBQUM7SUFFRCxJQUFJLEdBQUcsQ0FBQyxRQUFRLElBQUksR0FBRyxDQUFDLFFBQVEsSUFBSSxHQUFHLENBQUMsTUFBTSxJQUFJLEdBQUcsQ0FBQyxJQUFJLElBQUksQ0FBQyxHQUFHLENBQUMsUUFBUSxFQUFFLENBQUM7UUFDNUUsT0FBTyxxQkFBcUIsQ0FBQztJQUMvQixDQUFDO0lBRUQsTUFBTSxLQUFLLEdBQUcsbUJBQW1CLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBQyxDQUFD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