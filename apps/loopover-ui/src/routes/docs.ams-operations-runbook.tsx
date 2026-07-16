import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { docsClientLoader } from "@/lib/docs-client-loader";

// Rendered from content/docs/ams-operations-runbook.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock/FeatureRow
// primitives -- not fumadocs-ui's bundled components. See docs-source.ts's comment
// for why the loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/ams-operations-runbook")({
  loader: async () => {
    const { docsSource } = await import("@/lib/docs-source");
    const page = docsSource.getPage(["ams-operations-runbook"]);
    if (!page) throw notFound();
    return { path: page.path, title: page.data.title, description: page.data.description };
  },
  head: () => ({
    meta: [
      { title: "AMS operations runbook — LoopOver docs" },
      {
        name: "description",
        content:
          "Recover from SQLite lock contention, ledger corruption, and post-upgrade schema migrations in loopover-miner's local state.",
      },
      { property: "og:title", content: "AMS operations runbook — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Recover from SQLite lock contention, ledger corruption, and post-upgrade schema migrations in loopover-miner's local state.",
      },
      { property: "og:url", content: "/docs/ams-operations-runbook" },
    ],
    links: [{ rel: "canonical", href: "/docs/ams-operations-runbook" }],
  }),
  component: AmsOperationsRunbook,
});

function AmsOperationsRunbook() {
  const { path, title, description } = Route.useLoaderData();
  const Content = docsClientLoader.getComponent(path);
  return (
    <DocsPage eyebrow="Maintainers" title={title} description={description}>
      <Suspense fallback={<p className="text-token-sm text-muted-foreground">Loading…</p>}>
        <Content />
      </Suspense>
    </DocsPage>
  );
}
