import browserCollections from "collections/browser";

import { docsMdxComponents } from "@/lib/docs-mdx-components";

// SPIKE (#6037): the client-safe counterpart to docs-source.ts (which is server-only --
// its `collections/server` import crashes if bundled into the client, see docs-source.ts).
// `collections/browser` compiles each .mdx file into its own lazily-imported ES module with
// no Node `path` dependency, so it's safe in both SSR and client bundles. A route pairs this
// with a server `loader` that resolves only the plain, serializable `page.path` string via
// docs-source.ts -- never the live MDX component itself -- then this client loader turns that
// path into the actual rendered content on both sides.
export const docsClientLoader = browserCollections.docs.createClientLoader({
  component({ default: MDXContent }, _props: Record<string, never>) {
    return <MDXContent components={docsMdxComponents} />;
  },
});
