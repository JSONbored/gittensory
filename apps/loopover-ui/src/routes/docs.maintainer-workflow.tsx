import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { docsClientLoader } from "@/lib/docs-client-loader";

// Rendered from content/docs/maintainer-workflow.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock/WorkflowMirror
// primitives -- not fumadocs-ui's bundled components. See docs-source.ts's comment for
// why the loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/maintainer-workflow")({
  loader: async () => {
    const { docsSource } = await import("@/lib/docs-source");
    const page = docsSource.getPage(["maintainer-workflow"]);
    if (!page) throw notFound();
    return { path: page.path, title: page.data.title, description: page.data.description };
  },
  head: () => ({
    meta: [
      { title: "Maintainer workflow — LoopOver docs" },
      {
        name: "description",
        content:
          "How to use LoopOver in a repo: confirmed-miner labels, sticky sanitized comments, on-demand @loopover commands.",
      },
      { property: "og:title", content: "Maintainer workflow — LoopOver docs" },
      {
        property: "og:description",
        content:
          "How to use LoopOver in a repo: confirmed-miner labels, sticky sanitized comments, on-demand @loopover commands.",
      },
      { property: "og:url", content: "/docs/maintainer-workflow" },
    ],
    links: [{ rel: "canonical", href: "/docs/maintainer-workflow" }],
  }),
  component: MaintainerWorkflow,
});

function MaintainerWorkflow() {
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
