import { z } from "zod";

import type { SearchHit, SearchProvider } from "./types";

const webSearchResponseSchema = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string().url(),
      snippet: z.string(),
    }),
  ),
});

const stripJsonFence = (content: string) =>
  content
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

const normalizeBaseUrl = (value: string) => value.replace(/\/+$/, "");

const grokSearchSystemPrompt = [
  "You are a live web search engine running inside a knowledge ingestion pipeline.",
  "Use live web search to find current, relevant public pages for the user's query before answering.",
  'Return only raw JSON with the shape {"results":[{"title":"","url":"","snippet":""}]}.',
  "Do not return markdown, prose, analysis, citations, bullet lists, or code fences.",
  "Every result must contain a direct canonical page URL and a concise grounded snippet.",
  "If there are fewer strong matches than requested, return fewer results instead of fabricating any entry.",
].join(" ");

const buildGrokSearchUserPrompt = (input: { query: string; limit: number }) =>
  [
    `Query: ${input.query}`,
    `Return at most ${input.limit} results.`,
    "Search the live web now.",
    "Prefer primary sources, official documentation, or direct publisher pages when available.",
    "Return the JSON object immediately.",
  ].join("\n");

export class DirectWebSearchApiProvider implements SearchProvider {
  readonly kind = "web-search-api" as const;

  constructor(
    private readonly options: {
      baseUrl: string;
      apiKey: string;
    },
  ) {}

  async search(input: { query: string; limit: number }): Promise<SearchHit[]> {
    const response = await fetch(this.options.baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: input.query,
        limit: input.limit,
      }),
    });

    if (!response.ok) {
      throw new Error(`Web search API failed with status ${response.status}.`);
    }

    return webSearchResponseSchema.parse(await response.json()).results;
  }
}

export class GrokWebSearchProvider implements SearchProvider {
  readonly kind = "grok-search" as const;

  constructor(
    private readonly options: {
      baseUrl: string;
      apiKey: string;
      model: string;
    },
  ) {}

  async search(input: { query: string; limit: number }): Promise<SearchHit[]> {
    const response = await fetch(`${normalizeBaseUrl(this.options.baseUrl)}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.options.model,
        stream: false,
        temperature: 0,
        messages: [
          {
            role: "system",
            content: grokSearchSystemPrompt,
          },
          {
            role: "user",
            content: buildGrokSearchUserPrompt(input),
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Grok web search failed with status ${response.status}.`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string;
        };
      }>;
    };

    const content = payload.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("Grok web search response did not include message content.");
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(stripJsonFence(content));
    } catch {
      throw new Error("Grok web search returned invalid JSON.");
    }

    return webSearchResponseSchema.parse(parsed).results.slice(0, input.limit);
  }
}

export class MissingSearchProvider implements SearchProvider {
  constructor(
    readonly kind: "web-search-api" | "grok-search",
    private readonly message: string,
  ) {}

  async search(): Promise<SearchHit[]> {
    throw new Error(this.message);
  }
}
