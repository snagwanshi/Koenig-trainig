/**
 * Lab 2.3 — Agent scaffold with a custom in-process MCP tool.
 *
 * Demonstrates:
 *   1. Loading ANTHROPIC_API_KEY from .env via dotenv
 *   2. An in-process MCP server ("inventory-tools") exposing get_stock_level
 *   3. Running query() with that server registered
 *   4. An explicit permission mode + approval gate in front of every tool call
 *   5. Printing every turn — text, thinking, tool calls, and tool results
 *
 * Run with: npm start
 *
 * Note: this file is ES modules, not CommonJS — the Claude Agent SDK ships
 * ESM only, which is why package.json sets "type": "module".
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

// ---------------------------------------------------------------------------
// 2. Custom tool + in-process MCP server
// ---------------------------------------------------------------------------

const MCP_SERVER_NAME = "inventory-tools";

/**
 * Mock warehouse data — stands in for a real Shopify/ERP inventory lookup.
 * @type {Record<string, number>}
 */
const MOCK_STOCK = {
  "WB-1L": 42,
  "WB-500ML": 17,
  "TB-2PK": 0,
};

/**
 * Zod shape for the tool input. The SDK turns this into the JSON Schema the
 * model sees, and validates the model's arguments against it before the
 * handler runs — so `args.sku` is guaranteed to be a non-empty string.
 */
const getStockLevelSchema = {
  sku: z
    .string()
    .min(1, "sku must not be empty")
    .describe('Product SKU to look up, e.g. "WB-1L".'),
};

const getStockLevel = tool(
  "get_stock_level",
  "Look up the current on-hand stock count for a single product SKU.",
  getStockLevelSchema,
  async (args) => {
    const sku = args.sku.trim().toUpperCase();
    const onHand = MOCK_STOCK[sku] ?? 0;

    return {
      content: [{ type: "text", text: `SKU ${sku}: ${onHand} in stock` }],
    };
  },
);

const inventoryToolsServer = createSdkMcpServer({
  name: MCP_SERVER_NAME,
  version: "1.0.0",
  instructions:
    "Read-only inventory lookups. Use get_stock_level for any stock question.",
  tools: [getStockLevel],
  // Keep the tool in the prompt instead of deferring it behind ToolSearch, so
  // the agent calls it directly on the first turn.
  alwaysLoad: true,
});

/** MCP tools are namespaced as mcp__<server>__<tool> once registered. */
const STOCK_TOOL_ID = `mcp__${MCP_SERVER_NAME}__get_stock_level`;

/** Only these tools may ever be approved, no matter what the model asks for. */
const REVIEWED_TOOLS = new Set([STOCK_TOOL_ID]);

// ---------------------------------------------------------------------------
// 3. Approval gate — invoked before any tool actually runs
// ---------------------------------------------------------------------------

/**
 * Permission callback. The SDK awaits this before executing a tool call, and
 * only runs the tool if we return `{ behavior: "allow" }`.
 *
 * @param {string} toolName Namespaced tool name the model asked for.
 * @param {Record<string, unknown>} input Arguments the model supplied.
 * @param {{ signal: AbortSignal }} context
 * @returns {Promise<object>} An allow or deny PermissionResult.
 */
