import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { docsClientLoader } from "@/lib/docs-client-loader";

// Rendered from content/docs/branch-analysis.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock/FeatureRow
// primitives -- not fumadocs-ui's bundled components. See docs-source.ts's comment
// for why the loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/branch-analysis")({
  loader: async () => {
    const { docsSource } = await import("@/lib/docs-source");
    const page = docsSource.getPage(["branch-analysis"]);
    if (!page) throw notFound();
    return { path: page.path, title: page.data.title, description: page.data.description };
  },
  head: () => ({
    meta: [
      { title: "Branch analysis — LoopOver docs" },
      {
        name: "description",
        content:
          "Metadata-only analysis of a branch. Inputs, outputs, and the privacy boundary explained.",
      },
      { property: "og:title", content: "Branch analysis — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Metadata-only analysis of a branch. Inputs, outputs, and the privacy boundary explained.",
      },
      { property: "og:url", content: "/docs/branch-analysis" },
    ],
    links: [{ rel: "canonical", href: "/docs/branch-analysis" }],
  }),
  component: BranchAnalysis,
});

function BranchAnalysis() {
  const { path, title, description } = Route.useLoaderData();
  const Content = docsClientLoader.getComponent(path);
  return (
    <DocsPage eyebrow="Core concepts" title={title} description={description}>
      <Suspense fallback={<p className="text-token-sm text-muted-foreground">Loading…</p>}>
        <Content />
      </Suspense>
    </DocsPage>
  );
}
