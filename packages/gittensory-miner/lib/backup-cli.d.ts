export function runBackup(
  args: string[],
  options?: { env?: Record<string, string | undefined> },
): number;

export function runRestore(
  args: string[],
  options?: { env?: Record<string, string | undefined> },
): number;
