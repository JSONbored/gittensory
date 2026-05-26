# @jsonbored/gittensory-mcp

Local stdio MCP wrapper for Gittensory contributor intelligence.

It inspects local git metadata and calls the private Gittensory API for branch preflight, score blockers, reward/risk reasoning, contributor decision packs, and public-safe PR packets. It does not upload source contents in v1.

```bash
npx @jsonbored/gittensory-mcp login
npx @jsonbored/gittensory-mcp status
npx @jsonbored/gittensory-mcp analyze-branch --login jsonbored --json
npx @jsonbored/gittensory-mcp --stdio
```

Environment overrides:

- `GITTENSORY_API_URL`
- `GITTENSORY_CONFIG_PATH` or `GITTENSORY_CONFIG_DIR`
- `GITTENSORY_API_TOKEN`, `GITTENSORY_MCP_TOKEN`, or `GITTENSORY_TOKEN`
- `GITHUB_TOKEN` for non-interactive login bootstrap
- `GITTENSOR_SCORE_PREVIEW_CMD`
- `GITTENSORY_UPLOAD_SOURCE=false`
