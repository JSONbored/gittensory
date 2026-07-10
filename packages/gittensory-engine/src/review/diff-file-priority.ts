import { isTestPath } from "../signals/test-evidence.js";

export function diffFilePriority(path: string): number {
  if (/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock|bun\.lockb|cargo\.lock|poetry\.lock|pipfile\.lock|composer\.lock|gemfile\.lock|go\.sum|go\.work\.sum|uv\.lock|packages\.lock\.json|flake\.lock|deno\.lock|pubspec\.lock|podfile\.lock|mix\.lock|package\.resolved|gradle\.lockfile|pdm\.lock|conan\.lock|pixi\.lock|cartfile\.resolved|gopkg\.lock|shard\.lock|rebar\.lock|renv\.lock|chart\.lock)$|\.(min\.(js|css)|map|snap)$/i.test(path)) return 4;
  if (/(^|\/)(dist|build|out|coverage|vendor|node_modules)\//i.test(path)) return 4;
  if (/\.(md|mdx|markdown|rst|adoc|asciidoc|txt)$/i.test(path)) return 2;
  if (isTestPath(path)) return 1;
  return 0;
}
