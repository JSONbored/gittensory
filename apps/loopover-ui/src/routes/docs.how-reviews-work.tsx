import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { docsClientLoader } from "@/lib/docs-client-loader";

// Rendered from content/docs/how-reviews-work.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock primitives --
// not fumadocs-ui's bundled components. See docs-source.ts's comment for why the
// loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/how-reviews-work")({
  loader: async () => {
    const { docsSource } = await import("@/lib/docs-source");
    const page = docsSource.getPage(["how-reviews-work"]);
    if (!page) throw notFound();
    return { path: page.path, title: page.data.title, description: page.data.description };
  },
  head: () => ({
    meta: [
      { title: "How reviews work — LoopOver docs" },
      {
        name: "description",
        content:
          "How LoopOver reviews a pull request: the deterministic gate, the dual-AI review and consensus, the unified review comment, and the signals behind a verdict.",
      },
      { property: "og:title", content: "How reviews work — LoopOver docs" },
      {
        property: "og:description",
        content:
          "How LoopOver reviews a pull request: the deterministic gate, the dual-AI review and consensus, the unified review comment, and the signals behind a verdict.",
      },
      { property: "og:url", content: "/docs/how-reviews-work" },
    ],
    links: [{ rel: "canonical", href: "/docs/how-reviews-work" }],
  }),
  component: HowReviewsWork,
});

function HowReviewsWork() {
  const { path, title, description } = Route.useLoaderData();
  const Content = docsClientLoader.getComponent(path);
  return (
    <DocsPage eyebrow="Reviews" title={title} description={description}>
      <Suspense fallback={<p className="text-token-sm text-muted-foreground">Loading…</p>}>
        <Content />
      </Suspense>
    </DocsPage>
  );
}
