import type { ParsedMinerGoalSpec } from "@jsonbored/gittensory-engine";

export function resolveMinerGoalSpec(
  repoPath: string,
  options?: {
    existsSync?: (path: string) => boolean;
    openSync?: (path: string, flags: number) => number;
    fstatSync?: (fd: number) => import("node:fs").Stats;
    readSync?: (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => number;
    closeSync?: (fd: number) => void;
  },
): ParsedMinerGoalSpec;
