import type { ParsedMinerGoalSpec } from "@jsonbored/gittensory-engine";

export function resolveMinerGoalSpec(
  repoPath: string,
  options?: {
    existsSync?: (path: string) => boolean;
    lstatSync?: (path: string) => import("node:fs").Stats;
    openSync?: (path: string, flags: number) => number;
    fstatSync?: (fd: number) => import("node:fs").Stats;
    readFileSync?: (path: string | number, encoding: "utf8") => string;
    closeSync?: (fd: number) => void;
  },
): ParsedMinerGoalSpec;
