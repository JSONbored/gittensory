import { Callout } from "@/components/site/primitives";

// AMS (gittensory-miner) observability cross-reference (#5191). A dual-role self-hoster running both ORB (the
// review service) and AMS (the miner) on one box otherwise has no in-app pointer from the operations / quickstart /
// workflow docs to the miner's observability setup. Keeping the callout — and its link target — in one place keeps
// the wording byte-identical across all three routes instead of relying on three hand-copied copies staying in sync.
//
// The target is the in-repo "Observing your miner" guide (landed in #5190): the single AMS observability entry point,
// which itself covers pointing Grafana at the redacted AMS ledger datasources AND loading an AMS dashboard from
// grafana/dashboards/. It is a markdown guide, not an in-app /docs/* route, so a GitHub-blob link is the correct
// target here — the same convention the docs already use for in-repo file references (see docs.self-hosting-configuration.tsx).
export const AMS_OBSERVABILITY_DOC_URL =
  "https://github.com/JSONbored/gittensory/blob/main/packages/loopover-miner/docs/observability.md";

/** A `note` callout pointing a dual-role ORB+AMS operator at the "Observing your miner" observability guide. */
export function AmsObservabilityCallout() {
  return (
    <Callout variant="note" title="Running the miner on this box too?">
      If you also run <strong>AMS</strong> (the <code>gittensory-miner</code>) on this host, see{" "}
      <a href={AMS_OBSERVABILITY_DOC_URL} target="_blank" rel="noopener noreferrer">
        Observing your miner
      </a>{" "}
      to point Grafana at the redacted AMS ledger datasources and load its Grafana dashboard —
      separate from the ORB review-service observability above.
    </Callout>
  );
}
