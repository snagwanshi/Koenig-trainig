/**
 * Storefront API client — the READ half of the two-token pattern (Topic 3.5).
 *
 * The Storefront token is a long-lived secret issued by the Headless channel
 * (Topic 3.3). It never expires on a timer, so there is no exchange or refresh
 * step here: the only job is attaching the right header. It can read published
 * products and manage carts, and it cannot touch orders, customers, or anything
 * else the Admin API exposes — which is exactly why the draft-order tool has to
 * use the other client.
 */

const API_VERSION = "2026-07";

function requireEnv(name, ...aliases) {
  for (const key of [name, ...aliases]) {
    const value = process.env[key];
    if (value !== undefined && value.trim() !== "") {
      return value.trim();
    }
  }
  throw new Error(
    `Missing ${name}. Add it to the .env file next to agent.js.`,
  );
}

/**
 * Runs one Storefront GraphQL operation.
 *
 * @param {string} query GraphQL document.
 * @param {object} [variables]
 * @returns {Promise<object>} The `data` object.
 */
export async function storefrontRequest(query, variables) {
  const domain = requireEnv("SHOPIFY_STORE_DOMAIN");
  // The handout calls this STOREFRONT_PRIVATE_TOKEN; the rest of this repo's
  // labs prefix it with SHOPIFY_. Accept either.
  const token = requireEnv(
    "SHOPIFY_STOREFRONT_PRIVATE_TOKEN",
    "STOREFRONT_PRIVATE_TOKEN",
  );

  const res = await fetch(`https://${domain}/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Private (server-side) tokens use this header. Public tokens meant for
      // browsers use X-Shopify-Storefront-Access-Token instead.
      "Shopify-Storefront-Private-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(
      `Storefront API returned HTTP ${res.status} ${res.statusText}. ` +
        "Check SHOPIFY_STOREFRONT_PRIVATE_TOKEN and that the Headless channel is installed.",
    );
  }

  const json = await res.json();

  // Transport/GraphQL-level errors. Per-mutation userErrors are a separate
  // thing and are handled by each caller.
  if (json.errors !== undefined) {
    throw new Error(
      json.errors.map((e) => e.message).join("; ") || "Unknown Storefront error",
    );
  }

  return json.data;
}
