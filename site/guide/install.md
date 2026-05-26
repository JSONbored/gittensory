# Install

Gittensory has two install paths: public npm for normal use, and local checkout for development.

## Public npm

Use this for Codex, Claude Desktop, Cursor, or any other stdio MCP client:

```sh
npm install -g @jsonbored/gittensory-mcp
gittensory-mcp login
gittensory-mcp status
gittensory-mcp --stdio
```

The login command uses GitHub Device Flow and stores a short-lived Gittensory session token in your local config directory.

## Local checkout

Use this when developing Gittensory itself:

```sh
git clone https://github.com/JSONbored/gittensory.git
cd gittensory
npm install
npm link --workspace @jsonbored/gittensory-mcp
gittensory-mcp login
gittensory-mcp --stdio
```

## Verify The Install

Run:

```sh
gittensory-mcp doctor
gittensory-mcp whoami
gittensory-mcp analyze-branch --login YOUR_GITHUB_LOGIN --json
```

`doctor` checks API health, auth state, source-upload defaults, local git metadata, and whether the binary is likely visible to MCP clients.

## Privacy Defaults

Gittensory MCP v1 sends structured metadata only:

- repository full name
- branch and base refs
- changed file paths and counts
- linked issue references
- commit messages
- validation command summaries

It does not upload source contents. `GITTENSORY_UPLOAD_SOURCE=true` is rejected.
