import { Readability } from "@mozilla/readability";
import { DOMParser } from "linkedom";

import type { SearchHit, SourceContentReader, SourceDocument } from "./types";

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
      content: article.textContent.replace(/\s+/g, " ").trim(),
    };
  }
}
