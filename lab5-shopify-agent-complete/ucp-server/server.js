/**
 * The UCP server process for this lab: serves the business profile at
 * GET /.well-known/ucp, and the MCP transport binding for the
 * dev.ucp.shopping service at POST /mcp.
 */

import "dotenv/config";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildUcpProfile, PROFILE_CACHE_CONTROL } from "./discoveryProfile.js";
import { buildServer } from "./mcpServer.js";

const app = express();
app.use(express.json());

app.get("/.well-known/ucp", (req, res) => {
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  res.set("Cache-Control", PROFILE_CACHE_CONTROL);
  res.json(buildUcpProfile(baseUrl));
});

// Stateless mode: a fresh McpServer + transport per request. Tool-level state
// (cart, checkout) lives in sessionStore.js, keyed by the sessionId argument
// each stateful tool takes — not by anything MCP-session-scoped here.
app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = buildServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
  res.on("close", () => {
    transport.close();
    server.close();
  });
});

const PORT = process.env.PORT || 3300;
app.listen(PORT, () => {
  console.log(`[ucp-server] listening on :${PORT}`);
  console.log(`[ucp-server] profile: http://localhost:${PORT}/.well-known/ucp`);
  console.log(`[ucp-server] mcp:     http://localhost:${PORT}/mcp`);
});
