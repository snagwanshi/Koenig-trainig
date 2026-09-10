/**
 * Lab 5 — the UCP shopping agent.
 *
 * Acts as a UCP "platform": on startup it fetches the merchant's business
 * profile from GET /.well-known/ucp, finds the dev.ucp.shopping service's MCP
 * transport binding, and connects to that endpoint — the same discovery step
 * a real UCP-aware shopping agent would perform against any UCP-enabled
 * store, not just this one.
 *
 * One sessionId is generated per run and silently attached to every
 * cart/checkout/order-event tool call via `canUseTool`'s `updatedInput`, so
 * the model never has to remember or retype an opaque id across turns.
 * `canUseTool` also gates complete_checkout behind an explicit human
 * confirmation — the actual human-in-the-loop check for this lab's one
 * money-moving step, since the MCP server itself has no terminal to ask on
 * (see ucp-server/mcpServer.js and capabilities/checkout.js).
 *
 * Run with: npm run server   (in one terminal)
 *           npm run agent    (in another)
 * Leave with: exit
 */

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import process from "node:process";

import { query } from "@anthropic-ai/claude-agent-sdk";
import { config as loadEnv } from "dotenv";

loadEnv();

const apiKey = process.env.ANTHROPIC_API_KEY;
if (apiKey === undefined || apiKey.trim() === "") {
  console.error(
    "Missing ANTHROPIC_API_KEY. Add it to lab5-shopify-agent-complete/.env:\n" +
      "  ANTHROPIC_API_KEY=sk-ant-...",
  );
  process.exit(1);
}

const PORT = process.env.PORT || 3300;
const UCP_SERVER_URL = `http://localhost:${PORT}`;
const MCP_SERVER_NAME = "ucp-shopping";
const SESSION_ID = randomUUID();

// ---------------------------------------------------------------------------
// 1. UCP discovery — fetch the profile, find the MCP transport binding
// ---------------------------------------------------------------------------

async function discoverShoppingMcpEndpoint() {
  const profileUrl = `${UCP_SERVER_URL}/.well-known/ucp`;
  let res;
  try {
    res = await fetch(profileUrl);
  } catch (error) {
    throw new Error(
      `Could not reach ${profileUrl} (${error.message}). Start the UCP server first: npm run server`,
    );
  }
  if (!res.ok) {
    throw new Error(`GET ${profileUrl} returned HTTP ${res.status}`);
  }

  const profile = await res.json();
  const bindings = profile.ucp?.services?.["dev.ucp.shopping"] ?? [];
  const mcpBinding = bindings.find((b) => b.transport === "mcp");
  if (mcpBinding === undefined) {
    throw new Error(
      `${profileUrl} does not declare an mcp transport binding for dev.ucp.shopping.`,
    );
  }

  const capabilities = Object.keys(profile.ucp?.capabilities ?? {});
  console.log(`[discovery] profile: ${profileUrl}`);
  console.log(`[discovery] ucp version: ${profile.ucp?.version}`);
  console.log(`[discovery] capabilities: ${capabilities.join(", ")}`);
  console.log(`[discovery] mcp endpoint: ${mcpBinding.endpoint}`);

  return mcpBinding.endpoint;
}

// ---------------------------------------------------------------------------
// 2. Readline — shared by the REPL prompt and the checkout confirmation
// ---------------------------------------------------------------------------

const rl = createInterface({ input: process.stdin, output: process.stdout });
const lines = rl[Symbol.asyncIterator]();

async function readLine(promptText) {
  process.stdout.write(promptText);
  const next = await lines.next();
  if (next.done === true || next.value === undefined) {
    return null;
  }
  return next.value;
}

// ---------------------------------------------------------------------------
// 3. canUseTool — silent sessionId injection + the complete_checkout gate
// ---------------------------------------------------------------------------

/** Base (un-prefixed) tool names that take a sessionId argument. */
const SESSION_SCOPED_TOOLS = new Set([
  "create_cart",
  "update_cart",
  "get_cart",
  "create_checkout",
  "update_checkout",
  "complete_checkout",
  "get_order_events",
]);

const TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

async function canUseTool(toolName, input) {
  if (!toolName.startsWith(TOOL_PREFIX)) {
    return { behavior: "deny", message: `${toolName} is out of scope for this agent.` };
  }
  const baseName = toolName.slice(TOOL_PREFIX.length);

  const updatedInput = SESSION_SCOPED_TOOLS.has(baseName)
    ? { ...input, sessionId: SESSION_ID }
    : input;

  if (baseName === "complete_checkout") {
    const total = updatedInput.expectedTotal;
    const amountText = total ? `${total.amount} ${total.currencyCode}` : "an unknown amount";
    const answer = await readLine(
      `\n[confirm] Complete checkout and place the order for ${amountText}? (y/n) `,
    );
    if (answer === null || answer.trim().toLowerCase() !== "y") {
      console.log('  -> DECLINED (answer was not exactly "y")');
      return {
        behavior: "deny",
        message:
          `The shopper declined to complete checkout for ${amountText}. Do not retry without ` +
          "asking again, and do not treat the checkout as placed.",
      };
    }
    console.log("  -> CONFIRMED");
  }

  return { behavior: "allow", updatedInput };
}

