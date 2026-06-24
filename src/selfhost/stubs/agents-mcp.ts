// Self-host stub for agents/mcp. The Cloudflare Agents SDK MCP server is Durable-Object-backed (Workers-only),
// so on self-host the /mcp route degrades to 501 rather than dragging the Workers runtime into Node. (A native
// MCP-on-Node port is a follow-up.) Matches the createMcpHandler(...) → fetch-handler shape the caller expects.
export function createMcpHandler(..._args: unknown[]): (...args: unknown[]) => Promise<Response> {
  return async () =>
    new Response(JSON.stringify({ error: "mcp_unavailable_on_selfhost" }), { status: 501, headers: { "content-type": "application/json" } });
}
