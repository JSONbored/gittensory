import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: RootLayout,
});

function RootLayout() {
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <header className="border-b border-gray-200 px-6 py-4">
        <h1 className="text-lg font-semibold">gittensory-miner</h1>
        <p className="text-sm text-gray-500">Local, read-only view over this miner instance.</p>
      </header>
      <main className="p-6">
        <Outlet />
      </main>
    </div>
  );
}
