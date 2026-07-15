import { Link } from "@tanstack/react-router";
import type { MDXComponents } from "mdx/types";
import type { AnchorHTMLAttributes } from "react";

import { AmsObservabilityCallout } from "@/components/site/ams-observability-callout";
import { CommandTable } from "@/components/site/command-table";
import { Callout, CodeBlock, FeatureRow } from "@/components/site/primitives";
import { WorkflowMirror } from "@/components/site/workflow-mirror";

function MdxAnchor({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  if (href?.startsWith("/")) {
    return (
      <Link to={href} {...rest}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}

export const docsMdxComponents: MDXComponents = {
  a: MdxAnchor,
  Callout,
  CodeBlock,
  FeatureRow,
  AmsObservabilityCallout,
  CommandTable,
  WorkflowMirror,
};
