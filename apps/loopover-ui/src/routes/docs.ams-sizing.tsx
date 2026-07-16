import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { docsClientLoader } from "@/lib/docs-client-loader";

// Rendered from content/docs/ams-sizing.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock/FeatureRow
// primitives -- not fumadocs-ui's bundled components. See docs-source.ts's comment
// for why the loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/ams-sizing")({
  loader: async () => {
    const { docsSource } = await import("@/lib/docs-source");
    const page = docsSource.getPage(["ams-sizing"]);
    if (!page) throw notFound();
    return { path: page.path, title: page.data.title, description: page.data.description };
  },
  head: () => ({
    meta: [
      { title: "Resource sizing — LoopOver docs" },
      {
        name: "description",
        content:
          "Real, measured CPU/RAM/disk numbers for laptop mode and fleet mode, so an operator can size a host or cluster from data instead of guessing.",
      },
      { property: "og:title", content: "Resource sizing — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Real, measured CPU/RAM/disk numbers for laptop mode and fleet mode, so an operator can size a host or cluster from data instead of guessing.",
      },
      { property: "og:url", content: "/docs/ams-sizing" },
    ],
    links: [{ rel: "canonical", href: "/docs/ams-sizing" }],
  }),
  component: AmsSizing,
});

function AmsSizing() {
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
