import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { docsClientLoader } from "@/lib/docs-client-loader";

// Rendered from content/docs/self-hosting-unified-ams-orb.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock/FeatureRow
// primitives -- not fumadocs-ui's bundled components. See docs-source.ts's comment
// for why the loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/self-hosting-unified-ams-orb")({
  loader: async () => {
    const { docsSource } = await import("@/lib/docs-source");
    const page = docsSource.getPage(["self-hosting-unified-ams-orb"]);
    if (!page) throw notFound();
    return { path: page.path, title: page.data.title, description: page.data.description };
  },
  head: () => ({
    meta: [
      { title: "Unified ORB + AMS self-host — LoopOver docs" },
      {
        name: "description",
        content:
          "Run ORB (self-hosted PR review) and AMS (the autonomous miner) together on one host — shared state, aligned .env, and working AMS Grafana panels in fleet mode.",
      },
      { property: "og:title", content: "Unified ORB + AMS self-host — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Run ORB (self-hosted PR review) and AMS (the autonomous miner) together on one host — shared state, aligned .env, and working AMS Grafana panels in fleet mode.",
      },
      { property: "og:url", content: "/docs/self-hosting-unified-ams-orb" },
    ],
    links: [{ rel: "canonical", href: "/docs/self-hosting-unified-ams-orb" }],
  }),
  component: UnifiedAmsOrb,
});

function UnifiedAmsOrb() {
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
