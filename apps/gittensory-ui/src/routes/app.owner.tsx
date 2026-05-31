import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/app/owner")({
  beforeLoad: () => {
    throw redirect({ to: "/app/repos", search: { tab: "owner" } });
  },
});
