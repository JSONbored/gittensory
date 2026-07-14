export function printVersion(input: { packageName: string; packageVersion: string }): void;
export function printHelp(input: { packageName: string }): void;
export function runCli(cliArgs: string[], input: { packageName: string }): number;
