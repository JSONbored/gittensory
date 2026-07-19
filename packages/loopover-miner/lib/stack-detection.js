/** Stack auto-detection (#4785): inspect an already-cloned target repo's manifest / lockfile / config files and
 * infer a structured description of its stack — language, package manager, and the build / test / lint / format
 * commands — before any code-generation step runs. Like `miner-goal-spec.js` this reads the ALREADY-CLONED repo on
 * disk (attempt-worktree.js's prepareAttemptWorktree runs first), so the injected `existsSync` / `readFileSync`
 * always receive the FULL joined path, mirroring node:fs. It is pure and NEVER throws: an unreadable/unparseable
 * file degrades to "no evidence" rather than crashing, and — per the acceptance criteria — a repo whose stack
 * can't be confidently identified returns an explicit `{ detected: false, reason }` instead of guessing. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
/** Manifests, in the precedence order detection tries them; the first matching primary manifest wins. A caller with
 * a known polyglot repo can inspect `evidence.manifest` to see which one was chosen. */
export const RECOGNIZED_MANIFESTS = Object.freeze([
    "package.json",
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "requirements.txt",
    "Pipfile",
    "Cargo.toml",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
]);
const NO_MANIFEST_REASON = "No recognized dependency manifest (package.json, pyproject.toml, Cargo.toml, go.mod, pom.xml, or build.gradle) was found at the repository root.";
const NODE_PACKAGE_MANAGERS = Object.freeze(["npm", "yarn", "pnpm", "bun"]);
const NODE_LOCKFILES = Object.freeze([
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"],
]);
/** Build a never-throwing accessor over the cloned repo. `exists` and `read` both swallow fs errors so the detector
 * treats an EACCES/ENOENT/binary file as simply "absent" instead of crashing the attempt. */
