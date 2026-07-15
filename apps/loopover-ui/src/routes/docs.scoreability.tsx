import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { docsClientLoader } from "@/lib/docs-client-loader";

// Rendered from content/docs/scoreability.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock primitives --
// not fumadocs-ui's bundled components. See docs-source.ts's comment for why the
// loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/scoreability")({
  loader: async () => {
    const { docsSource } = await import("@/lib/docs-source");
    const page = docsSource.getPage(["scoreability"]);
    if (!page) throw notFound();
    return { path: page.path, title: page.data.title, description: page.data.description };
  },
  head: () => ({
    meta: [
      { title: "Scoreability — LoopOver docs" },
      {
        name: "description",
        content:
          "Scoreability scenarios explained: current gated, underlying potential, clean-gate, after-pending-merges, linked-issue-fixed, best-reasonable. Estimates only.",
      },
      { property: "og:title", content: "Scoreability — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Scoreability scenarios explained: current gated, underlying potential, clean-gate, after-pending-merges, linked-issue-fixed, best-reasonable. Estimates only.",
      },
      { property: "og:url", content: "/docs/scoreability" },
    ],
    links: [{ rel: "canonical", href: "/docs/scoreability" }],
  }),
  component: Scoreability,
});

function Scoreability() {
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
