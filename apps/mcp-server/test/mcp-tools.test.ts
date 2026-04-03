import { describe, expect, test } from "bun:test";

import { createMcpToolRegistry } from "../src/index";

describe("mcp-tools", () => {
  test("exposes truth collection, truth search, and tag progress tools", async () => {
    const registry = createMcpToolRegistry({
      collectKnowledge: async ({ query, provider }) => ({
        query,
        provider,
        truthCount: 3,
      }),
      searchTruths: async ({ query }) => [
        {
          id: "truth-1",
          statement: `Result for ${query}`,
        },
      ],
      getTagProgress: async () => [
        {
          nodeId: "react",
          nodeName: "React",
          progress: 0.62,
        },
      ],
    });

    expect(registry.listToolNames()).toEqual([
      "knowledge.collect",
      "truth.search",
      "tag.progress",
    ]);

    expect(
      await registry.invoke("knowledge.collect", {
        query: "React hooks",
        provider: "grok-search",
      }),
    ).toEqual({
      query: "React hooks",
      provider: "grok-search",
      truthCount: 3,
    });

    expect(await registry.invoke("truth.search", { query: "Hooks" })).toEqual([
      {
        id: "truth-1",
        statement: "Result for Hooks",
      },
    ]);

    expect(await registry.invoke("tag.progress", {})).toEqual([
      {
        nodeId: "react",
        nodeName: "React",
        progress: 0.62,
      },
    ]);
  });
});
