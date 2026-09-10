/**
 * The MCP transport binding for the dev.ucp.shopping service.
 *
 * Each tool here corresponds to a UCP shopping operation. The server is
 * stateless per HTTP request (a fresh McpServer per POST, same as lab-4.3),
 * so any cross-call state — the session's cart, its checkout session — is
 * carried explicitly via a `sessionId` argument into sessionStore.js rather
 * than through any MCP-level session mechanism.
 *
 * Guardrails in this file:
 *  - Every tool's INPUT is enforced by its zod inputSchema (the SDK does this
 *    before the handler runs).
 *  - Every tool's OUTPUT is checked against its own zod schema before it
 *    reaches the agent — a malformed Shopify response becomes an is_error
 *    result instead of silently corrupting the conversation.
 *  - complete_checkout additionally requires the caller to echo back the
 *    total it believes it is paying (checked server-side in checkout.js
 *    against a fresh total, not a cached one). The actual human-confirmation
 *    prompt lives in agent.js — this process has no terminal to ask on.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { catalogSearch, catalogLookup } from "./capabilities/catalog.js";
import { createCart, updateCart, getCart } from "./capabilities/cart.js";
import { createCheckout, updateCheckout, completeCheckout } from "./capabilities/checkout.js";
import { getOrder, getOrderEvents } from "./capabilities/order.js";

// ---------------------------------------------------------------------------
// Result shapes + the input/output guard
// ---------------------------------------------------------------------------

function okResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function errorResult(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Runs a capability call, then checks its result against the tool's own
 * OUTPUT schema before letting it reach the agent. Both a thrown Error and a
 * failed output check become an is_error tool result rather than a crash or
 * silently-malformed data.
 */
function safe(toolName, outputSchema, fn) {
  return async (args) => {
    let result;
    try {
      result = await fn(args);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }

    const parsed = outputSchema.safeParse(result);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      console.error(`[output guard] ${toolName} produced malformed data: ${detail}`);
      return errorResult(`${toolName} produced malformed data and was blocked (${detail}).`);
    }
    return okResult(parsed.data);
  };
}

// ---------------------------------------------------------------------------
// Shared field/output schemas
// ---------------------------------------------------------------------------

const sessionIdField = z
  .string()
  .min(1)
  .describe("Opaque id for this shopper's session — the same value across every cart/checkout call in one conversation.");

const lineInput = z.object({
  variantId: z.string().min(1).describe("gid://shopify/ProductVariant/..."),
  quantity: z.number().int().min(1).default(1),
});

const money = z.object({ amount: z.string(), currencyCode: z.string() });

const catalogSearchOutput = z.array(
  z.object({
    productId: z.string(),
    title: z.string(),
    availableForSale: z.boolean(),
    price: z.string(),
    currency: z.string(),
    variantId: z.string(),
  }),
);

const catalogLookupOutput = z.union([
  z.object({
    type: z.literal("variant"),
    variantId: z.string(),
    title: z.string(),
    availableForSale: z.boolean(),
    price: z.string(),
    currency: z.string(),
    productId: z.string(),
    productTitle: z.string(),
  }),
  z.object({
    type: z.literal("product"),
    productId: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    availableForSale: z.boolean(),
    price: z.string(),
    currency: z.string(),
    variants: z.array(
      z.object({
        variantId: z.string(),
        title: z.string(),
        availableForSale: z.boolean(),
        price: z.string(),
        currency: z.string(),
      }),
    ),
  }),
]);

const cartSnapshotOutput = z.object({
  cartId: z.string(),
  checkoutUrl: z.string(),
  totalQuantity: z.number(),
  subtotal: money,
  total: money,
  lines: z.array(
    z.object({
      lineId: z.string(),
      variantId: z.string(),
      title: z.string(),
      quantity: z.number(),
      unitPrice: money,
    }),
  ),
});

const checkoutMessage = z.object({ type: z.string(), code: z.string() }).passthrough();

const checkoutSnapshotOutput = z.object({
  checkoutId: z.string(),
  name: z.string(),
  state: z.literal("incomplete"),
  total: money,
  invoiceUrl: z.string().nullable(),
  lineItems: z.array(
    z.object({
      title: z.string(),
      quantity: z.number(),
      originalUnitPriceSet: z.object({ shopMoney: money }),
    }),
  ),
  messages: z.array(checkoutMessage),
});

const completeCheckoutOutput = z.object({
  checkoutId: z.string(),
  state: z.literal("completed"),
  order: z.object({
    orderId: z.string(),
    name: z.string(),
    financialStatus: z.string(),
    fulfillmentStatus: z.string(),
  }),
  messages: z.array(checkoutMessage),
});

const getOrderOutput = z.object({
  orderId: z.string(),
  name: z.string(),
  createdAt: z.string(),
  financialStatus: z.string(),
  fulfillmentStatus: z.string(),
  total: money,
  fulfillments: z.array(
    z.object({
      status: z.string(),
      tracking: z.array(
        z.object({
          number: z.string().nullable(),
          url: z.string().nullable(),
          company: z.string().nullable(),
        }),
      ),
    }),
  ),
});

