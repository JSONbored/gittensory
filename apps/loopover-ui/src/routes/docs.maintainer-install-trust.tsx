import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { docsClientLoader } from "@/lib/docs-client-loader";

// Rendered from content/docs/maintainer-install-trust.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock/FeatureRow primitives --
// not fumadocs-ui's bundled components. See docs-source.ts's comment for why the loader below
// resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/maintainer-install-trust")({
  loader: async () => {
    const { docsSource } = await import("@/lib/docs-source");
    const page = docsSource.getPage(["maintainer-install-trust"]);
    if (!page) throw notFound();
    return { path: page.path, title: page.data.title, description: page.data.description };
  },
  head: () => ({
    meta: [
      { title: "Maintainer install and trust guide — LoopOver docs" },
      {
        name: "description",
        content:
          "Self-host and install a LoopOver GitHub App as a maintainer, verify trust boundaries, preview public output, and decide when GitHub App checks are safe to enable. Self-hosting is the only currently available path.",
      },
      {
        property: "og:title",
        content: "Maintainer install and trust guide — LoopOver docs",
      },
      {
        property: "og:description",
        content:
          "Self-host and install a LoopOver GitHub App as a maintainer, verify trust boundaries, preview public output, and decide when GitHub App checks are safe to enable. Self-hosting is the only currently available path.",
      },
      { property: "og:url", content: "/docs/maintainer-install-trust" },
    ],
    links: [{ rel: "canonical", href: "/docs/maintainer-install-trust" }],
  }),
  component: MaintainerInstallTrust,
});

function MaintainerInstallTrust() {
  const { path, title, description } = Route.useLoaderData();
  const Content = docsClientLoader.getComponent(path);
  return (
    <DocsPage eyebrow="Launch guide" title={title} description={description}>
      <Suspense fallback={<p className="text-token-sm text-muted-foreground">Loading…</p>}>
        <Content />
      </Suspense>
    </DocsPage>
  );
}
