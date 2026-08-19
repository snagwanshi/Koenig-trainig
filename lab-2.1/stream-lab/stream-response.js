#!/usr/bin/env node
// Streams a single Claude response to stdout, token by token, then reports
// the usage totals from the completed message.
//
// Usage: node stream-response.js

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-sonnet-5';
const PROMPT = 'Write a short, upbeat product description for an insulated water bottle.';

// Resolve .env next to this script, so the command works from any cwd.
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

const client = new Anthropic({ apiKey });

try {
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 1024,
    // Sonnet 5 runs adaptive thinking by default, and thinking shares the
    // 1024-token budget with the answer. Off keeps the whole budget for text
    // and removes the silent pause before the first token appears.
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: PROMPT }],
  });

  // 'text' fires per delta. process.stdout.write does no line buffering, so
  // each chunk reaches the terminal as it arrives.
  stream.on('text', (delta) => process.stdout.write(delta));

  const message = await stream.finalMessage();
  process.stdout.write('\n');

  if (message.stop_reason === 'refusal') {
    console.error('\nThe model declined this request.');
    process.exit(1);
  }
  if (message.stop_reason === 'max_tokens') {
    console.error('\nWarning: output hit max_tokens and was cut off mid-sentence.');
  }

  console.log(
    `\nusage: input_tokens=${message.usage.input_tokens} output_tokens=${message.usage.output_tokens}`
  );
} catch (err) {
  // Report failures as a readable line, never a raw stack trace.
  if (err instanceof Anthropic.AuthenticationError) {
    console.error('\nError: the API key was rejected. Check ANTHROPIC_API_KEY in your .env.');
  } else if (err instanceof Anthropic.RateLimitError) {
    console.error('\nError: rate limited. Wait a moment and try again.');
  } else if (err instanceof Anthropic.APIConnectionError) {
    console.error('\nError: could not reach the API. Check your network connection.');
  } else if (err instanceof Anthropic.APIError) {
    console.error(`\nAPI error ${err.status}: ${err.message}`);
  } else {
    console.error(`\nUnexpected error: ${err.message}`);
  }
  process.exit(1);
}
