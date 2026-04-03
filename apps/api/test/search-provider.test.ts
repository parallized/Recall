import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { GrokWebSearchProvider } from "../src/runtime/search";

describe("search-provider", () => {
  const originalFetch = globalThis.fetch;
  const temporaryDirectories: string[] = [];

  beforeEach(() => {
    mock.restore();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        rm(directory, {
          recursive: true,
          force: true,
        }),
      ),
    );
  });

  test("grok-search uses the OpenAI-compatible chat gateway and parses raw JSON results", async () => {
    const reporter = mock(() => {});
    const logsRoot = await mkdtemp(join(tmpdir(), "recall-grok-search-"));
    temporaryDirectories.push(logsRoot);
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
      expect(body.response_format).toEqual({ type: "json_object" });
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].role).toBe("user");
      expect(body.messages[0].content).toContain("Use live web search");
      expect(body.messages[0].content).toContain("Return only raw JSON");
      expect(body.messages[0].content).toContain("question bank");
      expect(body.messages[0].content).toContain("official docs");
      expect(body.messages[0].content).toContain("React concurrent rendering");
      expect(body.messages[0].content).toContain("Return at most 2 results");

      return new Response(
        JSON.stringify({
          usage: {
            prompt_tokens: 11,
            completion_tokens: 7,
            total_tokens: 18,
          },
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
      logsRoot,
    });

    const results = await provider.search({
      query: "React concurrent rendering",
      limit: 2,
      reporter,
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
    expect(reporter).toHaveBeenCalledWith({
      type: "usage",
      scope: "search",
      usage: {
        promptTokens: 11,
        completionTokens: 7,
        totalTokens: 18,
      },
    });

    const [logDirectory] = await readdir(logsRoot);
    const inputFile = await readFile(join(logsRoot, logDirectory, "input.json"), "utf8");
    const outputFile = await readFile(join(logsRoot, logDirectory, "output.txt"), "utf8");

    expect(inputFile).toContain('"provider": "grok-search"');
    expect(inputFile).toContain('"query": "React concurrent rendering"');
    expect(outputFile).toContain('\\"title\\":\\"React docs\\"');
    expect(outputFile).toContain('"parsedJson": {');
  });

  test("grok-search rejects invalid model output instead of silently accepting prose", async () => {
    const logsRoot = await mkdtemp(join(tmpdir(), "recall-grok-search-"));
    temporaryDirectories.push(logsRoot);

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
      logsRoot,
    });

    await expect(
      provider.search({
        query: "React concurrent rendering",
        limit: 3,
      }),
    ).rejects.toThrow(/Grok web search returned invalid JSON\./);

    const [logDirectory] = await readdir(logsRoot);
    const outputFile = await readFile(join(logsRoot, logDirectory, "output.txt"), "utf8");

    expect(outputFile).toContain("Here are some useful links");
    expect(outputFile).toContain("Grok web search returned invalid JSON.");
  });

  test("grok-search extracts JSON from wrapped model output", async () => {
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  'Sure, here is the object: {"results":[{"title":"React docs","url":"https://react.dev","snippet":"Official React documentation."}]}',
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
        query: "React docs",
        limit: 1,
      }),
    ).resolves.toEqual([
      {
        title: "React docs",
        url: "https://react.dev",
        snippet: "Official React documentation.",
      },
    ]);
  });

  test("grok-search retries transient certificate verification failures", async () => {
    const fetchMock = mock(async () => {
      if (fetchMock.mock.calls.length === 1) {
        throw new Error("unknown certificate verification error");
      }

      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"results":[{"title":"React docs","url":"https://react.dev","snippet":"Official React documentation."}]}',
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

    await expect(
      provider.search({
        query: "React docs",
        limit: 1,
      }),
    ).resolves.toEqual([
      {
        title: "React docs",
        url: "https://react.dev",
        snippet: "Official React documentation.",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