const getOrderEventsOutput = z.array(z.object({ type: z.string(), at: z.string() }).passthrough());

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function buildServer() {
  const server = new McpServer({ name: "ucp-shopping", version: "1.0.0" });

  // --- dev.ucp.shopping.catalog (baseline, not a negotiated capability) ---

  server.registerTool(
    "catalog_search",
    {
      title: "Search Catalog",
      description: "Search the store catalog for products matching a text query.",
      inputSchema: {
        query: z.string().default(""),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    safe("catalog_search", catalogSearchOutput, ({ query, limit }) => catalogSearch({ query, limit })),
  );

  server.registerTool(
    "catalog_lookup",
    {
      title: "Look Up Product or Variant",
      description: "Fetch full details for one product or one variant by id.",
      inputSchema: {
        productId: z.string().optional().describe("gid://shopify/Product/..."),
        variantId: z.string().optional().describe("gid://shopify/ProductVariant/..."),
      },
    },
    safe("catalog_lookup", catalogLookupOutput, ({ productId, variantId }) =>
      catalogLookup({ productId, variantId }),
    ),
  );

  // --- dev.ucp.shopping.cart ---

  server.registerTool(
    "create_cart",
    {
      title: "Create Cart",
      description: "Start a new cart for this session with an initial set of line items.",
      inputSchema: {
        sessionId: sessionIdField,
        lines: z.array(lineInput).min(1),
      },
    },
    safe("create_cart", cartSnapshotOutput, ({ sessionId, lines }) => createCart(sessionId, { lines })),
  );

  server.registerTool(
    "update_cart",
    {
      title: "Update Cart",
      description: "Add, change the quantity of, or remove lines on the session's existing cart.",
      inputSchema: {
        sessionId: sessionIdField,
        addLines: z.array(lineInput).optional(),
        updateLines: z
          .array(z.object({ lineId: z.string().min(1), quantity: z.number().int().min(0) }))
          .optional(),
        removeLineIds: z.array(z.string().min(1)).optional(),
      },
    },
    safe("update_cart", cartSnapshotOutput, ({ sessionId, addLines, updateLines, removeLineIds }) =>
      updateCart(sessionId, {
        addLines: addLines ?? [],
        updateLines: updateLines ?? [],
        removeLineIds: removeLineIds ?? [],
      }),
    ),
  );

  server.registerTool(
    "get_cart",
    {
      title: "Get Cart",
      description: "Read the session's current cart: lines, quantities, and totals.",
      inputSchema: { sessionId: sessionIdField },
    },
    safe("get_cart", cartSnapshotOutput, ({ sessionId }) => getCart(sessionId)),
  );

  // --- dev.ucp.shopping.checkout ---

  server.registerTool(
    "create_checkout",
    {
      title: "Create Checkout",
      description:
        "Start a checkout session from the session's current cart. Requires create_cart first. " +
        "Returns state 'incomplete'.",
      inputSchema: {
        sessionId: sessionIdField,
        email: z.string().email().optional(),
        note: z.string().optional(),
      },
    },
    safe("create_checkout", checkoutSnapshotOutput, ({ sessionId, email, note }) =>
      createCheckout(sessionId, { email, note }),
    ),
  );

  server.registerTool(
    "update_checkout",
    {
      title: "Update Checkout",
      description:
        "Re-sync the checkout session's line items from the session's cart, and/or update the " +
        "buyer email or note. Stays 'incomplete'.",
      inputSchema: {
        sessionId: sessionIdField,
        email: z.string().email().optional(),
        note: z.string().optional(),
        resyncFromCart: z.boolean().default(true),
      },
    },
    safe("update_checkout", checkoutSnapshotOutput, ({ sessionId, email, note, resyncFromCart }) =>
      updateCheckout(sessionId, { email, note, resyncFromCart }),
    ),
  );

  server.registerTool(
    "complete_checkout",
    {
      title: "Complete Checkout",
      description:
        "Finish the checkout session and place the order. SIMULATED PAYMENT: this training lab has " +
        "no real payment processor — completion is simulated via Shopify's draftOrderComplete " +
        "mutation. This is a money-moving step: get_cart/get the checkout's current total, have the " +
        "human shopper explicitly confirm it, then pass that same total back as expectedTotal. A " +
        "mismatched or stale expectedTotal is rejected.",
      inputSchema: {
        sessionId: sessionIdField,
        expectedTotal: money.describe(
          "The total you told the shopper they'd pay, e.g. from create_checkout/update_checkout's " +
            "`total`. Must match the checkout's current total or the call is rejected.",
        ),
      },
    },
    safe("complete_checkout", completeCheckoutOutput, ({ sessionId, expectedTotal }) =>
      completeCheckout(sessionId, { expectedTotal }),
    ),
  );

  // --- dev.ucp.shopping.order ---

  server.registerTool(
    "get_order",
    {
      title: "Get Order",
      description: "Look up an order's status, total, and fulfillment/tracking info by id.",
      inputSchema: { orderId: z.string().min(1).describe("gid://shopify/Order/...") },
    },
    safe("get_order", getOrderOutput, ({ orderId }) => getOrder({ orderId })),
  );

  server.registerTool(
    "get_order_events",
    {
      title: "Get Order Lifecycle Events",
      description:
        "Read this session's recorded checkout/order lifecycle events (created, updated, completed). " +
        "Stands in for the webhook push the real UCP order capability uses.",
      inputSchema: { sessionId: sessionIdField },
    },
    safe("get_order_events", getOrderEventsOutput, ({ sessionId }) => getOrderEvents(sessionId)),
  );

  return server;
}
