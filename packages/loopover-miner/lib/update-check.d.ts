export function resolveNpmRegistryUrl(
  env?: Record<string, string | undefined>,
): string;
export function resolveUpgradeCommand(packageName?: string): string;
export function shouldSkipUpdateCheck(
  cliArgs: string[],
  env?: Record<string, string | undefined>,
): boolean;
export function compareSemver(a: string, b: string): -1 | 0 | 1 | null;
export function fetchLatestPackageVersion(input: {
  packageName: string;
  npmRegistryUrl: string;
  timeoutMs?: number;
}): Promise<string>;
export function maybePrintUpdateNudge(input: {
  packageName: string;
  packageVersion: string;
  npmRegistryUrl: string;
  upgradeCommand: string;
  timeoutMs?: number;
}): Promise<void>;
export function startUpdateCheck(
  cliArgs: string[],
  input: {
    packageName: string;
    packageVersion: string;
    upgradeCommand?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
  },
): Promise<void>;
export const updateCheckExitGraceMs: number;
export function awaitOpportunisticUpdateCheck(
  updateCheck: Promise<void>,
  graceMs?: number,
): Promise<void>;
