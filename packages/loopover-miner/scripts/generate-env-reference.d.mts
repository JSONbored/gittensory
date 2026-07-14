export type MinerEnvReferenceRow = {
  name: string;
  firstReference: string;
  defaultValue: string | null;
};

export type MinerEnvReferenceOptions = {
  rootDir?: string;
  sourceRoots?: readonly string[];
};

export type WriteMinerEnvReferenceOptions = MinerEnvReferenceOptions & {
  outputPath?: string;
  check?: boolean;
};

export declare const DEFAULT_OUTPUT_PATH: string;
export declare const DEFAULT_SOURCE_ROOTS: readonly string[];

export declare function isMinerEnvVar(name: string): boolean;

export declare function collectMinerEnvDefaults(
  rootDir: string,
  sourceRoots?: readonly string[],
): Map<string, string>;

export declare function collectMinerEnvVars(
  options?: MinerEnvReferenceOptions,
): MinerEnvReferenceRow[];

export declare function renderMinerEnvReferenceMarkdown(rows: MinerEnvReferenceRow[]): string;

export declare function writeMinerEnvReference(
  options?: WriteMinerEnvReferenceOptions,
): {
  changed: boolean;
  outputPath: string;
  rows: MinerEnvReferenceRow[];
};
