/**
 * Lab 3.6 — Shopify-backed tool agent
 *
 * Lab 2.6's multi-tool agent with the mock data torn out. The three tools now
 * call real Shopify GraphQL APIs, keeping 2.6's two-sided guards: a zod INPUT
 * schema the SDK enforces before the handler runs, and a zod OUTPUT schema this
 * file enforces before the result reaches Claude.
 *
 * The two-token pattern from Topic 3.5 is the point of the split:
 *
 *   search_products         -> Storefront API   (read-only token)
 *   create_cart_with_item   -> Storefront API   (read-only token)
 *   create_draft_order      -> Admin API        (client-credentials exchange)
 *
 * Only the third tool can write to the store, and only it asks for confirmation
 * — inheriting the guardrail calculate_discount had in Lab 2.6.
 *
 * Run with: npm start        Leave with: exit
 *
 * Note: ES modules, not CommonJS — the Claude Agent SDK ships ESM only, which
 * is why package.json sets "type": "module".
 */

import { createInterface } from "node:readline/promises";
import process from "node:process";

import {
  createSdkMcpServer,
  query,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { config as loadEnv } from "dotenv";
import { z } from "zod";

import { storefrontRequest } from "./shopify/storefront-client.js";
import { adminRequest } from "./shopify/admin-client.js";

// ---------------------------------------------------------------------------
// 1. Environment
// ---------------------------------------------------------------------------

loadEnv();

/**
 * Two credential sets, checked up front so a missing one fails at startup with
 * a readable message rather than mid-conversation inside a tool call.
 */
const REQUIRED_ENV = [
  ["ANTHROPIC_API_KEY"],
  ["SHOPIFY_STORE_DOMAIN"],
  ["SHOPIFY_STOREFRONT_PRIVATE_TOKEN", "STOREFRONT_PRIVATE_TOKEN"],
  ["SHOPIFY_APP_CLIENT_ID", "SHOPIFY_CLIENT_ID"],
  ["SHOPIFY_APP_CLIENT_SECRET", "SHOPIFY_CLIENT_SECRET"],
];

const missing = REQUIRED_ENV.filter((names) =>
  names.every((name) => {
    const value = process.env[name];
    return value === undefined || value.trim() === "";
  }),
).map((names) => names[0]);

if (missing.length > 0) {
  console.error(
    "Missing required environment variables:\n" +
      missing.map((name) => `  ${name}`).join("\n") +
      "\n\nCreate a .env file next to agent.js containing:\n" +
      "  ANTHROPIC_API_KEY=sk-ant-...\n" +
      "  SHOPIFY_STORE_DOMAIN=your-store.myshopify.com\n" +
      "  SHOPIFY_STOREFRONT_PRIVATE_TOKEN=...   # Headless channel, Topic 3.3\n" +
      "  SHOPIFY_APP_CLIENT_ID=...              # custom app, Topic 3.2\n" +
      "  SHOPIFY_APP_CLIENT_SECRET=...",
  );
  process.exit(1);
}

/**
 * One shared readline interface for the whole process. Both the REPL prompt and
 * the draft-order confirmation read from it — they never overlap, because the
 * REPL only asks for input between turns, while a tool only asks mid-turn.
 */
const rl = createInterface({ input: process.stdin, output: process.stdout });

const lines = rl[Symbol.asyncIterator]();

/**
 * Writes a prompt and reads the next line.
 * @param {string} promptText
 * @returns {Promise<string | null>} The line, or null at end of input.
 */
async function readLine(promptText) {
  process.stdout.write(promptText);
  const next = await lines.next();
  if (next.done === true || next.value === undefined) {
    return null;
  }
  return next.value;
}

// ---------------------------------------------------------------------------
// 2. Tool results — the two shapes a handler can return
// ---------------------------------------------------------------------------

/**
 * A successful tool result: validated payload, serialized for the model.
 * @param {unknown} payload
 */
function okResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

/**
 * A failed tool result. `isError: true` tells Claude the call did not succeed,
 * so it can explain or recover rather than treating the text as data.
 * @param {string} message
 */
function errorResult(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * The output guard. Every handler runs its payload through its own zod output
 * schema here. Malformed data becomes an is_error result and never reaches
 * Claude. This matters more now than it did in Lab 2.6: the payloads are real
 * API responses, so a schema change or an unexpected null is caught here rather
 * than being narrated to the user as fact.
 *
 * @param {string} toolName
 * @param {import("zod").ZodType} schema The tool's OUTPUT schema.
 * @param {unknown} payload What the handler produced.
 */
function validateOutput(toolName, schema, payload) {
  const parsed = schema.safeParse(payload);
  if (parsed.success) {
    return okResult(parsed.data);
  }

  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");

  console.log(`\n[output guard] ${toolName} failed its own output schema`);
  console.log(`  ${detail}`);

  return errorResult(
    `${toolName} produced malformed data and was blocked before reaching the agent (${detail}).`,
  );
}

// ---------------------------------------------------------------------------
// 3. Shared helpers for real Shopify data
// ---------------------------------------------------------------------------

/**
 * Both APIs hand back variant ids as gids, but a human copying one out of the
 * admin URL bar has only the numeric part. Accept either.
 * @param {string} value
 * @returns {string}
 */
function toVariantGid(value) {
  const id = String(value).trim();
  if (id.startsWith("gid://shopify/ProductVariant/")) {
    return id;
  }
  if (/^\d+$/.test(id)) {
    return `gid://shopify/ProductVariant/${id}`;
  }
  throw new Error(
    `"${value}" is not a product variant id. Expected a number or a gid://shopify/ProductVariant/... value.`,
  );
}

/**
 * Shopify returns money as a decimal *string* ("885.95") to avoid float
 * surprises. The output schemas want numbers, so convert here — and let NaN
 * through deliberately, because the output guard rejecting it is more useful
 * than this function throwing.
 * @param {unknown} amount
 * @returns {number}
 */
function toNumber(amount) {
  return Number(amount);
}

/** Collapses a mutation's userErrors into one message, or null if there were none. */
function userErrorMessage(userErrors) {
  if (!Array.isArray(userErrors) || userErrors.length === 0) {
    return null;
  }
  return userErrors
    .map((e) => `${(e.field || ["input"]).join(".")}: ${e.message}`)
    .join("; ");
}

// ---------------------------------------------------------------------------
// 4. GraphQL documents
// ---------------------------------------------------------------------------

const SEARCH_PRODUCTS_QUERY = `
  query SearchProducts($query: String!, $first: Int!) {
    products(first: $first, query: $query) {
      nodes {
        id
        title
        handle
        availableForSale
        variants(first: 1) {
          nodes {
            id
            title
            availableForSale
            price { amount currencyCode }
          }
        }
      }
    }
  }
`;

const CART_CREATE_MUTATION = `
  mutation CartCreate {
    cartCreate {
      cart { id checkoutUrl }
      userErrors { field message }
    }
  }
`;

const CART_LINES_ADD_MUTATION = `
  mutation CartLinesAdd($cartId: ID!, $lines: [CartLineInput!]!) {
    cartLinesAdd(cartId: $cartId, lines: $lines) {
      cart {
        id
        checkoutUrl
        totalQuantity
        cost { totalAmount { amount currencyCode } }
        lines(first: 20) {
          nodes {
            quantity
            merchandise {
              ... on ProductVariant {
                id
                title
                product { title }
              }
            }
          }
        }
      }
      userErrors { field message }
    }
  }
`;

/** Admin-side lookup so the confirmation prompt can name what it is about to create. */
const VARIANT_PREVIEW_QUERY = `
  query VariantPreview($id: ID!) {
    productVariant(id: $id) {
      id
      title
      price
      inventoryQuantity
      product { title status }
    }
  }
`;

const DRAFT_ORDER_CREATE_MUTATION = `
  mutation CreateDraftOrder($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        name
        invoiceUrl
        status
        totalPriceSet { shopMoney { amount currencyCode } }
        lineItems(first: 20) {
          nodes {
            title
            variantTitle
            quantity
          }
        }
      }
      userErrors { field message }
    }
  }
`;

// ---------------------------------------------------------------------------
// 5. The three tools — zod in, zod out
// ---------------------------------------------------------------------------

const MCP_SERVER_NAME = "shopify-tools";

const MAX_SEARCH_RESULTS = 5;

/** OUTPUT schema for search_products. */
const searchProductsOutput = z.object({
  query: z.string(),
  count: z.number().int().nonnegative(),
  products: z
    .array(
      z.object({
        title: z.string().min(1),
        price: z.number().nonnegative(),
        currency: z.string().length(3),
        variantId: z.string().startsWith("gid://shopify/ProductVariant/"),
        availableForSale: z.boolean(),
      }),
    )
    .max(MAX_SEARCH_RESULTS),
});

const searchProducts = tool(
  "search_products",
  "Search the store's published products by keyword. Returns up to five matches " +
    "with title, price, and the variant id needed to build a cart or draft order.",
  {
    query: z
      .string()
      .min(1)
      .describe('Search keywords, e.g. "snowboard" or "ski wax".'),
  },
  async (args) => {
    let data;
    try {
      data = await storefrontRequest(SEARCH_PRODUCTS_QUERY, {
        query: args.query,
        first: MAX_SEARCH_RESULTS,
      });
    } catch (error) {
      return errorResult(`Storefront product search failed: ${error.message}`);
    }

    const nodes = data.products.nodes;
    if (nodes.length === 0) {
      return errorResult(
        `No published products matched "${args.query}". Try a different keyword — ` +
          "note that only products published to the Headless sales channel are visible here.",
      );
    }

    const products = nodes
      // A product with no variants cannot be bought, so it is not a useful result.
      .filter((node) => node.variants.nodes.length > 0)
      .map((node) => {
        const variant = node.variants.nodes[0];
        return {
          title: node.title,
          price: toNumber(variant.price.amount),
          currency: variant.price.currencyCode,
          variantId: variant.id,
          availableForSale: variant.availableForSale,
        };
      });

    return validateOutput("search_products", searchProductsOutput, {
      query: args.query,
      count: products.length,
      products,
    });
  },
);

/** OUTPUT schema for create_cart_with_item. */
const cartOutput = z.object({
  cartId: z.string().min(1),
  checkoutUrl: z.string().url(),
  totalQuantity: z.number().int().positive(),
  totalAmount: z.number().nonnegative(),
  currency: z.string().length(3),
  lines: z.array(
    z.object({
      title: z.string().min(1),
      quantity: z.number().int().positive(),
    }),
  ),
});

const createCartWithItem = tool(
  "create_cart_with_item",
  "Create a Storefront cart containing one product variant and return its " +
    "checkout URL. Read-only with respect to the store: a cart is not an order.",
  {
    variantId: z
      .string()
      .min(1)
      .describe(
        "Product variant id from search_products, e.g. gid://shopify/ProductVariant/48229038260276.",
      ),
    quantity: z
      .number()
      .int()
      .positive()
      .describe("How many of that variant to add."),
  },
  async (args) => {
    let variantId;
    try {
      variantId = toVariantGid(args.variantId);
    } catch (error) {
      return errorResult(error.message);
    }

    try {
      // Step 1 — an empty cart. cartCreate can accept lines directly, but the
      // two-step version is what the lab exercises and it keeps the failure
      // modes distinguishable.
      const createData = await storefrontRequest(CART_CREATE_MUTATION);
      const createErrors = userErrorMessage(createData.cartCreate.userErrors);
      if (createErrors !== null) {
        return errorResult(`cartCreate was rejected: ${createErrors}`);
      }

      const cartId = createData.cartCreate.cart.id;

      // Step 2 — put the requested variant in it.
      const addData = await storefrontRequest(CART_LINES_ADD_MUTATION, {
        cartId,
        lines: [{ merchandiseId: variantId, quantity: args.quantity }],
      });
      const addErrors = userErrorMessage(addData.cartLinesAdd.userErrors);
      if (addErrors !== null) {
        return errorResult(`cartLinesAdd was rejected: ${addErrors}`);
      }

      const cart = addData.cartLinesAdd.cart;

      // Shopify does not reject an unpurchasable variant here — it accepts the
      // line and silently clamps its quantity to 0. Without this check the tool
      // would hand back a real-looking checkout URL for an empty cart.
      if (cart.totalQuantity !== args.quantity) {
        return errorResult(
          `The cart ended up with ${cart.totalQuantity} item(s) instead of ${args.quantity}. ` +
            `Variant ${variantId} is probably out of stock or not published to the Headless ` +
            "sales channel. Do not present this cart as usable.",
        );
      }

      return validateOutput("create_cart_with_item", cartOutput, {
        cartId: cart.id,
        checkoutUrl: cart.checkoutUrl,
        totalQuantity: cart.totalQuantity,
        totalAmount: toNumber(cart.cost.totalAmount.amount),
        currency: cart.cost.totalAmount.currencyCode,
        lines: cart.lines.nodes.map((line) => ({
          title: [line.merchandise.product.title, line.merchandise.title]
            .filter((part) => part && part !== "Default Title")
            .join(" / "),
          quantity: line.quantity,
        })),
      });
    } catch (error) {
      return errorResult(`Cart creation failed: ${error.message}`);
    }
  },
);

/** OUTPUT schema for create_draft_order. */
const draftOrderOutput = z.object({
  draftOrderId: z.string().min(1),
  name: z.string().min(1),
  status: z.string().min(1),
  invoiceUrl: z.string().url(),
  totalPrice: z.number().nonnegative(),
  currency: z.string().length(3),
  lines: z.array(
    z.object({
      title: z.string().min(1),
      quantity: z.number().int().positive(),
    }),
  ),
});

const createDraftOrder = tool(
  "create_draft_order",
  "Create a real draft order in the store's admin and return its invoice URL. " +
    "This WRITES to the store and requires human confirmation, which may be declined.",
  {
    variantId: z
      .string()
      .min(1)
      .describe(
        "Product variant id from search_products, e.g. gid://shopify/ProductVariant/48229038260276.",
      ),
    quantity: z
      .number()
      .int()
      .positive()
      .describe("How many of that variant to put on the draft order."),
  },
  async (args) => {
    let variantId;
    try {
      variantId = toVariantGid(args.variantId);
    } catch (error) {
      return errorResult(error.message);
    }

    // Look the variant up first so the human is confirming a described purchase
    // rather than an opaque id. This read also catches a bad id before the
    // confirmation prompt rather than after it.
    let preview;
    try {
      const data = await adminRequest(VARIANT_PREVIEW_QUERY, { id: variantId });
      preview = data.productVariant;
    } catch (error) {
      return errorResult(`Admin lookup failed: ${error.message}`);
    }

    if (preview === null) {
      return errorResult(
        `No product variant found with id ${variantId}. Use search_products to get a valid one.`,
      );
    }

    const label = [preview.product.title, preview.title]
      .filter((part) => part && part !== "Default Title")
      .join(" / ");
    const lineTotal = (toNumber(preview.price) * args.quantity).toFixed(2);

    // The guardrail inherited from Lab 2.6. Nothing is written until a human
    // types exactly "y". It runs *inside* the handler, so declining produces an
    // is_error tool result rather than a permission denial.
    const answer = await readLine(
      `\n[confirm] Create a REAL draft order: ${args.quantity} x ${label} ` +
        `@ ${preview.price} = ${lineTotal}? (y/n) `,
    );

    // End of input counts as a decline, never as consent.
    if (answer === null || answer.trim() !== "y") {
      console.log('  -> DECLINED (answer was not exactly "y")');
      return errorResult(
        `The user declined to create a draft order for ${args.quantity} x ${label}. ` +
          "Nothing was written to the store — do not retry without being asked to.",
      );
    }

    console.log("  -> CONFIRMED");

    try {
      const data = await adminRequest(DRAFT_ORDER_CREATE_MUTATION, {
        input: {
          lineItems: [{ variantId, quantity: args.quantity }],
          tags: ["lab-3.6"],
        },
      });

      const errors = userErrorMessage(data.draftOrderCreate.userErrors);
      if (errors !== null) {
        return errorResult(`draftOrderCreate was rejected: ${errors}`);
      }

      const draftOrder = data.draftOrderCreate.draftOrder;

      return validateOutput("create_draft_order", draftOrderOutput, {
        draftOrderId: draftOrder.id,
        name: draftOrder.name,
        status: draftOrder.status,
        invoiceUrl: draftOrder.invoiceUrl,
        totalPrice: toNumber(draftOrder.totalPriceSet.shopMoney.amount),
        currency: draftOrder.totalPriceSet.shopMoney.currencyCode,
        lines: draftOrder.lineItems.nodes.map((item) => ({
          title: [item.title, item.variantTitle]
            .filter((part) => part && part !== "Default Title")
            .join(" / "),
          quantity: item.quantity,
        })),
      });
    } catch (error) {
      return errorResult(`Draft order creation failed: ${error.message}`);
    }
  },
);

const shopifyToolsServer = createSdkMcpServer({
  name: MCP_SERVER_NAME,
  version: "1.0.0",
  instructions:
    "Live Shopify tools. search_products and create_cart_with_item are read-only " +
    "and run on the Storefront API. create_draft_order writes to the store through " +
    "the Admin API, needs human confirmation, and may be declined.",
  tools: [searchProducts, createCartWithItem, createDraftOrder],
  // Keep all three in the prompt rather than deferring them behind ToolSearch.
  alwaysLoad: true,
});

const TOOL_IDS = [
  `mcp__${MCP_SERVER_NAME}__search_products`,
  `mcp__${MCP_SERVER_NAME}__create_cart_with_item`,
  `mcp__${MCP_SERVER_NAME}__create_draft_order`,
];

// ---------------------------------------------------------------------------
// 6. Conversation history — a streaming input queue
// ---------------------------------------------------------------------------

/**
 * A single query() call driven by an async iterable keeps ONE session alive for
 * the whole REPL, so Claude sees the full history every turn. Calling query()
 * per line would start a fresh conversation each time and "add that one to a
 * cart" would have no antecedent to resolve.
 */
function createUserMessageQueue() {
  /** @type {object[]} Queued SDKUserMessage objects awaiting the agent. */
  const pending = [];
  /** @type {(() => void) | null} */
  let wake = null;
  let closed = false;

  function signal() {
    const resume = wake;
    wake = null;
    if (resume !== null) {
      resume();
    }
  }

  return {
    /** @param {string} text */
    push(text) {
      pending.push({
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
      });
      signal();
    },

    close() {
      closed = true;
      signal();
    },

    async *stream() {
      for (;;) {
        const next = pending.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (closed) {
          return;
        }
        await new Promise((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 7. Turn printing
// ---------------------------------------------------------------------------

/**
 * Flattens a tool_result block's content into a printable string.
 * @param {unknown} content
 * @returns {string}
 */
function renderToolResultContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part !== null && typeof part === "object" && part.type === "text") {
          return part.text;
        }
        return JSON.stringify(part);
      })
      .join("\n");
  }
  return JSON.stringify(content);
}

/**
 * Prints every turn, clearly labeled.
 * @param {object} message An SDKMessage yielded by query().
 */
function printTurn(message) {
  switch (message.type) {
    case "system": {
      if (message.subtype === "init") {
        console.log(`\n[session] ${message.session_id}`);
        console.log(`[session] model: ${message.model}`);
        console.log(`[session] tools: ${TOOL_IDS.join(", ")}`);
      }
      return;
    }

    case "assistant": {
      for (const block of message.message.content) {
        switch (block.type) {
          case "text":
            console.log(`\n[claude] ${block.text}`);
            break;
          case "thinking":
            console.log(`\n[thinking] ${block.thinking}`);
            break;
          case "tool_use":
            console.log(`\n[tool call] ${block.name}`);
            console.log(`  args: ${JSON.stringify(block.input)}`);
            break;
          default:
            break;
        }
      }
      return;
    }

    case "user": {
      // Tool results arrive as user-role tool_result blocks. Our own typed
      // input is echoed here too as a plain string — already printed by the
      // REPL, so it is skipped.
      const content = message.message.content;
      if (typeof content === "string") {
        return;
      }
      for (const block of content) {
        if (block.type === "tool_result") {
          const label = block.is_error === true ? "tool error" : "tool result";
          console.log(`\n[${label}] ${renderToolResultContent(block.content)}`);
        }
      }
      return;
    }

    case "result": {
      if (message.subtype !== "success") {
        console.log(`\n[turn ended] ${message.subtype}`);
      }
      console.log(
        `\n[turn done] ${message.num_turns} turns · ${message.duration_ms} ms · $${message.total_cost_usd.toFixed(6)} total`,
      );
      return;
    }

    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// 8. The REPL
// ---------------------------------------------------------------------------

const EXIT_WORDS = new Set(["exit", "quit", ":q"]);

/**
 * Prompts until a non-empty line is entered.
 * @returns {Promise<string | null>} The line, or null to end the session.
 */
async function askUser() {
  for (;;) {
    const line = await readLine("\nyou> ");
    if (line === null) {
      return null;
    }
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    if (EXIT_WORDS.has(trimmed.toLowerCase())) {
      return null;
    }
    console.log(`[you] ${trimmed}`);
    return trimmed;
  }
}

function printBanner() {
  console.log("shopify-tool-agent — lab 3.6");
  console.log(`store: ${process.env.SHOPIFY_STORE_DOMAIN}`);
  console.log(
    "Conversation history persists across turns. Type 'exit' to quit.\n",
  );
  console.log("Try:");
  console.log("  find me a snowboard");
  console.log("  add two of the minimal one to a cart");
  console.log("  actually make that a draft order instead   <- asks to confirm");
}

async function main() {
  printBanner();

  const queue = createUserMessageQueue();

  const first = await askUser();
  if (first === null) {
    rl.close();
    return;
  }
  queue.push(first);

  const response = query({
    prompt: queue.stream(),
    options: {
      model: "claude-opus-5",
      systemPrompt:
        "You are a shop assistant for a real Shopify store. Use search_products, " +
        "create_cart_with_item, and create_draft_order to answer — never invent a " +
        "product, price, checkout link, or invoice link. Always call search_products " +
        "first to obtain a real variantId; never guess one. Resolve follow-up " +
        "references like 'that one' or 'the same product' from earlier turns. " +
        "create_draft_order writes to the live store and asks the user to confirm: if " +
        "it returns an error saying the user declined, accept that and stop — do not " +
        "call it again unless the user asks. If a tool returns an error, say what went " +
        "wrong instead of substituting your own data.",
      mcpServers: { [MCP_SERVER_NAME]: shopifyToolsServer },
      // Pre-approve exactly these three tools. The write guardrail lives inside
      // create_draft_order, not in the permission layer, so the tools must not
      // also be blocked here.
      allowedTools: TOOL_IDS,
      permissionMode: "default",
      // Keep this machine's settings.json rules out of the run.
      settingSources: [],
      disallowedTools: [
        "Bash",
        "Read",
        "Write",
        "Edit",
        "WebFetch",
        "WebSearch",
      ],
      stderr: (data) => process.stderr.write(data),
    },
  });

  for await (const message of response) {
    printTurn(message);

    // One turn finished — ask for the next line and feed it into the same
    // session, preserving history.
    if (message.type === "result") {
      const next = await askUser();
      if (next === null) {
        queue.close();
        continue;
      }
      queue.push(next);
    }
  }

  console.log("\nbye.");
  rl.close();
}

main().catch((error) => {
  console.error("\nagent run failed:", error);
  rl.close();
  process.exit(1);
});
