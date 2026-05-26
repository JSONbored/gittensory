# Third-Party Notices

## Gittensor Scoring References

Gittensory includes TypeScript scoring estimators and model snapshots informed by public Gittensor scoring behavior and documentation from `entrius/gittensor`.

- Upstream project: `entrius/gittensor`
- Upstream license observed locally: MIT
- Use in Gittensory: no Python modules are vendored into the Worker backend; Gittensory stores normalized model constants and implements deterministic advisory estimators in TypeScript.

Any optional local MCP score preview may invoke a user-configured local Gittensor checkout. That checkout remains separate from this repository.
