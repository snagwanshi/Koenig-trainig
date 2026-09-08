/**
 * Lab 3.8 — webhook registration via the Admin API.
 *
 *   node register-webhooks.js --list
 *   node register-webhooks.js --url https://abc123.trycloudflare.com/webhooks
 *   node register-webhooks.js --url <url> --topic ORDERS_CREATE
 *   node register-webhooks.js --delete <gid>
 *
 * Note the field name: WebhookSubscriptionInput takes `uri`. Most tutorials
 * still show `callbackUrl`, which was renamed and no longer exists on the
 * current API version.
 */

import process from "node:process";

import { config as loadEnv } from "dotenv";

import { adminRequest } from "./shopify/admin-client.js";

loadEnv();

/**
 * Topics are an enum in GraphQL (ORDERS_CREATE), but arrive in the
 * X-Shopify-Topic header in slash form (orders/create).
 */
const DEFAULT_TOPICS = ["ORDERS_CREATE", "APP_UNINSTALLED"];

const LIST_QUERY = `
  query Webhooks($first: Int!) {
    webhookSubscriptions(first: $first) {
      nodes {
        id
        topic
        createdAt
        apiVersion { handle }
        endpoint {
          __typename
          ... on WebhookHttpEndpoint { callbackUrl }
        }
      }
    }
  }
`;

const CREATE_MUTATION = `
  mutation CreateWebhook($topic: WebhookSubscriptionTopic!, $uri: String!) {
    webhookSubscriptionCreate(
      topic: $topic
      webhookSubscription: { uri: $uri, format: JSON }
    ) {
      webhookSubscription {
        id
        topic
        endpoint { ... on WebhookHttpEndpoint { callbackUrl } }
      }
      userErrors { field message }
    }
  }
`;

const DELETE_MUTATION = `
  mutation DeleteWebhook($id: ID!) {
    webhookSubscriptionDelete(id: $id) {
      deletedWebhookSubscriptionId
      userErrors { field message }
    }
  }
`;

function parseArgs(argv) {
  const opts = { url: null, topics: [], list: false, delete: null, help: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };

    switch (arg) {
      case "--url": opts.url = next(); break;
      case "--topic": opts.topics.push(next().toUpperCase().replace(/\//g, "_")); break;
      case "--list": opts.list = true; break;
      case "--delete": opts.delete = next(); break;
      case "--help":
      case "-h": opts.help = true; break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!opts.list && opts.delete === null && opts.url === null) {
    throw new Error("Pass --url <public-https-url>, or --list, or --delete <gid>");
  }
  if (opts.url !== null && !opts.url.startsWith("https://")) {
    throw new Error("Shopify only delivers to https:// URLs — a tunnel is required, localhost will not work");
  }

  return opts;
}

function usage() {
  console.log(
    [
      "Register Shopify webhooks against this lab's receiver.",
      "",
      "  --url <https url>  Endpoint to register, e.g. https://x.trycloudflare.com/webhooks",
      `  --topic <TOPIC>    Repeatable. Defaults to ${DEFAULT_TOPICS.join(" and ")}.`,
      "  --list             Show current subscriptions.",
      "  --delete <gid>     Remove one subscription.",
      "  -h, --help         This message.",
    ].join("\n"),
  );
}

function endpointUrl(node) {
  return node.endpoint && node.endpoint.callbackUrl
    ? node.endpoint.callbackUrl
    : `(${node.endpoint ? node.endpoint.__typename : "unknown"})`;
}

function reportUserErrors(userErrors) {
  if (!userErrors || userErrors.length === 0) return;
  throw new Error(
    userErrors
      .map((e) => `${(e.field || ["input"]).join(".")}: ${e.message}`)
      .join("; "),
  );
}

async function list() {
  const data = await adminRequest(LIST_QUERY, { first: 50 });
  const nodes = data.webhookSubscriptions.nodes;
  console.log(`${nodes.length} webhook subscription(s)\n`);
  for (const node of nodes) {
    console.log(`  ${node.topic}`);
    console.log(`    id:  ${node.id}`);
    console.log(`    url: ${endpointUrl(node)}`);
    console.log(`    api: ${node.apiVersion.handle}  created ${node.createdAt}`);
  }
  return nodes;
}

async function create(topic, uri) {
  const data = await adminRequest(CREATE_MUTATION, { topic, uri });
  const payload = data.webhookSubscriptionCreate;

  // Re-registering the same topic+url is an error, not a no-op. Treat it as
  // success so this script stays safe to re-run.
  const already = (payload.userErrors ?? []).some((e) =>
    /already been taken|already exists/i.test(e.message),
  );
  if (already) {
    console.log(`  ${topic} -> already registered for this URL, leaving it alone`);
    return;
  }

  reportUserErrors(payload.userErrors);
  const sub = payload.webhookSubscription;
  console.log(`  ${topic} -> ${endpointUrl(sub)}`);
  console.log(`    id: ${sub.id}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return usage();

  if (opts.list) {
    await list();
    return;
  }

  if (opts.delete !== null) {
    const data = await adminRequest(DELETE_MUTATION, { id: opts.delete });
    reportUserErrors(data.webhookSubscriptionDelete.userErrors);
    console.log(`Deleted ${data.webhookSubscriptionDelete.deletedWebhookSubscriptionId}`);
    return;
  }

  const topics = opts.topics.length > 0 ? opts.topics : DEFAULT_TOPICS;
  console.log(`Registering ${topics.length} topic(s) at ${opts.url}\n`);
  for (const topic of topics) {
    await create(topic, opts.url);
  }

  console.log("\nCurrent state:\n");
  await list();
}

main().catch((error) => {
  console.error("Webhook registration failed:", error.message);
  process.exit(1);
});
