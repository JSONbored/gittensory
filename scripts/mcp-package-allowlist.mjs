// Canonical MCP published-tarball allowlist (#6291). Shared by check-mcp-package.mjs and
// mcp-release-candidate-core.mjs so the dry-run gate and the release-candidate tarball check
// cannot drift (the previous duplicated lists already missed shipped lib/*.js files).

export const MCP_PACKAGE_ALLOWED_FILE_PATTERNS = [
  /^bin\/loopover-mcp\.js$/,
  // Compiled in-place TypeScript emit ships sibling .d.ts next to each converted lib/*.js (#7328 / #7329).
  /^lib\/cli-error\.(js|d\.ts)$/,
  /^lib\/local-branch\.(js|d\.ts)$/,
  /^lib\/format-table\.(js|d\.ts)$/,
  /^lib\/redact-local-path\.(js|d\.ts)$/,
  /^lib\/telemetry\.(js|d\.ts)$/,
  /^scripts\/gittensor-score-preview\.(mjs|py)$/,
  /^package\.json$/,
  /^README\.md$/,
  /^CHANGELOG\.md$/,
  /^LICENSE$/,
];
