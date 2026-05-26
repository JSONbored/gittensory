# Security

Gittensory is private beta software. Please do not include secrets, API tokens, private keys,
wallet details, webhook payload secrets, or sensitive contributor evidence in public issues,
pull requests, screenshots, or logs.

## Reporting

Until GitHub private vulnerability reporting is enabled for the public repository, report security
issues directly to the repository owner through a private channel. Once public vulnerability
reporting is enabled, use GitHub Security Advisories.

## Privacy Posture

- Gittensory does not store user GitHub PATs.
- Public PR comments are opt-in and sanitized.
- Detailed contributor evidence belongs in private API responses and GitHub check runs.
- Wallet details, raw trust scores, private rankings, and negative labels must not be published in
  public comments or public issue templates.
- GitHub App private keys, webhook secrets, MCP tokens, API tokens, and internal job tokens must be
  stored as Cloudflare secrets.

## Supported Version

Private beta support tracks the current `main` branch.
