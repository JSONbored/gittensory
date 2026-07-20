// Single source of truth for the miner package's secret-shape detector.
//
// scripts/check-miner-package.mjs uses this to reject any packed miner file that embeds a secret-like value, and
// the AMS MCP contract test (test/unit/miner-mcp-contract.test.ts) reuses the SAME pattern to assert no MCP tool
// response ever leaks one — importing it here rather than hand-duplicating the regex keeps the two byte-for-byte in
// sync instead of relying on manual vigilance.
//
// #7433: extended with 12 additional concrete secret formats (aws_access_key, slack_token, google_api_key,
// gitlab_token, npm_token, stripe_secret_key, sendgrid_key, huggingface_token, voyage_api_key, firecrawl_api_key,
// openai_api_key, anthropic_api_key), hand-copied byte-for-byte from src/review/secret-patterns.ts's
// SECRET_PATTERNS rather than imported: check-miner-package.mjs/check-mcp-package.mjs both run via plain
// `node scripts/*.mjs` (package.json's test:miner-pack/test:mcp-pack), and plain Node cannot resolve a `.ts`
// import ("Unknown file extension \".ts\"" against this repo's Node 22 runtime) without a TS loader neither
// script registers -- unlike scripts/check-engine-parity.ts, which runs via `tsx`. jwt, seed_or_mnemonic, and
// bittensor_key were deliberately left out: jwt is out of scope for this issue, and seed_or_mnemonic/
// bittensor_key are documented in secret-patterns.ts as weak, false-positive-prone heuristics (a
// `coldkey:`/`hotkey =` line or the word "mnemonic" in ordinary Bittensor docs is not a leaked credential)
// excluded from HARD_SECRET_KINDS there for the same reason.
export const FORBIDDEN_CONTENT =
  /(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|gts_[0-9a-f]{64}|[A-Z0-9_]*(TOKEN|SECRET|PRIVATE_KEY)=|\bAKIA[0-9A-Z]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\bAIza[0-9A-Za-z_-]{35}\b|\bglpat-[0-9A-Za-z_-]{20}(?![0-9A-Za-z_-])|\bnpm_[A-Za-z0-9]{36}\b|\b(?:sk|rk)_live_[0-9A-Za-z]{24,}\b|\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])|\bhf_[A-Za-z0-9]{34}\b|\b(?:pa|al)-[A-Za-z0-9]{20,}(?![A-Za-z0-9_-])|\bfc-[A-Za-z0-9]{16,}(?![A-Za-z0-9_-])|\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}\b|\bsk-ant-api03-[A-Za-z0-9_-]{93}AA\b)/;
