import { createInstallationToken } from "./app";
import { readBoundedResponseText } from "../signals/focus-manifest-loader";

export type CodeownersRule = { pattern: string; owners: string[] };

export const CODEOWNERS_FILE_CANDIDATES = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"] as const;
const MAX_CODEOWNERS_PATTERN_LENGTH = 512;

export function parseCodeowners(content: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    rules.push({ pattern: parts[0]!, owners: parts.slice(1) });
  }
  return rules;
}

export function matchCodeowners(rules: CodeownersRule[], path: string): string[] {
  const normalizedPath = normalizePathForMatch(path);
  if (!normalizedPath) return [];
  let owners: string[] = [];
  for (const rule of rules) {
    if (matchesCodeownersPattern(normalizedPath, rule.pattern)) owners = rule.owners;
  }
  return owners;
}

function normalizePathForMatch(path: string): string {
  return String(path).replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function matchesCodeownersPattern(normalizedPath: string, rawPattern: string): boolean {
  let pattern = rawPattern.replace(/\\/g, "/").trim();
  if (!pattern) return false;
  if (pattern === "*" || pattern === "/" || pattern === "/*") return true;
  if (pattern.length > MAX_CODEOWNERS_PATTERN_LENGTH) return false;

  const anchored = pattern.startsWith("/");
  const dirOnly = pattern.endsWith("/");
  pattern = pattern.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!pattern) return true;
  const pathSegments = normalizedPath.split("/").filter(Boolean);
  const patternSegments = pattern.split("/").filter(Boolean);
  const matchesAnywhere = !anchored && patternSegments.length === 1;
  if (matchesAnywhere && !dirOnly) return pathSegments.some((segment) => globMatchSegment(segment, patternSegments[0]!));
  if (matchesAnywhere && dirOnly) {
    return pathSegments.some((segment, index) => globMatchSegment(segment, patternSegments[0]!) && index < pathSegments.length - 1);
  }
  return matchPatternSegments(pathSegments, patternSegments, dirOnly);
}

function matchPatternSegments(pathSegments: string[], patternSegments: string[], dirOnly: boolean): boolean {
  const memo = new Map<string, boolean>();
  const visit = (pathIndex: number, patternIndex: number): boolean => {
    const key = `${pathIndex}:${patternIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let matched = false;
    if (patternIndex === patternSegments.length) {
      matched = pathIndex === pathSegments.length || dirOnly || terminalPatternMatchesDirectory(patternSegments);
    } else {
      const patternSegment = patternSegments[patternIndex]!;
      if (patternSegment === "**") {
        matched =
          visit(pathIndex, patternIndex + 1) ||
          (pathIndex < pathSegments.length && visit(pathIndex + 1, patternIndex));
      } else if (pathIndex < pathSegments.length && globMatchSegment(pathSegments[pathIndex]!, patternSegment)) {
        matched = visit(pathIndex + 1, patternIndex + 1);
      }
    }
    memo.set(key, matched);
    return matched;
  };
  return visit(0, 0);
}

function terminalPatternMatchesDirectory(patternSegments: string[]): boolean {
  const terminal = patternSegments.at(-1);
  return terminal === "**" || (terminal !== undefined && !terminal.includes("*"));
}

function globMatchSegment(segment: string, pattern: string): boolean {
  const memo = new Map<string, boolean>();
  const visit = (segmentIndex: number, patternIndex: number): boolean => {
    const key = `${segmentIndex}:${patternIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let matched = false;
    if (patternIndex === pattern.length) {
      matched = segmentIndex === segment.length;
    } else {
      const patternChar = pattern[patternIndex]!;
      if (patternChar === "*") {
        let nextPatternIndex = patternIndex + 1;
        while (pattern[nextPatternIndex] === "*") nextPatternIndex += 1;
        matched = visit(segmentIndex, nextPatternIndex) || (segmentIndex < segment.length && visit(segmentIndex + 1, patternIndex));
      } else if (segmentIndex < segment.length && segment[segmentIndex] === patternChar) {
        matched = visit(segmentIndex + 1, patternIndex + 1);
      }
    }
    memo.set(key, matched);
    return matched;
  };
  return visit(0, 0);
}

export async function loadRepoCodeowners(
  env: Env,
  repoFullName: string,
  options: { installationId?: number | null | undefined; ref?: string | null | undefined } = {},
): Promise<CodeownersRule[]> {
  const slash = repoFullName.indexOf("/");
  if (slash <= 0 || slash === repoFullName.length - 1) return [];
  const owner = repoFullName.slice(0, slash);
  const name = repoFullName.slice(slash + 1);
  const ref = options.ref?.trim() || "HEAD";
  for (const path of CODEOWNERS_FILE_CANDIDATES) {
    try {
      const rawResponse = await fetch(`https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${encodeURIComponent(ref)}/${path}`, {
        headers: { Accept: "text/plain", "User-Agent": "gittensory" },
      });
      if (rawResponse.ok) {
        const rawText = await readBoundedResponseText(rawResponse);
        if (rawText !== null && rawText.trim() !== "") return parseCodeowners(rawText);
      }
    } catch {
      // Fall through to the authenticated contents API path when available.
    }
    if (!options.installationId) continue;
    try {
      const token = await createInstallationToken(env, options.installationId);
      const response = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${path
          .split("/")
          .map(encodeURIComponent)
          .join("/")}?ref=${encodeURIComponent(ref)}`,
        {
          headers: {
            Accept: "application/vnd.github.raw+json",
            Authorization: `Bearer ${token}`,
            "User-Agent": "gittensory",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      );
      if (!response.ok) continue;
      const text = await readBoundedResponseText(response);
      if (text !== null && text.trim() !== "") return parseCodeowners(text);
    } catch {
      // Try the next candidate path.
    }
  }
  return [];
}
