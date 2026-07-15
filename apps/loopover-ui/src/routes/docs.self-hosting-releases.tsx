import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { docsClientLoader } from "@/lib/docs-client-loader";

// Rendered from content/docs/self-hosting-releases.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock/FeatureRow
// primitives -- not fumadocs-ui's bundled components. See docs-source.ts's comment
// for why the loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/self-hosting-releases")({
  loader: async () => {
    const { docsSource } = await import("@/lib/docs-source");
    const page = docsSource.getPage(["self-hosting-releases"]);
    if (!page) throw notFound();
    return { path: page.path, title: page.data.title, description: page.data.description };
  },
  head: () => ({
    meta: [
      { title: "Self-host releases and images — LoopOver docs" },
      {
        name: "description",
        content:
          "Use official LoopOver self-host images, tags, source maps, custom builds, release notes, and upgrade checks.",
      },
      { property: "og:title", content: "Self-host releases and images — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Use official LoopOver self-host images, tags, source maps, custom builds, release notes, and upgrade checks.",
      },
      { property: "og:url", content: "/docs/self-hosting-releases" },
    ],
    links: [{ rel: "canonical", href: "/docs/self-hosting-releases" }],
  }),
  component: SelfHostingReleases,
});

function SelfHostingReleases() {
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
