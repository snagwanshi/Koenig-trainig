/**
 * Lab 2.6 — multi-tool-agent
 *
 * An interactive shop assistant with three custom tools, each guarded on both
 * sides: a zod INPUT schema the SDK enforces before the handler runs, and a zod
 * OUTPUT schema this file enforces before the result reaches Claude.
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

// ---------------------------------------------------------------------------
// 1. Environment
// ---------------------------------------------------------------------------

loadEnv();

const apiKey = process.env.ANTHROPIC_API_KEY;
if (apiKey === undefined || apiKey.trim() === "") {
  console.error(
    "Missing ANTHROPIC_API_KEY. Create a .env file next to agent.js containing:\n" +
      "  ANTHROPIC_API_KEY=sk-ant-...",
  );
  process.exit(1);
}

/**
 * One shared readline interface for the whole process. Both the REPL prompt and
 * the discount confirmation read from it — they never overlap, because the REPL
 * only asks for input between turns, while a tool only asks mid-turn.
 */
const rl = createInterface({ input: process.stdin, output: process.stdout });

/**
 * Pull one line at a time from readline. Using the async iterator rather than
 * rl.question() means end-of-input is reported as `done` instead of throwing
 * ERR_USE_AFTER_CLOSE — so a piped session (`… | node agent.js`) ends cleanly
 * and behaves the same as an interactive terminal.
 */
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
 * Requirement 5 — the output guard. Every handler runs its payload through its
 * own zod output schema here. Malformed data becomes an is_error result and is
 * never forwarded to Claude.
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
// 3. Mock data
// ---------------------------------------------------------------------------

/**
 * Mock rows are treated as untrusted input by the output guard, exactly like a
 * real API response would be.
 */
const PRODUCTS = {
  "blue widget": { name: "Blue Widget", price: 24.99, inStock: true },
  "red widget": { name: "Red Widget", price: 18.5, inStock: false },
  "water bottle": { name: "1L Water Bottle", price: 32, inStock: true },
  // Deliberately malformed fixture so the output guard is demonstrable: `price`
  // is a string, which the output schema rejects. Ask about the "broken widget"
  // to watch requirement 5 fire.
  "broken widget": { name: "Broken Widget", price: "24.99", inStock: true },
};

const ORDERS = {
  "A-1001": { orderId: "A-1001", status: "shipped", eta: "2026-08-24" },
  "A-1002": { orderId: "A-1002", status: "processing", eta: "2026-08-28" },
  "A-1003": {
    orderId: "A-1003",
    status: "delivered",
    eta: "arrived 2026-08-19",
  },
};

// ---------------------------------------------------------------------------
// 4. The three tools — zod in, zod out
// ---------------------------------------------------------------------------

const MCP_SERVER_NAME = "shop-tools";

/** OUTPUT schema for get_product_info. */
const productInfoOutput = z.object({
  name: z.string().min(1),
  price: z.number().positive(),
  inStock: z.boolean(),
});

const getProductInfo = tool(
  "get_product_info",
  "Look up a product's price and stock status by name.",
  {
    // INPUT schema — the SDK validates the model's arguments against this.
    name: z.string().min(1).describe('Product name, e.g. "blue widget".'),
  },
  async (args) => {
    const key = args.name.trim().toLowerCase();
    const row = PRODUCTS[key];

    if (row === undefined) {
      return errorResult(
        `No product named "${args.name}". Known products: ${Object.keys(PRODUCTS).join(", ")}.`,
      );
    }

    return validateOutput("get_product_info", productInfoOutput, row);
  },
);

/** OUTPUT schema for get_order_status. */
const orderStatusOutput = z.object({
  orderId: z.string().min(1),
  status: z.enum(["processing", "shipped", "delivered", "cancelled"]),
  eta: z.string().min(1),
});

