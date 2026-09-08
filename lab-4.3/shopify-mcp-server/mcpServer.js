import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import { storefrontRequest } from "./storefrontClient.js";
import { adminRequest } from "./adminClient.js";

const DRAFT_ORDER_CREATE = `
  mutation CreateDraftOrder($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        name
        status
        invoiceUrl
        totalPriceSet { shopMoney { amount currencyCode } }
        lineItems(first: 20) { nodes { title quantity originalUnitPriceSet { shopMoney { amount } } } }
      }
      userErrors { field message }
    }
  }
`;

function buildServer() {
  const server = new McpServer({ name: "shopify-tools", version: "1.0.0" });

  server.registerTool(
    "search_products",
    {
      title: "Search Products",
      description: "Search the store catalog for products matching a text query.",
      inputSchema: {
        query: z.string().default(""),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async ({ query, limit }) => {
      const data = await storefrontRequest(`
        query($query: String, $limit: Int!) {
          products(first: $limit, query: $query) {
            edges { node {
              title
              availableForSale
              priceRange { minVariantPrice { amount currencyCode } }
              variants(first: 1) { edges { node { id } } }
            } }
          }
        }
      `, { query, limit });
      const products = data.products.edges.map((e) => ({
        title: e.node.title,
        price: e.node.priceRange.minVariantPrice.amount,
        currency: e.node.priceRange.minVariantPrice.currencyCode,
        availableForSale: e.node.availableForSale,
        variantId: e.node.variants.edges[0]?.node.id ?? "",
      }));
      return { content: [{ type: "text", text: JSON.stringify({ products }) }] };
    }
  );

  // Draft orders are Admin API only — the Storefront token cannot create them.
  // Uses the client-credentials exchange in adminClient.js (write_draft_orders).
  server.registerTool(
    "create_draft_order",
    {
      title: "Create Draft Order",
      description:
        "Create a draft order for one or more product variants. Returns the draft order name, total and invoice URL.",
      inputSchema: {
        lineItems: z
          .array(z.object({
            variantId: z.string().describe("gid://shopify/ProductVariant/..."),
            quantity: z.number().int().min(1).default(1),
          }))
          .min(1),
        email: z.string().email().optional().describe("Customer email for the draft order."),
        note: z.string().optional(),
      },
    },
    async ({ lineItems, email, note }) => {
      const input = { lineItems };
      if (email) input.email = email;
      if (note) input.note = note;

      const data = await adminRequest(DRAFT_ORDER_CREATE, { input });
      const { draftOrder, userErrors } = data.draftOrderCreate;

      if (userErrors.length > 0) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ userErrors }) }],
        };
      }
      return { content: [{ type: "text", text: JSON.stringify({ draftOrder }) }] };
    }
  );

  return server;
}

const app = express();
app.use(express.json());
// Stateless mode: a fresh server + transport per request. Simple, and enough
// for tools with no cross-call session state (Module 5's cart tool needs a
// session id of its own if you bring it into this same server).
app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = buildServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
  res.on("close", () => { transport.close(); server.close(); });
});
app.listen(3200, () => console.log("MCP server listening on :3200/mcp"));
