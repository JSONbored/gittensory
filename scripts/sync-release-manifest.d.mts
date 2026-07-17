export const MANIFEST_PATH: string;

export type SyncManifestStaleEntry = {
  workspacePath: string;
  from: string;
  to: string;
};

export type SyncManifestResult = {
  content: string;
  changed: boolean;
  stale: SyncManifestStaleEntry[];
};

export function syncManifestVersions(
  manifestJson: string,
  packageVersions: Record<string, string>,
): SyncManifestResult;

export type SyncManifestIo = {
  readFileSync: (path: string, encoding: string) => string;
  writeFileSync: (path: string, content: string) => void;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: (code: number) => void;
};

export function main(argv?: string[], io?: SyncManifestIo): number;
