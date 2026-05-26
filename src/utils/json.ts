export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function jsonString(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function normalizeRepoFullName(value: string): string {
  return value.trim();
}

export function repoParts(fullName: string): { owner: string; name: string } {
  if (fullName.length === 0) return { owner: "", name: "" };
  const [owner, ...rest] = fullName.split("/") as [string, ...string[]];
  return {
    owner,
    name: rest.join("/"),
  };
}