const getOrderStatus = tool(
  "get_order_status",
  "Look up the status and ETA of a customer order by its ID.",
  {
    orderId: z.string().min(1).describe('Order ID, e.g. "A-1001".'),
  },
  async (args) => {
    const key = args.orderId.trim().toUpperCase();
    const row = ORDERS[key];

    if (row === undefined) {
      return errorResult(
        `No order with ID "${args.orderId}". Known orders: ${Object.keys(ORDERS).join(", ")}.`,
      );
    }

    return validateOutput("get_order_status", orderStatusOutput, row);
  },
);

/** OUTPUT schema for calculate_discount. */
const discountOutput = z.object({
  originalPrice: z.number().nonnegative(),
  percent: z.number().min(0).max(100),
  discountedPrice: z.number().nonnegative(),
});

const calculateDiscount = tool(
  "calculate_discount",
  "Apply a percentage discount to a price. Requires human confirmation.",
  {
    price: z.number().positive().describe("Original price in dollars."),
    percent: z
      .number()
      .min(0)
      .max(100)
      .describe("Discount percentage, 0 to 100."),
  },
  async (args) => {
    // Requirement 3 — the lab's guardrail. Nothing is computed until a human
    // types exactly "y". Note this runs *inside* the handler, so declining
    // produces an is_error tool result rather than a permission denial.
    const answer = await readLine(
      `\n[confirm] Apply a ${args.percent}% discount to $${args.price}? (y/n) `,
    );

    // End of input counts as a decline, never as consent.
    if (answer === null || answer.trim() !== "y") {
      console.log('  -> DECLINED (answer was not exactly "y")');
      return errorResult(
        `The user declined the ${args.percent}% discount on $${args.price}. No discount was applied — do not guess or compute one yourself.`,
      );
    }

    console.log("  -> CONFIRMED");

    const discounted = args.price * (1 - args.percent / 100);
    return validateOutput("calculate_discount", discountOutput, {
      originalPrice: args.price,
      percent: args.percent,
      discountedPrice: Math.round(discounted * 100) / 100,
    });
  },
);

const shopToolsServer = createSdkMcpServer({
  name: MCP_SERVER_NAME,
  version: "1.0.0",
  instructions:
    "Shop lookups: product info, order status, and discount math. " +
    "calculate_discount needs human confirmation and may be declined.",
  tools: [getProductInfo, getOrderStatus, calculateDiscount],
  // Keep all three in the prompt rather than deferring them behind ToolSearch.
  alwaysLoad: true,
});

const TOOL_IDS = [
  `mcp__${MCP_SERVER_NAME}__get_product_info`,
  `mcp__${MCP_SERVER_NAME}__get_order_status`,
  `mcp__${MCP_SERVER_NAME}__calculate_discount`,
];

// ---------------------------------------------------------------------------
// 5. Conversation history — a streaming input queue
// ---------------------------------------------------------------------------

/**
 * Requirement 4. A single query() call driven by an async iterable keeps ONE
 * session alive for the whole REPL, so Claude sees the full history every turn.
 * Calling query() once per line would instead start a fresh conversation each
 * time and "what about that same order?" would have nothing to resolve against.
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
// 6. Turn printing
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
 * Requirement 6 — print every turn, clearly labeled.
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
// 7. The REPL
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
  console.log("multi-tool-agent — lab 2.6");
  console.log(
    "Conversation history persists across turns. Type 'exit' to quit.\n",
  );
  console.log("Try:");
  console.log("  how much is the blue widget?");
  console.log("  take 15% off that");
  console.log("  what's the status of order A-1001?");
  console.log("  what about that same order's ETA?");
  console.log("  tell me about the broken widget      <- trips the output guard");
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
        "You are a shop assistant. Use get_product_info, get_order_status, and " +
        "calculate_discount to answer questions — never invent a price, status, or " +
        "discount. Resolve follow-up references like 'that order' or 'the same " +
        "product' from earlier turns in this conversation. If a tool returns an " +
        "error, say what went wrong instead of substituting your own numbers.",
      mcpServers: { [MCP_SERVER_NAME]: shopToolsServer },
      // Pre-approve exactly these three tools. This lab's guardrail lives inside
      // calculate_discount (requirement 3), not in the permission layer, so the
      // tools must not also be blocked here.
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
