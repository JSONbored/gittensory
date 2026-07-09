# MinerGoalSpec (`.gittensory-miner.yml`)

Per-repo configuration telling an autonomous Gittensory miner what to look for and how to behave when targeting a repo. Parsed by `@jsonbored/gittensory-engine` (`parseMinerGoalSpec` / `parseMinerGoalSpecContent`); this document is the field reference. Machine-readable shape: [`../schema/miner-goal-spec.schema.json`](../schema/miner-goal-spec.schema.json). Copy [`.gittensory-miner.yml.example`](../../../.gittensory-miner.yml.example) to `.gittensory-miner.yml` and edit.

Discovery order (first match wins):

- `.gittensory-miner.yml`
- `.github/gittensory-miner.yml`
- `.gittensory-miner.json`
- `.github/gittensory-miner.json`

Every field is optional. Unknown keys are ignored; a malformed field falls back to its documented default with a warning — a broken file never hard-fails the miner.

## Relationship to `.gittensory.yml`

| File | Actor | Purpose |
|------|-------|---------|
| `.gittensory.yml` | Review stack | How a maintainer's repo **reviews** incoming PRs (focus manifest, gate, scoring knobs). |
| `.gittensory-miner.yml` | Miner runtime | How a miner **searches for and prioritizes** work in a target repo. |

They are read by different components and do not conflict. A miner should still treat a target repo's public `.gittensory.yml` `wantedPaths` / `blockedPaths` as a hard floor when both files exist.

## Fields

### `minerEnabled` (boolean, default: `true`)

Explicit opt-out: a public repo with no file remains minable. Set `false` to halt all miner targeting.

### `wantedPaths` (string list, default: `[]`)

Work areas the maintainer wants a miner to focus on. Glob list. Empty means no preference.

### `blockedPaths` (string list, default: `[]`)

Paths off-limits to a miner; candidates touching one should be skipped. Glob list. Mirrors `.gittensory.yml` `blockedPaths` semantics.

### `preferredLabels` (string list, default: `[]`)

Issue labels a miner should favor. Empty means no preference.

### `blockedLabels` (string list, default: `[]`)

Issue labels a miner must skip.

### `maxConcurrentClaims` (integer `>= 1`, default: `1`)

Maximum issues one miner may hold claimed on this repo at once.

### `issueDiscoveryPolicy` (`encouraged` | `neutral` | `discouraged`, default: `neutral`)

How strongly this repo encourages a miner to open discovery issues.

### `feasibilityGate` (mapping, default: `{}`)

Per-repo tuning of the analyze-phase feasibility gate (`buildFeasibilityVerdict`). This block carries the
maintainer's intent only; the gate consumer enforces it. It is scoped to reason suppression — a repo can opt out
of specific avoid/raise reason codes while leaving every other reason in force.

- **`suppressAvoidReasons`** — avoid-reason codes this repo opts out of. String list. Default: `[]`.
- **`suppressRaiseReasons`** — raise-reason codes this repo opts out of. String list. Default: `[]`.

Reason codes are the strings `buildFeasibilityVerdict` emits (e.g. `duplicate_cluster_medium`,
`claim_status_claimed`, `issue_quality_uncertain`); an unknown code is kept verbatim and simply never matches.

```yaml
feasibilityGate:
  suppressAvoidReasons:
    - duplicate_cluster_high
  suppressRaiseReasons:
    - claim_status_claimed
```
