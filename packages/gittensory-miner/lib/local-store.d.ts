import type { DatabaseSync } from "node:sqlite";

export function resolveLocalStoreDbPath(
  env: Record<string, string | undefined>,
  overrideEnvVar: string,
  defaultFileName: string,
): string;

export function openLocalStoreDb(resolvedPath: string): DatabaseSync;