async function approveToolCall(toolName, input, { signal }) {
  console.log("\n[permission] the agent wants to run a tool");
  console.log(`  tool : ${toolName}`);
  console.log(`  input: ${JSON.stringify(input)}`);

  // Anything we have not vetted is denied outright, so the model cannot reach
  // for Bash, Read, or any other tool by accident.
  if (!REVIEWED_TOOLS.has(toolName)) {
    console.log(`  -> DENIED (${toolName} is not on the reviewed list)`);
    return {
      behavior: "deny",
      message: `${toolName} is not permitted in this lab. Only ${STOCK_TOOL_ID} is available.`,
      decisionClassification: "user_reject",
    };
  }

  // Interactive terminal: ask a human. Non-interactive (CI, piped stdin):
  // fall back to the reviewed-tools policy so the run cannot hang forever.
  if (process.stdin.isTTY !== true) {
    console.log("  -> ALLOWED (non-interactive run, tool is pre-reviewed)");
    return { behavior: "allow", decisionClassification: "user_permanent" };
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("  approve? [y/N] ", { signal });
    if (answer.trim().toLowerCase().startsWith("y")) {
      console.log("  -> ALLOWED by user");
      return { behavior: "allow", decisionClassification: "user_temporary" };
    }
    console.log("  -> DENIED by user");
    return {
      behavior: "deny",
      message: "The user declined this tool call.",
      decisionClassification: "user_reject",
    };
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// 4. Turn printing
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
 * Prints one SDK message — every turn, not just the final answer.
 * @param {object} message An SDKMessage yielded by query().
 * @returns {void}
 */
function printTurn(message) {
  switch (message.type) {
    case "system": {
      if (message.subtype === "init") {
        console.log(`\n=== session ${message.session_id} ===`);
        console.log(`model: ${message.model}`);
        console.log(`permission mode: ${message.permissionMode}`);
        console.log(`mcp servers: ${JSON.stringify(message.mcp_servers)}`);
      }
      return;
    }

    case "assistant": {
      for (const block of message.message.content) {
        switch (block.type) {
          case "text":
            console.log(`\n[assistant] ${block.text}`);
            break;
          case "thinking":
            console.log(`\n[thinking] ${block.thinking}`);
            break;
          case "tool_use":
            console.log(
              `\n[tool call] ${block.name} ${JSON.stringify(block.input)}`,
            );
            break;
          default:
            console.log(`\n[assistant:${block.type}]`);
            break;
        }
      }
      return;
    }

    case "user": {
      // Tool results come back to the model as user-role tool_result blocks.
      const content = message.message.content;
      if (typeof content === "string") {
        console.log(`\n[user] ${content}`);
        return;
      }
      for (const block of content) {
        if (block.type === "tool_result") {
          console.log(
            `\n[tool result] ${renderToolResultContent(block.content)}`,
          );
        }
      }
      return;
    }

    case "result": {
      console.log("\n=== result ===");
      if (message.subtype === "success") {
        console.log(`final answer: ${message.result}`);
      } else {
        console.log(`ended without an answer: ${message.subtype}`);
      }
      console.log(`turns: ${message.num_turns}`);
      console.log(`duration: ${message.duration_ms} ms`);
      console.log(`cost (est): $${message.total_cost_usd.toFixed(6)}`);
      if (message.permission_denials.length > 0) {
        console.log(
          `denied tool calls: ${message.permission_denials
            .map((denial) => denial.tool_name)
            .join(", ")}`,
        );
      }
      return;
    }

    default:
      // Streaming/telemetry message kinds this lab does not render.
      return;
  }
}

// ---------------------------------------------------------------------------
// 5. Run the query loop
// ---------------------------------------------------------------------------

const PROMPT = "How many of SKU WB-1L do we have in stock?";

async function main() {
  console.log(`[prompt] ${PROMPT}`);

  const response = query({
    prompt: PROMPT,
    options: {
      model: "claude-opus-5",
      systemPrompt:
        "You are an inventory assistant. Answer stock questions by calling the " +
        "get_stock_level tool — never guess a number. Report the exact count it returns.",
      mcpServers: { [MCP_SERVER_NAME]: inventoryToolsServer },
      // 'default' = every tool call that is not pre-approved is routed to
      // canUseTool for an explicit allow/deny decision before it executes.
      permissionMode: "default",
      canUseTool: approveToolCall,
      // Deliberately no allowedTools: an allow rule would auto-approve the tool
      // and skip the gate above. settingSources: [] stops allow rules in this
      // machine's settings.json from shadowing it either.
      settingSources: [],
      disallowedTools: [
        "Bash",
        "Read",
        "Write",
        "Edit",
        "WebFetch",
        "WebSearch",
      ],
      maxTurns: 6,
      stderr: (data) => process.stderr.write(data),
    },
  });

  for await (const message of response) {
    printTurn(message);
  }
}

main().catch((error) => {
  console.error("\nagent run failed:", error);
  process.exit(1);
});
