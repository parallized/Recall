import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { GrokWebSearchProvider } from "../src/runtime/search";

describe("search-provider", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mock.restore();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("grok-search uses the OpenAI-compatible chat gateway and parses raw JSON results", async () => {
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://ai.huan666.de/v1/chat/completions");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      });

      const body = JSON.parse(String(init?.body));

      expect(body.model).toBe("grok-4.20-beta");
      expect(body.stream).toBe(false);
      expect(body.temperature).toBe(0);
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0].role).toBe("system");
      expect(body.messages[0].content).toContain("Use live web search");
      expect(body.messages[0].content).toContain("Return only raw JSON");
      expect(body.messages[1].role).toBe("user");
      expect(body.messages[1].content).toContain("React concurrent rendering");
      expect(body.messages[1].content).toContain("Return at most 2 results");

      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: [
                  "```json",
                  '{"results":[',
                  '{"title":"React docs","url":"https://react.dev/reference/react/useTransition","snippet":"useTransition lets you mark updates as non-blocking."},',
                  '{"title":"Concurrent rendering","url":"https://react.dev/blog/2022/03/29/react-v18","snippet":"React 18 introduces concurrent rendering foundations."}',
                  "]}",
                  "```",
                ].join("\n"),
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = new GrokWebSearchProvider({
      baseUrl: "https://ai.huan666.de/v1",
      apiKey: "test-key",
      model: "grok-4.20-beta",
    });

    const results = await provider.search({
      query: "React concurrent rendering",
      limit: 2,
    });

    expect(results).toEqual([
      {
        title: "React docs",
        url: "https://react.dev/reference/react/useTransition",
        snippet: "useTransition lets you mark updates as non-blocking.",
      },
      {
        title: "Concurrent rendering",
        url: "https://react.dev/blog/2022/03/29/react-v18",
        snippet: "React 18 introduces concurrent rendering foundations.",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("grok-search rejects invalid model output instead of silently accepting prose", async () => {
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "Here are some useful links: react.dev, blog posts, and docs.",
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    ) as unknown as typeof fetch;

    const provider = new GrokWebSearchProvider({
      baseUrl: "https://ai.huan666.de/v1",
      apiKey: "test-key",
      model: "grok-4.20-beta",
    });

    await expect(
      provider.search({
        query: "React concurrent rendering",
        limit: 3,
      }),
    ).rejects.toThrow("Grok web search returned invalid JSON.");
  });
});