function makeAccess(repoPath, options) {
    const existsImpl = options.existsSync ?? existsSync;
    const readImpl = options.readFileSync ?? readFileSync;
    const exists = (relativePath) => {
        try {
            return existsImpl(join(repoPath, relativePath)) === true;
        }
        catch {
            return false;
        }
    };
    const read = (relativePath) => {
        try {
            if (!exists(relativePath))
                return null;
            const content = readImpl(join(repoPath, relativePath), "utf8");
            return typeof content === "string" ? content : null;
        }
        catch {
            return null;
        }
    };
    return { exists, read };
}
function parseJson(text) {
    if (typeof text !== "string")
        return null;
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === "object" ? parsed : null;
    }
    catch {
        return null;
    }
}
/** Pick a package.json script by exact name first, then by pattern, considering only string-valued scripts. */
function pickScript(scripts, exactName, pattern) {
    const names = Object.keys(scripts).filter((name) => typeof scripts[name] === "string");
    if (names.includes(exactName))
        return exactName;
    return names.find((name) => pattern.test(name)) ?? null;
}
function nodeLockfile(exists) {
    const match = NODE_LOCKFILES.find(([file]) => exists(file));
    return match ? match[0] : null;
}
function nodePackageManager(pkg, lockfile) {
    // split() always yields at least one element, so [0] is never undefined -- assert rather than add an
    // unreachable `?? ""` fallback branch (noUncheckedIndexedAccess widens the element type to string | undefined).
    const corepack = typeof pkg?.packageManager === "string" ? pkg.packageManager.split("@")[0].trim().toLowerCase() : "";
    if (NODE_PACKAGE_MANAGERS.includes(corepack))
        return corepack;
    const byLock = NODE_LOCKFILES.find(([file]) => file === lockfile);
    // A package.json with no lockfile is still a Node project; npm is its default runner (a default, not a guess).
    return byLock ? byLock[1] : "npm";
}
function hasTypescriptDependency(pkg) {
    const deps = {
        ...(pkg?.dependencies ?? {}),
        ...(pkg?.devDependencies ?? {}),
    };
    return typeof deps.typescript === "string";
}
function detectNode({ exists, read }) {
    if (!exists("package.json"))
        return null;
    const pkg = parseJson(read("package.json"));
    const scripts = pkg && typeof pkg.scripts === "object" && pkg.scripts && !Array.isArray(pkg.scripts)
        ? pkg.scripts
        : {};
    const language = exists("tsconfig.json") || hasTypescriptDependency(pkg) ? "typescript" : "javascript";
    const lockfile = nodeLockfile(exists);
    const packageManager = nodePackageManager(pkg, lockfile);
    const buildName = pickScript(scripts, "build", /^(build|compile|bundle)(:|$)/i);
    const testName = pickScript(scripts, "test", /(^|:)test(:|$)/i);
    const lintName = pickScript(scripts, "lint", /(^|:)lint(:|$)/i);
    const formatName = pickScript(scripts, "format", /(^|:)(format|fmt)(:|$)/i);
    return {
        language,
        packageManager,
        buildCommand: buildName ? `${packageManager} run ${buildName}` : null,
        // `<pm> test` is the built-in test lifecycle across npm/yarn/pnpm/bun; a non-"test" script uses `run`.
        testCommand: testName ? (testName === "test" ? `${packageManager} test` : `${packageManager} run ${testName}`) : null,
        lintCommand: lintName ? `${packageManager} run ${lintName}` : null,
        formatCommand: formatName ? `${packageManager} run ${formatName}` : null,
        evidence: { manifest: "package.json", lockfile },
    };
}
function detectPython({ exists, read }) {
    const manifest = ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"].find(exists);
    if (manifest === undefined)
        return null;
    const pyproject = read("pyproject.toml") ?? "";
    let packageManager;
    let lockfile = null;
    if (exists("poetry.lock") || /\[tool\.poetry\]/.test(pyproject)) {
        packageManager = "poetry";
        lockfile = exists("poetry.lock") ? "poetry.lock" : null;
    }
    else if (exists("uv.lock")) {
        packageManager = "uv";
        lockfile = "uv.lock";
    }
    else if (exists("Pipfile") || exists("Pipfile.lock")) {
        packageManager = "pipenv";
        lockfile = exists("Pipfile.lock") ? "Pipfile.lock" : null;
    }
    else {
        packageManager = "pip";
    }
    // Commands are inferred only from real config so an undeclared tool is never guessed (acceptance: fail safe).
    const hasRuff = exists("ruff.toml") || exists(".ruff.toml") || /\[tool\.ruff\]/.test(pyproject);
    const hasPytest = exists("pytest.ini") || exists("tox.ini") || /\[tool\.pytest\b/.test(pyproject);
    return {
        language: "python",
        packageManager,
        buildCommand: /\[build-system\]/.test(pyproject) ? (packageManager === "poetry" ? "poetry build" : "python -m build") : null,
        testCommand: hasPytest ? "pytest" : null,
        lintCommand: hasRuff ? "ruff check ." : null,
        formatCommand: hasRuff ? "ruff format ." : null,
        evidence: { manifest, lockfile },
    };
}
function detectRust({ exists }) {
    if (!exists("Cargo.toml"))
        return null;
    return {
        language: "rust",
        packageManager: "cargo",
        buildCommand: "cargo build",
        testCommand: "cargo test",
        lintCommand: "cargo clippy",
        formatCommand: "cargo fmt",
        evidence: { manifest: "Cargo.toml", lockfile: exists("Cargo.lock") ? "Cargo.lock" : null },
    };
}
function detectGo({ exists }) {
    if (!exists("go.mod"))
        return null;
    const hasGolangci = exists(".golangci.yml") || exists(".golangci.yaml") || exists(".golangci.toml");
    return {
        language: "go",
        packageManager: "go",
        buildCommand: "go build ./...",
        testCommand: "go test ./...",
        lintCommand: hasGolangci ? "golangci-lint run" : "go vet ./...",
        formatCommand: "gofmt -l .",
        evidence: { manifest: "go.mod", lockfile: exists("go.sum") ? "go.sum" : null },
    };
}
function detectMaven({ exists }) {
    if (!exists("pom.xml"))
        return null;
    return {
        language: "java",
        packageManager: "maven",
        buildCommand: "mvn -B package",
        testCommand: "mvn -B test",
        lintCommand: null,
        formatCommand: null,
        evidence: { manifest: "pom.xml", lockfile: null },
    };
}
function detectGradle({ exists }) {
    const manifest = exists("build.gradle") ? "build.gradle" : exists("build.gradle.kts") ? "build.gradle.kts" : null;
    if (manifest === null)
        return null;
    const runner = exists("gradlew") ? "./gradlew" : "gradle";
    return {
        language: "java",
        packageManager: "gradle",
        buildCommand: `${runner} build`,
        testCommand: `${runner} test`,
        lintCommand: null,
        formatCommand: null,
        evidence: { manifest, lockfile: null },
    };
}
const DETECTORS = Object.freeze([
    detectNode,
    detectPython,
    detectRust,
    detectGo,
    detectMaven,
    detectGradle,
]);
/**
 * Detect the stack of an already-cloned repository at `repoPath`. Returns `{ detected: true, ... }` with the
 * language, package manager, and any confidently-inferred commands, or `{ detected: false, reason }` when no
 * recognized manifest is present. Never throws.
 */
export function detectRepoStack(repoPath, options = {}) {
    if (typeof repoPath !== "string" || !repoPath.trim()) {
        return { detected: false, reason: "A repository path is required to detect the stack." };
    }
    const access = makeAccess(repoPath, options);
    for (const detector of DETECTORS) {
        const detected = detector(access);
        if (detected !== null) {
            return { detected: true, ...detected };
        }
    }
    return { detected: false, reason: NO_MANIFEST_REASON };
}
/** One-line human summary of a detection result, suitable for a coding-agent prompt or an operator log. */
export function renderStackSummary(stack) {
    if (!stack || stack.detected !== true) {
        return `stack not detected: ${stack?.reason ?? "unknown reason"}`;
    }
    const commands = [
        stack.buildCommand ? `build=\`${stack.buildCommand}\`` : null,
        stack.testCommand ? `test=\`${stack.testCommand}\`` : null,
        stack.lintCommand ? `lint=\`${stack.lintCommand}\`` : null,
        stack.formatCommand ? `format=\`${stack.formatCommand}\`` : null,
    ].filter((entry) => entry !== null);
    const suffix = commands.length > 0 ? ` (${commands.join(", ")})` : " (no validation commands detected)";
    return `${stack.language} via ${stack.packageManager ?? "unknown"}${suffix}`;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3RhY2stZGV0ZWN0aW9uLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsic3RhY2stZGV0ZWN0aW9uLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7NEdBTTRHO0FBQzVHLE9BQU8sRUFBRSxVQUFVLEVBQUUsWUFBWSxFQUFFLE1BQU0sU0FBUyxDQUFDO0FBQ25ELE9BQU8sRUFBRSxJQUFJLEVBQUUsTUFBTSxXQUFXLENBQUM7QUEwQ2pDO3dGQUN3RjtBQUN4RixNQUFNLENBQUMsTUFBTSxvQkFBb0IsR0FBc0IsTUFBTSxDQUFDLE1BQU0sQ0FBQztJQUNuRSxjQUFjO0lBQ2QsZ0JBQWdCO0lBQ2hCLFVBQVU7SUFDVixXQUFXO0lBQ1gsa0JBQWtCO0lBQ2xCLFNBQVM7SUFDVCxZQUFZO0lBQ1osUUFBUTtJQUNSLFNBQVM7SUFDVCxjQUFjO0lBQ2Qsa0JBQWtCO0NBQ25CLENBQUMsQ0FBQztBQUVILE1BQU0sa0JBQWtCLEdBQ3RCLGtKQUFrSixDQUFDO0FBRXJKLE1BQU0scUJBQXFCLEdBQXNCLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxLQUFLLEVBQUUsTUFBTSxFQUFFLE1BQU0sRUFBRSxLQUFLLENBQUMsQ0FBQyxDQUFDO0FBQy9GLE1BQU0sY0FBYyxHQUFHLE1BQU0sQ0FBQyxNQUFNLENBQUM7SUFDbkMsQ0FBQyxnQkFBZ0IsRUFBRSxNQUFNLENBQUM7SUFDMUIsQ0FBQyxXQUFXLEVBQUUsTUFBTSxDQUFDO0lBQ3JCLENBQUMsV0FBVyxFQUFFLEtBQUssQ0FBQztJQUNwQixDQUFDLG1CQUFtQixFQUFFLEtBQUssQ0FBQztDQUNwQixDQUFDLENBQUM7QUFFWjs2RkFDNkY7QUFDN0YsU0FBUyxVQUFVLENBQUMsUUFBZ0IsRUFBRSxPQUErQjtJQUNuRSxNQUFNLFVBQVUsR0FBOEIsT0FBTyxDQUFDLFVBQVUsSUFBSSxVQUFVLENBQUM7SUFDL0UsTUFBTSxRQUFRLEdBQStDLE9BQU8sQ0FBQyxZQUFZLElBQUksWUFBWSxDQUFDO0lB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