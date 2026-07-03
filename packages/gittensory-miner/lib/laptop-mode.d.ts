export type LaptopModeInitResult = {
  configDir: string;
  configDirExisted: boolean;
  stateDbPath: string;
  stateDbExisted: boolean;
};

export type LaptopModePathCheck = {
  path: string;
  exists: boolean;
  writable: boolean;
  error: string | null;
};

export type LaptopModeStateDbCheck = LaptopModePathCheck & {
  sqliteReady: boolean;
  schemaReady: boolean;
  schemaError: string | null;
};

export type LaptopModeDoctorReport = {
  nodeVersion: string;
  configDir: LaptopModePathCheck;
  stateDb: LaptopModeStateDbCheck;
  docker: {
    available: boolean;
    detail: string;
  };
};

export function resolveLaptopModeStateDbPath(env?: Record<string, string | undefined>): string;

export function resolveLaptopModeConfigDir(env?: Record<string, string | undefined>): string;

export function initLaptopMode(input?: {
  env?: Record<string, string | undefined>;
  initStore?: (dbPath?: string) => { close(): void };
}): LaptopModeInitResult;

export function inspectLaptopMode(input?: {
  env?: Record<string, string | undefined>;
  spawnSyncFn?: typeof import("node:child_process").spawnSync;
}): LaptopModeDoctorReport;

export function formatLaptopDoctor(report: LaptopModeDoctorReport): string;
