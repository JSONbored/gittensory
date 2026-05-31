import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/app/digest")({
  beforeLoad: () => {
    throw redirect({ to: "/app/workbench", search: { tab: "digest" } });
  },
});
