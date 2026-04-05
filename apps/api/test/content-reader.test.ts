import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { JinaReaderSourceContentReader } from "../src/runtime/content";

describe("content-reader", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mock.restore();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("throttles Jina reader requests to 15 rpm by default", async () => {
    const hit = {
      title: "React docs",
      url: "https://react.dev/reference/react/useState",
      snippet: "Official React docs",
    };
    const fetchTimes: number[] = [];
    const sleepCalls: number[] = [];
    let now = 0;

    globalThis.fetch = mock(async () => {
      fetchTimes.push(now);
      return new Response("React lets you add state to a component.", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }) as unknown as typeof fetch;

    const reader = new JinaReaderSourceContentReader({
      baseUrl: "https://r.jina.ai/http://",
      requestsPerMinute: 15,
      now: () => now,
      sleep: async (ms) => {
        sleepCalls.push(ms);
        now += ms;
      },
    });

    await Promise.all([reader.read(hit), reader.read(hit), reader.read(hit)]);

    expect(fetchTimes).toEqual([0, 4000, 8000]);
    expect(sleepCalls).toEqual([4000, 4000]);
  });
});
