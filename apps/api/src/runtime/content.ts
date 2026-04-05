import { Readability } from "@mozilla/readability";
import { DOMParser } from "linkedom";

import type { SearchHit, SourceContentReader, SourceDocument } from "./types";

const normalizeTextContent = (content: string) => content.replace(/\s+/g, " ").trim();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const buildJinaReaderUrl = (baseUrl: string, sourceUrl: string) => {
  if (baseUrl.includes("{url}")) {
    return baseUrl.replace("{url}", encodeURIComponent(sourceUrl));
  }

  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : baseUrl;
  return `${normalizedBaseUrl}${sourceUrl.replace(/^https?:\/\//, "")}`;
};

export class HtmlSourceContentReader implements SourceContentReader {
  async read(hit: SearchHit): Promise<SourceDocument> {
    const response = await fetch(hit.url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch source document ${hit.url} with status ${response.status}.`);
    }

    const html = await response.text();
    const document = new DOMParser().parseFromString(html, "text/html");
    const article = new Readability(document as unknown as Document).parse();

    if (!article?.textContent) {
      throw new Error(`Readability failed to extract article content from ${hit.url}.`);
    }

    return {
      ...hit,
      title: article.title || hit.title,
      content: normalizeTextContent(article.textContent),
    };
  }
}

export class JinaReaderSourceContentReader implements SourceContentReader {
  private nextAvailableAt = 0;
  private scheduleTail = Promise.resolve();

  constructor(
    private readonly options: {
      baseUrl: string;
      apiKey?: string;
      requestsPerMinute?: number;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
    } = {
      baseUrl: "https://r.jina.ai/http://",
      requestsPerMinute: 15,
    },
  ) {}

  private get now() {
    return this.options.now ?? Date.now;
  }

  private get wait() {
    return this.options.sleep ?? sleep;
  }

  private get minIntervalMs() {
    const requestsPerMinute = Math.max(1, this.options.requestsPerMinute ?? 15);
    return Math.ceil(60_000 / requestsPerMinute);
  }

  private async waitForRateLimitSlot() {
    const previous = this.scheduleTail.catch(() => undefined);
    let release!: () => void;
    this.scheduleTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;

    try {
      const waitMs = Math.max(0, this.nextAvailableAt - this.now());

      if (waitMs > 0) {
        await this.wait(waitMs);
      }

      this.nextAvailableAt = this.now() + this.minIntervalMs;
    } finally {
      release();
    }
  }

  async read(hit: SearchHit): Promise<SourceDocument> {
    await this.waitForRateLimitSlot();

    const response = await fetch(buildJinaReaderUrl(this.options.baseUrl, hit.url), {
      headers: {
        Accept: "text/plain",
        ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}),
      },
    });

    if (!response.ok) {
      throw new Error(`Jina reader failed for ${hit.url} with status ${response.status}.`);
    }

    const content = normalizeTextContent(await response.text());

    if (content.length === 0) {
      throw new Error(`Jina reader returned empty content for ${hit.url}.`);
    }

    return {
      ...hit,
      content,
    };
  }
}
