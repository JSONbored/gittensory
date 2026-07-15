import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { docsClientLoader } from "@/lib/docs-client-loader";

// Rendered from content/docs/self-hosting-configuration.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock primitives --
// not fumadocs-ui's bundled components. See docs-source.ts's comment for why the
// loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/self-hosting-configuration")({
  loader: async () => {
    const { docsSource } = await import("@/lib/docs-source");
    const page = docsSource.getPage(["self-hosting-configuration"]);
    if (!page) throw notFound();
    return { path: page.path, title: page.data.title, description: page.data.description };
  },
  head: () => ({
    meta: [
      { title: "Self-host configuration — LoopOver docs" },
      {
        name: "description",
        content:
          "Configure the self-host review service: env vars, private repo config, feature flags, review modes, and safe defaults.",
      },
      { property: "og:title", content: "Self-host configuration — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Configure the self-host review service: env vars, private repo config, feature flags, review modes, and safe defaults.",
      },
      { property: "og:url", content: "/docs/self-hosting-configuration" },
    ],
    links: [{ rel: "canonical", href: "/docs/self-hosting-configuration" }],
  }),
  component: SelfHostingConfiguration,
});

function SelfHostingConfiguration() {
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
