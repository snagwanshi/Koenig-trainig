/**
 * Lab 3.8 — local HMAC test.
 *
 * Proves the receiver accepts a correctly signed request and rejects everything
 * else, without needing a tunnel or a real order. Start the server first:
 *
 *   npm start                  (in one terminal)
 *   node test-webhook.js       (in another)
 */

import crypto from "node:crypto";
import process from "node:process";

import { config as loadEnv } from "dotenv";

loadEnv();

const PORT = Number(process.env.PORT ?? 3000);
const URL = `http://localhost:${PORT}/webhooks`;

const SECRET =
  process.env.SHOPIFY_WEBHOOK_SECRET ??
  process.env.SHOPIFY_APP_CLIENT_SECRET ??
  process.env.SHOPIFY_CLIENT_SECRET;

if (SECRET === undefined || SECRET.trim() === "") {
  console.error("Missing SHOPIFY_APP_CLIENT_SECRET in .env");
  process.exit(1);
}

/** A trimmed-down orders/create payload, shaped like the real thing. */
const ORDER = {
  id: 5678901234567,
  name: "#TEST1001",
  email: "webhook-test@example.com",
  total_price: "1771.90",
  currency: "USD",
  line_items: [
    { id: 1, title: "The Minimal Snowboard", quantity: 2, price: "885.95" },
  ],
};

function sign(rawBody, secret = SECRET) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
}

/**
 * @param {string} label
 * @param {string} rawBody Exact bytes to send.
 * @param {string | undefined} hmac Signature header, or undefined to omit it.
 * @param {number} expected Status code this case should produce.
 */
async function send(label, rawBody, hmac, expected) {
  const headers = {
    "Content-Type": "application/json",
    "X-Shopify-Topic": "orders/create",
    "X-Shopify-Shop-Domain": process.env.SHOPIFY_STORE_DOMAIN ?? "test.myshopify.com",
    "X-Shopify-Webhook-Id": crypto.randomUUID(),
  };
  if (hmac !== undefined) {
    headers["X-Shopify-Hmac-Sha256"] = hmac;
  }

  const res = await fetch(URL, { method: "POST", headers, body: rawBody });
  const ok = res.status === expected;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label.padEnd(44)} -> ${res.status} (expected ${expected})`,
  );
  return ok;
}

const rawBody = JSON.stringify(ORDER);

const cases = [
  ["valid signature", rawBody, sign(rawBody), 200],
  ["tampered body, original signature", JSON.stringify({ ...ORDER, total_price: "0.01" }), sign(rawBody), 401],
  ["signature from the wrong secret", rawBody, sign(rawBody, "not-the-secret"), 401],
  ["missing signature header", rawBody, undefined, 401],
  ["empty signature header", rawBody, "", 401],
  ["truncated signature", rawBody, sign(rawBody).slice(0, 20), 401],
  ["signature of the right length, wrong bytes", rawBody, "A".repeat(sign(rawBody).length), 401],
];

// A duplicate delivery: same webhook id twice still answers 200, but the
// handler should only run once. Watch the server log for "[duplicate]".
const duplicateId = crypto.randomUUID();

async function sendWithId(label, id, expected) {
  const res = await fetch(URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Topic": "orders/create",
      "X-Shopify-Shop-Domain": "test.myshopify.com",
      "X-Shopify-Webhook-Id": id,
      "X-Shopify-Hmac-Sha256": sign(rawBody),
    },
    body: rawBody,
  });
  const ok = res.status === expected;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label.padEnd(44)} -> ${res.status} (expected ${expected})`);
  return ok;
}

const results = [];
for (const [label, body, hmac, expected] of cases) {
  results.push(await send(label, body, hmac, expected));
}
results.push(await sendWithId("redelivery, first attempt", duplicateId, 200));
results.push(await sendWithId("redelivery, same webhook id", duplicateId, 200));

const failed = results.filter((r) => !r).length;
console.log(
  `\n${results.length - failed}/${results.length} passed` +
    (failed === 0 ? "" : ` — ${failed} FAILED`),
);
// Set the code rather than calling process.exit(): fetch's keep-alive sockets
// are still open here, and tearing the loop down under them trips a libuv
// assertion on Windows. Letting the loop drain exits cleanly with the same code.
process.exitCode = failed === 0 ? 0 : 1;