// ---------------------------------------------------------------------------
// 4. Conversation history — a streaming input queue (same pattern as lab-2.6)
// ---------------------------------------------------------------------------

function createUserMessageQueue() {
  const pending = [];
  let wake = null;
  let closed = false;

  function signal() {
    const resume = wake;
    wake = null;
    if (resume !== null) resume();
  }

  return {
    push(text) {
      pending.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
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
        if (closed) return;
        await new Promise((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 5. Turn printing
// ---------------------------------------------------------------------------

function renderToolResultContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part?.type === "text" ? part.text : JSON.stringify(part)))
      .join("\n");
  }
  return JSON.stringify(content);
}

function printTurn(message) {
  switch (message.type) {
    case "system":
      if (message.subtype === "init") {
        console.log(`\n[session] ${message.session_id}`);
        console.log(`[session] model: ${message.model}`);
      }
      return;

    case "assistant":
      for (const block of message.message.content) {
        if (block.type === "text") console.log(`\n[claude] ${block.text}`);
        else if (block.type === "thinking") console.log(`\n[thinking] ${block.thinking}`);
        else if (block.type === "tool_use") {
          console.log(`\n[tool call] ${block.name}`);
          console.log(`  args: ${JSON.stringify(block.input)}`);
        }
      }
      return;

    case "user": {
      const content = message.message.content;
      if (typeof content === "string") return;
      for (const block of content) {
        if (block.type === "tool_result") {
          const label = block.is_error === true ? "tool error" : "tool result";
          console.log(`\n[${label}] ${renderToolResultContent(block.content)}`);
        }
      }
      return;
    }

    case "result":
      if (message.subtype !== "success") console.log(`\n[turn ended] ${message.subtype}`);
      console.log(
        `\n[turn done] ${message.num_turns} turns · ${message.duration_ms} ms · $${message.total_cost_usd.toFixed(6)} total`,
      );
      return;

    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// 6. The REPL
// ---------------------------------------------------------------------------

const EXIT_WORDS = new Set(["exit", "quit", ":q"]);

async function askUser() {
  for (;;) {
    const line = await readLine("\nyou> ");
    if (line === null) return null;
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (EXIT_WORDS.has(trimmed.toLowerCase())) return null;
    console.log(`[you] ${trimmed}`);
    return trimmed;
  }
}

function printBanner() {
  console.log("ucp-shopping-agent — lab 5");
  console.log(`session id: ${SESSION_ID}`);
  console.log("Type 'exit' to quit.\n");
  console.log("Try:");
  console.log("  search for a snowboard");
  console.log("  add it to my cart");
  console.log("  start checkout");
  console.log("  complete the checkout        <- asks for your confirmation");
  console.log("  what's the status of that order?");
}

async function main() {
  const mcpEndpoint = await discoverShoppingMcpEndpoint();

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
        "You are a shopping agent for a UCP-enabled store, talking to the shopper directly. " +
        "Follow the real commerce lifecycle: search the catalog (catalog_search/catalog_lookup), " +
        "build a cart (create_cart, then update_cart to add/change/remove lines, get_cart to check " +
        "it), then start a checkout (create_checkout) once the cart is right. Before calling " +
        "complete_checkout, tell the shopper the checkout's exact current total and get their " +
        "explicit go-ahead in the conversation, then call complete_checkout with that same total as " +
        "expectedTotal — the call will be rejected if it doesn't match the checkout's real total, so " +
        "always use the freshest number, not one from several turns ago. If the shopper changes the " +
        "cart after create_checkout, call update_checkout to resync before completing. Use get_order " +
        "or get_order_events to answer questions about an order placed this session. Never invent " +
        "prices, totals, or order status — only report what a tool actually returned. You do not " +
        "need to track or mention any session id yourself.",
      mcpServers: {
        [MCP_SERVER_NAME]: { type: "http", url: mcpEndpoint, alwaysLoad: true },
      },
      canUseTool,
      permissionMode: "default",
      settingSources: [],
      disallowedTools: ["Bash", "Read", "Write", "Edit", "WebFetch", "WebSearch"],
      stderr: (data) => process.stderr.write(data),
    },
  });

  for await (const message of response) {
    printTurn(message);
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
  console.error("\nagent run failed:", error.message);
  rl.close();
  process.exit(1);
});
