import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { docsClientLoader } from "@/lib/docs-client-loader";

// Rendered from content/docs/quickstart.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock primitives --
// not fumadocs-ui's bundled components. See docs-source.ts's comment for why the
// loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/quickstart")({
  loader: async () => {
    const { docsSource } = await import("@/lib/docs-source");
    const page = docsSource.getPage(["quickstart"]);
    if (!page) throw notFound();
    return { path: page.path, title: page.data.title, description: page.data.description };
  },
  head: () => ({
    meta: [
      { title: "Quickstart — LoopOver docs" },
      {
        name: "description",
        content:
          "Install @loopover/mcp, sign in with GitHub Device Flow, and analyze your branch in two commands.",
      },
      { property: "og:title", content: "Quickstart — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Install @loopover/mcp, sign in with GitHub Device Flow, and analyze your branch in two commands.",
      },
      { property: "og:url", content: "/docs/quickstart" },
    ],
    links: [{ rel: "canonical", href: "/docs/quickstart" }],
  }),
  component: Quickstart,
});

function Quickstart() {
  const { path, title, description } = Route.useLoaderData();
  const Content = docsClientLoader.getComponent(path);
  return (
    <DocsPage eyebrow="Get started" title={title} description={description}>
      <Suspense fallback={<p className="text-token-sm text-muted-foreground">Loading…</p>}>
        <Content />
      </Suspense>
    </DocsPage>
  );
}
