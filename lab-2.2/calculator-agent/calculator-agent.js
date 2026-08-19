#!/usr/bin/env node
// Interactive terminal agent with a single `calculate` tool.
//
// Arithmetic is performed here in JavaScript — Claude decides *what* to
// compute, this script decides *what the answer is*.
//
// Usage: node calculator-agent.js      (type "exit" or Ctrl+C to quit)

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 1024;
const MAX_TOOL_ROUNDS = 10; // backstop against a runaway tool loop

// --- env ------------------------------------------------------------------
// Resolve .env next to this script so the command works from any cwd.
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(scriptDir, '.env');
dotenv.config({ path: envPath, quiet: true });

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Error: ANTHROPIC_API_KEY is not set.');
  console.error(`Expected it in: ${envPath}`);
  console.error('Add a line like:  ANTHROPIC_API_KEY=sk-ant-...');
  console.error('(A shell variable of the same name overrides the .env file.)');
  process.exit(1);
}

// --- the one tool ---------------------------------------------------------
const CALCULATE_TOOL = {
  name: 'calculate',
  description:
    'Perform a single arithmetic operation on two numbers and return the exact result. ' +
    'Call this for any arithmetic the user asks for, including simple sums, rather than ' +
    'working the answer out yourself. For a multi-step expression, call it once per step.',
  input_schema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['add', 'subtract', 'multiply', 'divide'],
        description: 'Which arithmetic operation to apply to a and b.',
      },
      a: { type: 'number', description: 'The left-hand operand.' },
      b: { type: 'number', description: 'The right-hand operand.' },
    },
    required: ['operation', 'a', 'b'],
  },
};

// Returns { value } on success or { error } on a recoverable problem.
// Never throws — a bad input becomes an error the model can read and react to.
function runCalculate(toolInput) {
  const { operation, a, b } = toolInput ?? {};

  if (typeof a !== 'number' || Number.isNaN(a) || typeof b !== 'number' || Number.isNaN(b)) {
    return { error: 'Both "a" and "b" must be numbers.' };
  }

  switch (operation) {
    case 'add':
      return { value: a + b };
    case 'subtract':
      return { value: a - b };
    case 'multiply':
      return { value: a * b };
    case 'divide':
      // Guarded: JS would return Infinity here rather than throwing, which
      // would quietly feed a nonsense result back to the model.
      if (b === 0) return { error: 'Cannot divide by zero.' };
      return { value: a / b };
    default:
      return { error: `Unknown operation "${operation}".` };
  }
}

// --- agent loop -----------------------------------------------------------
const client = new Anthropic({ apiKey });
const rl = readline.createInterface({ input, output });

// Full conversation history, carried across turns.
const messages = [];

function requestOptions() {
  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    tools: [CALCULATE_TOOL],
    tool_choice: { type: 'auto' },
    messages,
  };
}

console.log('Calculator agent — ask me to do some arithmetic.');
console.log('Type "exit" (or press Ctrl+C) to quit.\n');

// Async iteration (rather than repeated rl.question) applies backpressure, so
// lines are handled one at a time whether stdin is a terminal or a pipe.
// With a pipe, stdin can hit EOF while an API call is still in flight, closing
// the interface — so re-prompting has to tolerate an already-closed readline.
let inputClosed = false;
rl.on('close', () => { inputClosed = true; });
const prompt = () => { if (!inputClosed) rl.prompt(); };

rl.setPrompt('you> ');
prompt();

for await (const line of rl) {
  const trimmed = line.trim();
  if (trimmed === '') {
    prompt();
    continue;
  }
  if (['exit', 'quit'].includes(trimmed.toLowerCase())) break;

  // Roll back to here if the turn fails, so history never holds a
  // half-finished exchange.
  const checkpoint = messages.length;
  messages.push({ role: 'user', content: trimmed });

  try {
    let response = await client.messages.create(requestOptions());
    let rounds = 0;

    while (response.stop_reason === 'tool_use') {
      if (++rounds > MAX_TOOL_ROUNDS) {
        console.error(`\n(stopped after ${MAX_TOOL_ROUNDS} tool rounds)`);
        break;
      }

      // Push the assistant turn verbatim — it carries the tool_use blocks
      // (and any thinking blocks) the API needs to see echoed back.
      messages.push({ role: 'assistant', content: response.content });

      // Every tool_use block must get exactly one tool_result, and they all
      // travel back in a single user message.
      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        const { operation, a, b } = block.input ?? {};
        const outcome = runCalculate(block.input);

        if (outcome.error) {
          console.log(`  [calculate] ${operation}(${a}, ${b}) -> ${outcome.error}`);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: outcome.error,
            is_error: true,
          });
        } else {
          console.log(`  [calculate] ${operation}(${a}, ${b}) = ${outcome.value}`);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: String(outcome.value),
          });
        }
      }

      messages.push({ role: 'user', content: toolResults });
      response = await client.messages.create(requestOptions());
    }

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'refusal') {
      console.log('\nclaude> (declined this request)\n');
      continue;
    }

    const reply = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
      .trim();

    console.log(`\nclaude> ${reply || '(no text reply)'}\n`);

    if (response.stop_reason === 'max_tokens') {
      console.error('(warning: reply hit max_tokens and was cut off)\n');
    }
  } catch (err) {
    messages.length = checkpoint; // discard the failed turn

    if (err instanceof Anthropic.AuthenticationError) {
      console.error('\nError: the API key was rejected. Check ANTHROPIC_API_KEY in your .env.\n');
    } else if (err instanceof Anthropic.RateLimitError) {
      console.error('\nError: rate limited. Wait a moment and try again.\n');
    } else if (err instanceof Anthropic.APIConnectionError) {
      console.error('\nError: could not reach the API. Check your network connection.\n');
    } else if (err instanceof Anthropic.APIError) {
      console.error(`\nAPI error ${err.status}: ${err.message}\n`);
    } else {
      console.error(`\nUnexpected error: ${err.message}\n`);
    }
  } finally {
    // Runs for every exit path from the turn — success, refusal, or error.
    prompt();
  }
}

rl.close();
console.log('\nBye.');
