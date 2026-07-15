import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { docsClientLoader } from "@/lib/docs-client-loader";

// Rendered from content/docs/miner-workflow.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock/WorkflowMirror/
// AmsObservabilityCallout primitives -- not fumadocs-ui's bundled components. See
// docs-source.ts's comment for why the loader below resolves only a plain,
// serializable path string.
export const Route = createFileRoute("/docs/miner-workflow")({
  loader: async () => {
    const { docsSource } = await import("@/lib/docs-source");
    const page = docsSource.getPage(["miner-workflow"]);
    if (!page) throw notFound();
    return { path: page.path, title: page.data.title, description: page.data.description };
  },
  head: () => ({
    meta: [
      { title: "Miner workflow — LoopOver docs" },
      {
        name: "description",
        content: "Plan → analyze → preflight → packet. The four-step miner loop with the MCP CLI.",
      },
      { property: "og:title", content: "Miner workflow — LoopOver docs" },
      {
        property: "og:description",
        content: "Plan → analyze → preflight → packet. The four-step miner loop with the MCP CLI.",
      },
      { property: "og:url", content: "/docs/miner-workflow" },
    ],
    links: [{ rel: "canonical", href: "/docs/miner-workflow" }],
  }),
  component: MinerWorkflow,
});

export function MinerWorkflow() {
  const { path, title, description } = Route.useLoaderData();
  const Content = docsClientLoader.getComponent(path);
  return (
    <DocsPage eyebrow="Workflows" title={title} description={description}>
      <Suspense fallback={<p className="text-token-sm text-muted-foreground">Loading…</p>}>
        <Content />
      </Suspense>
    </DocsPage>
  );
}
