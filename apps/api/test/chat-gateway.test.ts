import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { OpenAiCompatibleJsonGateway } from "../src/runtime/ai";

const streamResponse = (chunks: string[]) => {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }

        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    },
  );
};

describe("chat-gateway", () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;

  beforeEach(() => {
    mock.restore();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  });

  test("streams chat completion deltas and logs them while building JSON", async () => {
    const logMock = mock(() => {});
    console.log = logMock;

    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));

      expect(body.stream).toBe(true);
      expect(body.model).toBe("grok-4.20-beta");

      return streamResponse([
        'data: {"choices":[{"delta":{"content":"{\\"items\\":["}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"\\"alpha\\",\\"beta\\""}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"]}"}}]}\n\n',
        "data: [DONE]\n\n",
      ]);
    }) as unknown as typeof fetch;

    const gateway = new OpenAiCompatibleJsonGateway({
      baseUrl: "https://ai.huan666.de/v1",
      apiKey: "test-key",
      model: "grok-4.20-beta",
    });

    const result = await gateway.generateJson<{ items: string[] }>({
      schemaName: "truth_list",
      system: "Return JSON.",
      user: "Return {\"items\":[\"alpha\",\"beta\"]}.",
    });

    expect(result).toEqual({
      items: ["alpha", "beta"],
    });
    expect(logMock).toHaveBeenCalledWith("[ai:truth_list] {\"items\":[");
    expect(logMock).toHaveBeenCalledWith('[ai:truth_list] "alpha","beta"');
    expect(logMock).toHaveBeenCalledWith("[ai:truth_list] ]}");
  });

  test("throws when the streamed payload does not resolve to valid JSON", async () => {
    console.log = mock(() => {});

    globalThis.fetch = mock(async () =>
      streamResponse([
        'data: {"choices":[{"delta":{"content":"not json"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    ) as unknown as typeof fetch;

    const gateway = new OpenAiCompatibleJsonGateway({
      baseUrl: "https://ai.huan666.de/v1",
      apiKey: "test-key",
      model: "grok-4.20-beta",
    });

    await expect(
      gateway.generateJson({
        schemaName: "truth_list",
        system: "Return JSON.",
        user: "Return JSON.",
      }),
    ).rejects.toThrow("Chat completion returned invalid JSON.");
  });
});
