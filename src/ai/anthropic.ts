import Anthropic from "@anthropic-ai/sdk";
import pLimit from "p-limit";
import type { AIRequest, AIResponse } from "../types.js";
import { buildTranslationPrompt, parseAIResponse } from "./prompts.js";

const MAX_CONCURRENCY = 5;

// ─── Cost estimation ──────────────────────────────────────────────────────────

// Approximate rates in USD per token (updated 2025)
export const ANTHROPIC_RATES: Record<string, { input: number; output: number }> = {
  "claude-opus-4-6":    { input: 15 / 1_000_000,   output: 75 / 1_000_000 },
  "claude-sonnet-4-6":  { input: 3  / 1_000_000,   output: 15 / 1_000_000 },
  "claude-haiku-4-5":   { input: 0.8 / 1_000_000,  output: 4  / 1_000_000 },
};

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const rates = ANTHROPIC_RATES[model] ?? ANTHROPIC_RATES["claude-sonnet-4-6"]!;
  return inputTokens * rates.input + outputTokens * rates.output;
}

// ─── Main ────────────────────────────────────────────────────────────────────

export interface AnthropicResult {
  /** Maps string value → parsed AI response */
  responses: Map<string, AIResponse>;
  totalCostUsd: number;
}

/**
 * Call the Anthropic API for a batch of AI requests.
 * Runs up to MAX_CONCURRENCY requests in parallel.
 */
export async function callAnthropic(
  requests: AIRequest[],
  model: string,
  apiKey: string,
): Promise<AnthropicResult> {
  const client = new Anthropic({ apiKey });
  const limit = pLimit(MAX_CONCURRENCY);
  const responses = new Map<string, AIResponse>();
  let totalCostUsd = 0;

  await Promise.all(
    requests.map((request) =>
      limit(async () => {
        const prompt = buildTranslationPrompt(request);

        let message: Anthropic.Message;
        try {
          message = await client.messages.create({
            model,
            max_tokens: 1024,
            messages: [{ role: "user", content: prompt }],
          });
        } catch (err) {
          // Log and skip — don't fail the entire batch
          console.error(
            `[localizer] Anthropic call failed for "${request.value}": ${String(err)}`,
          );
          return;
        }

        const rawText =
          message.content[0]?.type === "text" ? message.content[0].text : "";

        let parsed: ReturnType<typeof parseAIResponse>;
        try {
          parsed = parseAIResponse(rawText);
        } catch (err) {
          console.error(
            `[localizer] Failed to parse response for "${request.value}": ${String(err)}`,
          );
          return;
        }

        // Track cost
        totalCostUsd += estimateCost(
          model,
          message.usage.input_tokens,
          message.usage.output_tokens,
        );

        responses.set(request.value, {
          key: parsed.key,
          translations: parsed.translations,
        });
      }),
    ),
  );

  return { responses, totalCostUsd };
}
