import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { docsClientLoader } from "@/lib/docs-client-loader";

// Rendered from content/docs/troubleshooting.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock primitives --
// not fumadocs-ui's bundled components. See docs-source.ts's comment for why the
// loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/troubleshooting")({
  loader: async () => {
    const { docsSource } = await import("@/lib/docs-source");
    const page = docsSource.getPage(["troubleshooting"]);
    if (!page) throw notFound();
    return { path: page.path, title: page.data.title, description: page.data.description };
  },
  head: () => ({
    meta: [
      { title: "Troubleshooting — LoopOver docs" },
      {
        name: "description",
        content:
          "Diagnose MCP/CLI issues with doctor, status, and whoami. Common errors and fixes.",
      },
      { property: "og:title", content: "Troubleshooting — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Diagnose MCP/CLI issues with doctor, status, and whoami. Common errors and fixes.",
      },
      { property: "og:url", content: "/docs/troubleshooting" },
    ],
    links: [{ rel: "canonical", href: "/docs/troubleshooting" }],
  }),
  component: Troubleshooting,
});

function Troubleshooting() {
  const { path, title, description } = Route.useLoaderData();
  const Content = docsClientLoader.getComponent(path);
  return (
    <DocsPage eyebrow="Operating" title={title} description={description}>
      <Suspense fallback={<p className="text-token-sm text-muted-foreground">Loading…</p>}>
        <Content />
      </Suspense>
    </DocsPage>
  );
}
