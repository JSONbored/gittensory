// Single source of truth for the miner package's secret-shape detector.
//
// scripts/check-miner-package.mjs uses this to reject any packed miner file that embeds a secret-like value, and
// the AMS MCP contract test (test/unit/miner-mcp-contract.test.ts) reuses the SAME pattern to assert no MCP tool
// response ever leaks one — importing it here rather than hand-duplicating the regex keeps the two byte-for-byte in
// sync instead of relying on manual vigilance.
//
// The concrete-format branches below are hand-copied — byte-for-byte — from the `re` bodies of
// src/review/secret-patterns.ts's SECRET_PATTERNS (the subset in its HARD_SECRET_KINDS, documented there as
// near-zero-false-positive and safe for an unconditional hard block). They are NOT imported from that file: its
// consumers here (check-miner-package.mjs / check-mcp-package.mjs) run under plain `node` — `node
// scripts/check-*.mjs` in ci.yml and publish-miner.yml — not `tsx`, so this .mjs cannot import a .ts source at
// runtime (check-engine-parity.ts can only because it is itself run via `tsx`). If secret-patterns.ts changes a
// shared body, update it here too. Deliberately excluded from that set: `jwt` (out of scope for this detector),
// and `seed_or_mnemonic` / `bittensor_key` (documented there as weak, false-positive-prone heuristics kept out of
// HARD_SECRET_KINDS — a `hotkey =` line or the word "mnemonic" in ordinary Bittensor docs is not a leaked secret).
export const FORBIDDEN_CONTENT =
  /(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|gts_[0-9a-f]{64}|[A-Z0-9_]*(TOKEN|SECRET|PRIVATE_KEY)=|\bAKIA[0-9A-Z]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\bAIza[0-9A-Za-z_-]{35}\b|\bglpat-[0-9A-Za-z_-]{20}(?![0-9A-Za-z_-])|\bnpm_[A-Za-z0-9]{36}\b|\b(?:sk|rk)_live_[0-9A-Za-z]{24,}\b|\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])|\bhf_[A-Za-z0-9]{34}\b|\b(?:pa|al)-[A-Za-z0-9]{20,}(?![A-Za-z0-9_-])|\bfc-[A-Za-z0-9]{16,}(?![A-Za-z0-9_-])|\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}\b|\bsk-ant-api03-[A-Za-z0-9_-]{93}AA\b)/;
