/**
 * The UCP business profile served at GET /.well-known/ucp.
 *
 * Shape matches the official UCP reference server (Universal-Commerce-Protocol/
 * samples, rest/python/server/routes/discovery_profile.json and rest/nodejs/src/
 * api/discovery.ts): a top-level `ucp` object (version, keys, services,
 * capabilities, payment_handlers) plus a sibling `signing_keys` array.
 *
 * Scope cuts for this training lab (documented, not hidden):
 *  - `catalog` (search/lookup) is exposed as MCP tools but is NOT declared as
 *    its own capability — the reference profile doesn't model it as one
 *    either; it's baseline dev.ucp.shopping functionality, not something a
 *    merchant opts in/out of.
 *  - `keys`/`signing_keys` are empty: this lab does not implement HTTP
 *    Message Signature request auth (RFC 9421) or signed webhook delivery.
 *    Order lifecycle events are appended in-process (see capabilities/order.js)
 *    rather than pushed to a public endpoint, so there is nothing to sign.
 *  - The declared payment handler is UCP's own published mock handler,
 *    reused as-is. This lab's complete_checkout tool does not implement its
 *    instrument/token exchange — it simulates payment directly via Shopify's
 *    draftOrderComplete mutation (see capabilities/checkout.js).
 */

export const UCP_VERSION = "2026-04-08";

// The spec requires a cacheable response: `public` with `max-age` of at
// least 60 seconds, never `private`/`no-store`/`no-cache`.
export const PROFILE_CACHE_CONTROL = "public, max-age=3600";

/**
 * @param {string} baseUrl Origin the server was reached on, e.g. "http://localhost:3300".
 */
export function buildUcpProfile(baseUrl) {
  const mcpEndpoint = `${baseUrl}/mcp`;

  const ucp = {
    version: UCP_VERSION,
    keys: [],
    services: {
      "dev.ucp.shopping": [
        {
          version: UCP_VERSION,
          spec: `https://ucp.dev/${UCP_VERSION}/specification/overview`,
          transport: "mcp",
          endpoint: mcpEndpoint,
          schema: `https://ucp.dev/${UCP_VERSION}/services/shopping/openrpc.json`,
        },
      ],
    },
    capabilities: {
      "dev.ucp.shopping.cart": [
        {
          version: UCP_VERSION,
          spec: `https://ucp.dev/${UCP_VERSION}/specification/cart`,
          schema: `https://ucp.dev/${UCP_VERSION}/schemas/shopping/cart.json`,
        },
      ],
      "dev.ucp.shopping.checkout": [
        {
          version: UCP_VERSION,
          spec: `https://ucp.dev/${UCP_VERSION}/specification/checkout`,
          schema: `https://ucp.dev/${UCP_VERSION}/schemas/shopping/checkout.json`,
        },
      ],
      "dev.ucp.shopping.order": [
        {
          version: UCP_VERSION,
          spec: `https://ucp.dev/${UCP_VERSION}/specification/order`,
          schema: `https://ucp.dev/${UCP_VERSION}/schemas/shopping/order.json`,
        },
      ],
    },
    payment_handlers: {
      "dev.mock.payment_handler": [
        {
          id: "mock_payment_handler",
          name: "mock_payment_handler",
          version: UCP_VERSION,
          spec: `https://ucp.dev/${UCP_VERSION}/schemas/mock_payment_handler/spec`,
          config_schema: `https://ucp.dev/${UCP_VERSION}/schemas/mock_payment_handler/config.json`,
          instrument_schemas: [],
          config: {
            note:
              "Declared for profile shape completeness. This lab's complete_checkout " +
              "tool does not implement this handler's instrument/token exchange — it " +
              "simulates payment directly via Shopify's draftOrderComplete mutation.",
          },
        },
      ],
    },
  };

  return { ucp, signing_keys: [] };
}
