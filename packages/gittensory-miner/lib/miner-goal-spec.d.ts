import type { ParsedMinerGoalSpec } from "@jsonbored/loopover-engine";

export function resolveMinerGoalSpec(
  repoPath: string,
  options?: {
    existsSync?: (path: string) => boolean;
    readFileSync?: (path: string, encoding: "utf8") => string;
  },
): ParsedMinerGoalSpec;
