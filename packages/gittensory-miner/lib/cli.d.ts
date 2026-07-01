export type VersionPrintInput = {
  packageName: string;
  packageVersion: string;
};

export type HelpPrintInput = {
  packageName: string;
};

export declare function printVersion(input: VersionPrintInput): void;
export declare function printHelp(input: HelpPrintInput): void;
export declare function runCli(cliArgs: string[], input: HelpPrintInput): number;
