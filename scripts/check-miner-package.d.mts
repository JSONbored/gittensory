/** Type surface for the parts of check-miner-package.mjs imported by tests (#5199). */
export const FORBIDDEN_CONTENT: RegExp;
export function validateMinerPackFileList(
  files: Array<string | { path: string }>,
  readContent: (file: string) => string,
): string[];
export function runMinerPackCheck(options?: {
  pack?: { files: Array<string | { path: string }> };
  packageRoot?: string;
  readContent?: (file: string) => string;
}): string;
