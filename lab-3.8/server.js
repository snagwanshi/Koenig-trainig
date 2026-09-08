/**
 * Lab 3.8 — webhook receiver
 *
 * Shopify calls us, not the other way round. Three rules shape this file:
 *
 *   1. Verify the HMAC before trusting anything. The endpoint is a public URL;
 *      without verification anyone who finds it can post fake orders.
 *   2. Verify against the RAW body bytes. Any JSON parse-and-restringify
 *      changes whitespace or key order and the signature stops matching, which
 *      is why express.json() is deliberately absent here.
 *   3. Answer fast. Shopify expects a response within 5 seconds and retries on
 *      timeout, so the 200 goes out first and the real work happens after.
 *
 * Run with: npm start
 */

import crypto from "node:crypto";
import process from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import { config as loadEnv } from "dotenv";

loadEnv();

const PORT = Number(process.env.PORT ?? 3000);

/**
 * Webhooks created through the Admin API are signed with the app's client
 * secret. A webhook configured in shopify.app.toml and deployed by the CLI is
 * signed with the same value. SHOPIFY_WEBHOOK_SECRET is here as an override for
 * the case where you were handed a separate secret.
 */
const WEBHOOK_SECRET =
  process.env.SHOPIFY_WEBHOOK_SECRET ??
  process.env.SHOPIFY_APP_CLIENT_SECRET ??
  process.env.SHOPIFY_CLIENT_SECRET;

if (WEBHOOK_SECRET === undefined || WEBHOOK_SECRET.trim() === "") {
  console.error(
    "Missing webhook signing secret. Add SHOPIFY_APP_CLIENT_SECRET (or\n" +
      "SHOPIFY_WEBHOOK_SECRET) to the .env file next to server.js.",
  );
  process.exit(1);
}

const app = express();

// ---------------------------------------------------------------------------
// HMAC verification
// ---------------------------------------------------------------------------

/**
 * Recomputes the signature over the raw body and compares it to the header.
 *
 * timingSafeEqual throws when the two buffers differ in length, so the length
 * is checked first — a plain `===` here would be a timing leak, but a length
 * mismatch is already public information (it just means "not base64 sha256").
 *
 * @param {Buffer} rawBody Exact bytes Shopify sent.
 * @param {string | undefined} hmacHeader Value of X-Shopify-Hmac-Sha256.
 * @returns {boolean}
 */
export function isValidShopifyHmac(rawBody, hmacHeader) {
  if (typeof hmacHeader !== "string" || hmacHeader === "") {
    return false;
  }

  const digest = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(rawBody)
    .digest("base64");

  const expected = Buffer.from(digest, "utf8");
  const received = Buffer.from(hmacHeader, "utf8");

  if (expected.length !== received.length) {
    return false;
  }

  return crypto.timingSafeEqual(expected, received);
}

// ---------------------------------------------------------------------------
// Deferred work
// ---------------------------------------------------------------------------

/**
 * Webhook ids already handled. Shopify retries on any non-2xx or slow response,
 * so the same event can arrive more than once — an in-memory set is enough for
 * a lab, but a real receiver would use a durable store.
 * @type {Set<string>}
 */
const handledWebhookIds = new Set();

/**
 * Stands in for the slow thing a real receiver would do: enqueue a job, call an
 * agent, write to a database. Runs AFTER the response has been sent.
 *
 * @param {string} topic
 * @param {object} payload
 * @param {string} shop
 */
async function handleEvent(topic, payload, shop) {
  switch (topic) {
    case "orders/create": {
      const lines = (payload.line_items ?? [])
        .map((item) => `      ${item.quantity} x ${item.title} @ ${item.price}`)
        .join("\n");
      console.log(
        `\n[order] ${payload.name ?? payload.id} from ${shop}\n` +
          `      customer: ${payload.email ?? payload.contact_email ?? "(none)"}\n` +
          `      total:    ${payload.total_price} ${payload.currency}\n` +
          `      items:\n${lines || "      (none)"}`,
      );
      break;
    }

    case "inventory_levels/update": {
      console.log(
        `\n[inventory] item ${payload.inventory_item_id} at location ` +
          `${payload.location_id} is now ${payload.available}`,
      );
      break;
    }

    case "app/uninstalled": {
      // Always handle this one: the access token is dead the moment it fires,
      // so anything still trying to use it will start failing.
      console.log(
        `\n[uninstalled] ${shop} removed the app — purge its tokens and stop polling it.`,
      );
      break;
    }

    default:
      console.log(`\n[${topic}] received from ${shop} (no handler)`);
  }
}

// ---------------------------------------------------------------------------
// The endpoint
// ---------------------------------------------------------------------------

/**
 * express.raw keeps the body as a Buffer instead of parsing it. Shopify sends
 * application/json, but the type is widened so a mislabelled content-type still
 * reaches the verifier rather than arriving as an empty object.
 */
app.post(
  "/webhooks",
  express.raw({ type: "*/*", limit: "5mb" }),
  (req, res) => {
    const topic = req.get("X-Shopify-Topic") ?? "(unknown)";
    const shop = req.get("X-Shopify-Shop-Domain") ?? "(unknown)";
    const webhookId = req.get("X-Shopify-Webhook-Id") ?? "";

    // Rule 1: nothing above this line trusts the body.
    if (!isValidShopifyHmac(req.body, req.get("X-Shopify-Hmac-Sha256"))) {
      console.warn(`[rejected] bad HMAC for ${topic} from ${shop}`);
      // 401 tells Shopify the request was refused. Shopify will retry, which is
      // correct: if the secret is genuinely wrong, retries surface the problem.
      return res.status(401).send("HMAC validation failed");
    }

    let payload;
    try {
      payload = JSON.parse(req.body.toString("utf8"));
    } catch {
      console.warn(`[rejected] ${topic} body was not valid JSON`);
      return res.status(400).send("Invalid JSON");
    }

    // Rule 3: acknowledge first. Everything below runs after the socket is
    // done, so a slow handler can never turn into a Shopify-side timeout.
    res.status(200).send("OK");

    if (webhookId !== "" && handledWebhookIds.has(webhookId)) {
      console.log(`[duplicate] ${topic} ${webhookId} already handled, skipping`);
      return;
    }
    if (webhookId !== "") {
      handledWebhookIds.add(webhookId);
    }

    console.log(`[accepted] ${topic} from ${shop}`);

    setImmediate(() => {
      handleEvent(topic, payload, shop).catch((error) => {
        // The response is already sent, so this can only be logged. A real
        // receiver would push the failure onto a retry queue here.
        console.error(`[handler failed] ${topic}: ${error.message}`);
      });
    });
  },
);

/** Liveness check, handy for confirming a tunnel is pointed at this process. */
app.get("/", (_req, res) => {
  res.status(200).json({ ok: true, listening: "POST /webhooks" });
});

// Only listen when run directly, so a test can import isValidShopifyHmac
// without a stray server starting up behind it.
const isMain =
  process.argv[1] !== undefined &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (isMain) {
  app.listen(PORT, () => {
    console.log(`webhook receiver listening on http://localhost:${PORT}`);
    console.log(`  POST /webhooks   <- point the Shopify subscription here`);
  });
}

export { app };
