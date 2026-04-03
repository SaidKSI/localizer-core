import OpenAI from "openai";
import pLimit from "p-limit";
import type { AIRequest, AIResponse } from "../types.js";
import { buildTranslationPrompt, parseAIResponse } from "./prompts.js";

const MAX_CONCURRENCY = 5;

// ─── Cost estimation ──────────────────────────────────────────────────────────

const OPENAI_RATES: Record<string, { input: number; output: number }> = {
  "gpt-4o":           { input: 5  / 1_000_000, output: 15 / 1_000_000 },
  "gpt-4o-mini":      { input: 0.15 / 1_000_000, output: 0.6 / 1_000_000 },
  "gpt-4-turbo":      { input: 10 / 1_000_000, output: 30 / 1_000_000 },
  "gpt-3.5-turbo":    { input: 0.5 / 1_000_000, output: 1.5 / 1_000_000 },
};

function estimateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  // Match on prefix so "gpt-4o-mini-2024-07-18" maps to "gpt-4o-mini"
  const key = Object.keys(OPENAI_RATES).find((k) => model.startsWith(k));
  const rates = key ? OPENAI_RATES[key]! : OPENAI_RATES["gpt-4o"]!;
  return promptTokens * rates.input + completionTokens * rates.output;
}

// ─── Main ────────────────────────────────────────────────────────────────────

export interface OpenAIResult {
  responses: Map<string, AIResponse>;
  totalCostUsd: number;
}

/**
 * Call the OpenAI API for a batch of AI requests.
 * Uses json_object response format for reliable JSON output.
 */
export async function callOpenAI(
  requests: AIRequest[],
  model: string,
  apiKey: string,
): Promise<OpenAIResult> {
  const client = new OpenAI({ apiKey });
  const limit = pLimit(MAX_CONCURRENCY);
  const responses = new Map<string, AIResponse>();
  let totalCostUsd = 0;

  await Promise.all(
    requests.map((request) =>
      limit(async () => {
        const prompt = buildTranslationPrompt(request);

        let completion: OpenAI.Chat.ChatCompletion;
        try {
          completion = await client.chat.completions.create({
            model,
            messages: [{ role: "user", content: prompt }],
            max_tokens: 1024,
            response_format: { type: "json_object" },
          });
        } catch (err) {
          console.error(
            `[localizer] OpenAI call failed for "${request.value}": ${String(err)}`,
          );
          return;
        }

        const rawText = completion.choices[0]?.message.content ?? "";

        let parsed: ReturnType<typeof parseAIResponse>;
        try {
          parsed = parseAIResponse(rawText);
        } catch (err) {
          console.error(
            `[localizer] Failed to parse response for "${request.value}": ${String(err)}`,
          );
          return;
        }

        const usage = completion.usage;
        if (usage) {
          totalCostUsd += estimateCost(
            model,
            usage.prompt_tokens,
            usage.completion_tokens,
          );
        }

        responses.set(request.value, {
          key: parsed.key,
          translations: parsed.translations,
        });
      }),
    ),
  );

  return { responses, totalCostUsd };
}
