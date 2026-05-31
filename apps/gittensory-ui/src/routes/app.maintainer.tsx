import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/app/maintainer")({
  beforeLoad: () => {
    throw redirect({ to: "/app/repos", search: { tab: "maintainer" } });
  },
});
