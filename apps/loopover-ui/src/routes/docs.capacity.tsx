import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { LoadingState } from "@/components/site/state-views";
import { docsClientLoader } from "@/lib/docs-client-loader";

// Rendered from content/docs/capacity.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock/FeatureRow
// primitives -- not fumadocs-ui's bundled components. Mirrors docs.ams-sizing.tsx.
export const Route = createFileRoute("/docs/capacity")({
  loader: async () => {
    const { docsSource } = await import("@/lib/docs-source");
    const page = docsSource.getPage(["capacity"]);
    if (!page) throw notFound();
    return { path: page.path, title: page.data.title, description: page.data.description };
  },
  head: () => ({
    meta: [
      { title: "Capacity & throughput — LoopOver docs" },
      {
        name: "description",
        content:
          "Real, measured throughput/concurrency numbers and the configured PR-processing caps, so an operator can reason about capacity from data instead of guessing.",
      },
      { property: "og:title", content: "Capacity & throughput — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Real, measured throughput/concurrency numbers and the configured PR-processing caps, so an operator can reason about capacity from data instead of guessing.",
      },
      { property: "og:url", content: "/docs/capacity" },
    ],
    links: [{ rel: "canonical", href: "/docs/capacity" }],
  }),
  component: Capacity,
});

function Capacity() {
  const { path, title, description } = Route.useLoaderData();
  const Content = docsClientLoader.getComponent(path);
  return (
    <DocsPage eyebrow="Maintainers" title={title} description={description}>
      <Suspense fallback={<LoadingState />}>
        <Content />
      </Suspense>
    </DocsPage>
  );
}
