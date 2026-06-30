// Install-script & lifecycle-hook auditor (brainstorm #2). For each npm dependency a PR adds/upgrades, fetches the
// registry packument and flags ones that ship preinstall/install/postinstall scripts — the #1 npm-malware execution
// vector (a script runs on `npm install`, before any code review of the package's source). The shipped CVE scan
// misses this entirely; the no-checkout reviewer can't fetch a packument. Public-safe output: package@version + the
// hook names + publish date (NOT the script body, to keep the brief compact and non-executable).
import type {
  AnalyzerDiagnostics,
  EnrichRequest,
  InstallScriptFinding,
} from "../types.js";
import type { AnalysisContext } from "../analysis-context.js";
import { extractDependencyChanges } from "./dependency-scan.js";
import { boundedFetchJson } from "../external-fetch.js";

const INSTALL_HOOKS = ["preinstall", "install", "postinstall"];
const NPM_PACKAGE_RE =
  /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/;
const SEMVER_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const MAX_PACKUMENT_LOOKUPS = 25;

interface ScanOptions {
  signal?: AbortSignal;
  analysis?: Pick<AnalysisContext, "fetchJson">;
  diagnostics?: AnalyzerDiagnostics;
}

function isSafeNpmChange(name: string, version: string): boolean {
  return NPM_PACKAGE_RE.test(name) && SEMVER_RE.test(version);
}

/** Analyzer entrypoint: changed npm deps → registry packument → only the versions that run install scripts. */
export async function scanInstallScripts(
  req: EnrichRequest,
  fetchImpl: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<InstallScriptFinding[]> {
  const findings: InstallScriptFinding[] = [];
  let lookups = 0;
  for (const change of extractDependencyChanges(req.files ?? [])) {
    if (options.signal?.aborted || lookups >= MAX_PACKUMENT_LOOKUPS) break;
    if (
      change.ecosystem !== "npm" ||
      !isSafeNpmChange(change.package, change.to)
    )
      continue;
    lookups += 1;
    const url = `https://registry.npmjs.org/${encodeURIComponent(change.package)}`;
    const fetchOptions = {
      endpointCategory: "npm-packument",
      signal: options.signal,
      fetchImpl,
      diagnostics: options.diagnostics,
      phase: "install-script",
      subcall: "npm-packument",
      maxBytes: 1024 * 1024,
      maxCallsPerCategory: MAX_PACKUMENT_LOOKUPS,
    };
    const response = options.analysis
      ? await options.analysis.fetchJson<{
          versions?: Record<string, { scripts?: Record<string, string> }>;
          time?: Record<string, string>;
        }>(url, fetchOptions)
      : await boundedFetchJson<{
          versions?: Record<string, { scripts?: Record<string, string> }>;
          time?: Record<string, string>;
        }>(url, fetchOptions);
    if (!response.ok) continue;
    const data = response.data;
    const scripts = data.versions?.[change.to]?.scripts ?? {};
    const hooks = INSTALL_HOOKS.filter(
      (hook) => typeof scripts[hook] === "string",
    );
    if (hooks.length) {
      findings.push({
        package: change.package,
        version: change.to,
        hooks,
        publishedAt: data.time?.[change.to] ?? null,
      });
    }
  }
  return findings;
}
