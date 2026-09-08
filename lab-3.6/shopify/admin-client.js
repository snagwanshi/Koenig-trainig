/**
 * Admin API client — the WRITE half of the two-token pattern (Topic 3.5).
 *
 * ESM port of the token-exchange helper from Topic 3.2's lab. Unlike the
 * Storefront token, an Admin access token obtained by client-credentials
 * exchange expires (24 hours), so this module caches one and re-exchanges
 * before it goes stale. The client id and secret are the durable credentials;
 * the access token is disposable.
 */

const API_VERSION = "2026-07";

/**
 * Re-exchange this far before the token actually expires, so a request never
 * departs holding a token that dies in flight.
 */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** @type {string | null} */
let cachedToken = null;
/** @type {number} Epoch ms at which the cached token stops being usable. */
let cachedTokenExpiresAt = 0;
/** @type {Promise<string> | null} In-flight exchange, so concurrent tool calls share one. */
let inFlightExchange = null;

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

async function exchangeForAccessToken() {
  const domain = requireEnv("SHOPIFY_STORE_DOMAIN");
  // The handout calls these SHOPIFY_CLIENT_ID/SECRET; Topic 3.2's lab used the
  // SHOPIFY_APP_ prefix. Accept either so a .env from that lab drops straight in.
  const clientId = requireEnv("SHOPIFY_APP_CLIENT_ID", "SHOPIFY_CLIENT_ID");
  const clientSecret = requireEnv(
    "SHOPIFY_APP_CLIENT_SECRET",
    "SHOPIFY_CLIENT_SECRET",
  );

  const res = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    }),
  });

  const data = await res.json();
  if (data.access_token === undefined) {
    throw new Error(
      `Admin token exchange failed (HTTP ${res.status}): ${JSON.stringify(data)}`,
    );
  }

  cachedToken = data.access_token;
  // expires_in is seconds (86400 for a 24-hour token). Expire our copy early.
  cachedTokenExpiresAt = Date.now() + data.expires_in * 1000 - REFRESH_MARGIN_MS;

  const minutes = Math.round((cachedTokenExpiresAt - Date.now()) / 60000);
  console.log(`[admin token] exchanged, valid for ~${minutes} more minutes`);

  return cachedToken;
}

/**
 * Returns a valid Admin access token, exchanging a new one when the cached
 * token is missing or near expiry. Concurrent callers share one exchange rather
 * than each firing their own.
 *
 * @returns {Promise<string>}
 */
export async function getAdminAccessToken() {
  if (cachedToken !== null && Date.now() < cachedTokenExpiresAt) {
    return cachedToken;
  }

  if (inFlightExchange === null) {
    inFlightExchange = exchangeForAccessToken().finally(() => {
      inFlightExchange = null;
    });
  }

  return inFlightExchange;
}

/**
 * Runs one Admin GraphQL operation, refreshing the token first if needed.
 *
 * @param {string} query GraphQL document.
 * @param {object} [variables]
 * @returns {Promise<object>} The `data` object.
 */
export async function adminRequest(query, variables) {
  const domain = requireEnv("SHOPIFY_STORE_DOMAIN");
  const token = await getAdminAccessToken();

  const res = await fetch(
    `https://${domain}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    },
  );

  // A token revoked early still reads as expired to us. Drop the cache so the
  // next call exchanges a fresh one instead of retrying a dead token forever.
  if (res.status === 401) {
    cachedToken = null;
    cachedTokenExpiresAt = 0;
    throw new Error(
      "Admin API rejected the access token (401). It has been discarded; retry to exchange a new one.",
    );
  }

  if (!res.ok) {
    throw new Error(
      `Admin API returned HTTP ${res.status} ${res.statusText}.`,
    );
  }

  const json = await res.json();

  if (json.errors !== undefined) {
    throw new Error(
      json.errors.map((e) => e.message).join("; ") || "Unknown Admin error",
    );
  }

  return json.data;
}

/** Test/debug helper: what the cache currently holds, without exposing the token. */
export function adminTokenStatus() {
  return {
    cached: cachedToken !== null,
    expiresInMs: cachedToken === null ? 0 : cachedTokenExpiresAt - Date.now(),
  };
}
