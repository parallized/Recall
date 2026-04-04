import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  const temporaryDirectories: string[] = [];

  beforeEach(() => {
    mock.restore();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
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

  test("streams chat completion deltas and logs them while building JSON", async () => {
    const logMock = mock(() => {});
    console.log = logMock;
    const reporter = mock(() => {});
    const logsRoot = await mkdtemp(join(tmpdir(), "recall-chat-gateway-"));
    temporaryDirectories.push(logsRoot);

    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));

      expect(body.stream).toBe(true);
      expect(body.model).toBe("grok-4.20-beta");
      expect(body.response_format).toEqual({ type: "json_object" });
      expect(body.stream_options).toEqual({ include_usage: true });

      return streamResponse([
        'data: {"choices":[{"delta":{"content":"<think>Thinking"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" about tags</think>{\\"items\\":["}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"\\"alpha\\",\\"beta\\""}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"]}"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":15,"total_tokens":25}}\n\n',
        "data: [DONE]\n\n",
      ]);
    }) as unknown as typeof fetch;

    const gateway = new OpenAiCompatibleJsonGateway({
      baseUrl: "https://ai.huan666.de/v1",
      apiKey: "test-key",
      model: "grok-4.20-beta",
      logsRoot,
    });

    const result = await gateway.generateJson<{ items: string[] }>({
      schemaName: "truth_list",
      system: "Return JSON.",
      user: "Return {\"items\":[\"alpha\",\"beta\"]}.",
      reporter,
    });

    expect(result).toEqual({
      items: ["alpha", "beta"],
    });
    expect(logMock).toHaveBeenCalledWith("[ai:truth_list:reasoning] Thinking");
    expect(logMock).toHaveBeenCalledWith("[ai:truth_list:reasoning]  about tags");
    expect(logMock).toHaveBeenCalledWith("[ai:truth_list:content] {\"items\":[");
    expect(logMock).toHaveBeenCalledWith('[ai:truth_list:content] "alpha","beta"');
    expect(logMock).toHaveBeenCalledWith("[ai:truth_list:content] ]}");
    expect(reporter).toHaveBeenCalledWith({
      type: "usage",
      scope: "ai",
      schemaName: "truth_list",
      usage: {
        promptTokens: 10,
        completionTokens: 15,
        totalTokens: 25,
      },
    });

    const [logDirectory] = await readdir(logsRoot);
    const inputFile = await readFile(join(logsRoot, logDirectory, "input.json"), "utf8");
    const outputFile = await readFile(join(logsRoot, logDirectory, "output.txt"), "utf8");

    expect(inputFile).toContain('"schemaName": "truth_list"');
    expect(inputFile).toContain('"model": "grok-4.20-beta"');
    expect(outputFile).toContain("<think>Thinking about tags</think>");
    expect(outputFile).toContain('\\"items\\":[\\"alpha\\",\\"beta\\"]');
    expect(outputFile).toContain('"parsedJson": {');
  });

  test("throws when the streamed payload does not resolve to valid JSON", async () => {
    console.log = mock(() => {});
    const logsRoot = await mkdtemp(join(tmpdir(), "recall-chat-gateway-"));
    temporaryDirectories.push(logsRoot);

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
      logsRoot,
    });

    await expect(
      gateway.generateJson({
        schemaName: "truth_list",
        system: "Return JSON.",
        user: "Return JSON.",
      }),
    ).rejects.toThrow(/Chat completion returned invalid JSON\./);

    const [logDirectory] = await readdir(logsRoot);
    const outputFile = await readFile(join(logsRoot, logDirectory, "output.txt"), "utf8");

    expect(outputFile).toContain("not json");
    expect(outputFile).toContain("Chat completion returned invalid JSON.");
  });

  test("surfaces SSE error payloads from the upstream provider", async () => {
    console.log = mock(() => {});
    const logsRoot = await mkdtemp(join(tmpdir(), "recall-chat-gateway-"));
    temporaryDirectories.push(logsRoot);

    globalThis.fetch = mock(async () =>
      streamResponse([
        'data: {"error":{"message":"AppChatReverse: Chat failed, 403","type":"server_error","code":"upstream_error"}}\n\n',
        "data: [DONE]\n\n",
      ]),
    ) as unknown as typeof fetch;

    const gateway = new OpenAiCompatibleJsonGateway({
      baseUrl: "https://ai.huan666.de/v1",
      apiKey: "test-key",
      model: "grok-4.20-beta",
      logsRoot,
    });

    await expect(
      gateway.generateJson({
        schemaName: "truth_list",
        system: "Return JSON.",
        user: "Return JSON.",
      }),
    ).rejects.toThrow(/Chat completion stream returned error \(upstream_error\): AppChatReverse: Chat failed, 403/);

    const [logDirectory] = await readdir(logsRoot);
    const outputFile = await readFile(join(logsRoot, logDirectory, "output.txt"), "utf8");

    expect(outputFile).toContain("AppChatReverse: Chat failed, 403");
    expect(outputFile).toContain('"status": "error"');
  });

  test("includes upstream moderation codes for HTTP failures", async () => {
    console.log = mock(() => {});
    const logsRoot = await mkdtemp(join(tmpdir(), "recall-chat-gateway-"));
    temporaryDirectories.push(logsRoot);

    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({
          error: {
            message: "sensitive_words_detected (request id: 123)",
            code: "sensitive_words_detected",
          },
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      ),
    ) as unknown as typeof fetch;

    const gateway = new OpenAiCompatibleJsonGateway({
      baseUrl: "https://ai.huan666.de/v1",
      apiKey: "test-key",
      model: "grok-4.20-beta",
      logsRoot,
    });

    await expect(
      gateway.generateJson({
        schemaName: "truth_list",
        system: "Return JSON.",
        user: "Return JSON.",
      }),
    ).rejects.toThrow(/sensitive_words_detected/);

    const [logDirectory] = await readdir(logsRoot);
    const outputFile = await readFile(join(logsRoot, logDirectory, "output.txt"), "utf8");

    expect(outputFile).toContain("sensitive_words_detected");
    expect(outputFile).toContain('"status": "error"');
  });
});
