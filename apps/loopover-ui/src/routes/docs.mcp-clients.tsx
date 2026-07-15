import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { docsClientLoader } from "@/lib/docs-client-loader";

// Rendered from content/docs/mcp-clients.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock
// primitives -- not fumadocs-ui's bundled components. See docs-source.ts's comment
// for why the loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/mcp-clients")({
  loader: async () => {
    const { docsSource } = await import("@/lib/docs-source");
    const page = docsSource.getPage(["mcp-clients"]);
    if (!page) throw notFound();
    return { path: page.path, title: page.data.title, description: page.data.description };
  },
  head: () => ({
    meta: [
      { title: "MCP client setup — LoopOver docs" },
      {
        name: "description",
        content:
          "Wire the LoopOver MCP into Codex, Claude Desktop, Cursor, or any MCP-aware client over stdio or remote.",
      },
      { property: "og:title", content: "MCP client setup — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Wire the LoopOver MCP into Codex, Claude Desktop, Cursor, or any MCP-aware client over stdio or remote.",
      },
      { property: "og:url", content: "/docs/mcp-clients" },
    ],
    links: [{ rel: "canonical", href: "/docs/mcp-clients" }],
  }),
  component: McpClients,
});

function McpClients() {
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
