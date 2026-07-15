import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { docsClientLoader } from "@/lib/docs-client-loader";

// Rendered from content/docs/self-hosting-rees-analyzers.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock/FeatureRow
// primitives -- not fumadocs-ui's bundled components. See docs-source.ts's comment
// for why the loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/self-hosting-rees-analyzers")({
  loader: async () => {
    const { docsSource } = await import("@/lib/docs-source");
    const page = docsSource.getPage(["self-hosting-rees-analyzers"]);
    if (!page) throw notFound();
    return { path: page.path, title: page.data.title, description: page.data.description };
  },
  head: () => ({
    meta: [
      { title: "REES analyzer reference — LoopOver docs" },
      {
        name: "description",
        content:
          "Reference for every REES analyzer available to self-hosted LoopOver review engines, including analyzer names, inputs, network behavior, and findings.",
      },
      { property: "og:title", content: "REES analyzer reference — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Reference for every REES analyzer available to self-hosted LoopOver review engines, including analyzer names, inputs, network behavior, and findings.",
      },
      { property: "og:url", content: "/docs/self-hosting-rees-analyzers" },
    ],
    links: [{ rel: "canonical", href: "/docs/self-hosting-rees-analyzers" }],
  }),
  component: SelfHostingReesAnalyzers,
});

function SelfHostingReesAnalyzers() {
  const { path, title, description } = Route.useLoaderData();
  const Content = docsClientLoader.getComponent(path);
  return (
    <DocsPage eyebrow="Self-hosting" title={title} description={description}>
      <Suspense fallback={<p className="text-token-sm text-muted-foreground">Loading…</p>}>
        <Content />
      </Suspense>
    </DocsPage>
  );
}
