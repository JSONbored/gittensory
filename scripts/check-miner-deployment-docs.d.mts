export type MinerDeploymentReality = {
  hasEnvRead: (name: string) => boolean;
  envReads: Iterable<string>;
  pathExists: (relativePath: string) => boolean;
  isRegisteredCommand: (name: string) => boolean;
};

export type MinerDeploymentAuditResult = {
  ok: boolean;
  failures: string[];
  claimCounts: {
    envVars: number;
    filePaths: number;
    subcommands: number;
  };
};

export function buildLiveMinerDeploymentReality(): MinerDeploymentReality;
export function runMinerDeploymentDocsAudit(opts?: {
  testMode?: string | null;
  reality?: MinerDeploymentReality;
}): MinerDeploymentAuditResult;

export type MinerDeploymentAuditIo = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: (code: number) => void;
};

export function main(env?: Record<string, string | undefined>, io?: MinerDeploymentAuditIo): number;
