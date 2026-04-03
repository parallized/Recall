import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { searchProviderKindSchema } from "@recall/domain";
import { createProductionRuntime, loadRuntimeConfig } from "../../api/src/index";

const collectKnowledgeInputSchema = z.object({
  query: z.string().min(1),
  provider: searchProviderKindSchema,
});

const searchTruthsInputSchema = z.object({
  query: z.string().min(1),
});

const tagProgressInputSchema = z.object({});

type McpHandlers = {
  collectKnowledge(input: z.infer<typeof collectKnowledgeInputSchema>): Promise<unknown>;
  searchTruths(input: z.infer<typeof searchTruthsInputSchema>): Promise<unknown>;
  getTagProgress(input: z.infer<typeof tagProgressInputSchema>): Promise<unknown>;
};

const toStructuredContent = (value: unknown): Record<string, unknown> => ({
  data: value,
});

export const createMcpToolRegistry = (handlers: McpHandlers) => {
  const tools = new Map<
    string,
    {
      schema: z.ZodTypeAny;
      invoke: (input: unknown) => Promise<unknown>;
    }
  >([
    [
      "knowledge.collect",
      {
        schema: collectKnowledgeInputSchema,
        invoke: (input) => handlers.collectKnowledge(collectKnowledgeInputSchema.parse(input)),
      },
    ],
    [
      "truth.search",
      {
        schema: searchTruthsInputSchema,
        invoke: (input) => handlers.searchTruths(searchTruthsInputSchema.parse(input)),
      },
    ],
    [
      "tag.progress",
      {
        schema: tagProgressInputSchema,
        invoke: (input) => handlers.getTagProgress(tagProgressInputSchema.parse(input)),
      },
    ],
  ]);

  return {
    listToolNames: () => [...tools.keys()],
    invoke: async (toolName: string, input: unknown) => {
      const tool = tools.get(toolName);

      if (!tool) {
        throw new Error(`Unknown tool: ${toolName}`);
      }

      return tool.invoke(input);
    },
  };
};

export const createRecallMcpServer = () => {
  const runtime = createProductionRuntime(loadRuntimeConfig());
  const registry = createMcpToolRegistry({
    collectKnowledge: async ({ query, provider }) => {
      const result = await runtime.pipeline.collect({ query, provider });
      return runtime.store.saveCollection(result);
    },
    searchTruths: async ({ query }) => runtime.semanticSearch.search(query),
    getTagProgress: async () => runtime.store.listTagProgress(),
  });

  const server = new McpServer(
    {
      name: "recall-mcp-server",
      version: "0.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
      instructions:
        "Use Recall tools to collect web knowledge into truth units, search stored truths semantically, and inspect tag progress.",
    },
  );

  server.registerTool(
    "knowledge.collect",
    {
      title: "Collect Knowledge",
      description: "Collect knowledge from the live web and transform it into atomic truths.",
      inputSchema: collectKnowledgeInputSchema,
    },
    async (input) => {
      const result = await registry.invoke("knowledge.collect", input);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
        structuredContent: toStructuredContent(result),
      };
    },
  );

  server.registerTool(
    "truth.search",
    {
      title: "Search Truths",
      description: "Run semantic search over stored truth units.",
      inputSchema: searchTruthsInputSchema,
    },
    async (input) => {
      const result = await registry.invoke("truth.search", input);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
        structuredContent: toStructuredContent(result),
      };
    },
  );

  server.registerTool(
    "tag.progress",
    {
      title: "Tag Progress",
      description: "List progress snapshots for every existing taxonomy tag.",
      inputSchema: tagProgressInputSchema,
    },
    async (input) => {
      const result = await registry.invoke("tag.progress", input);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
        structuredContent: toStructuredContent(result),
      };
    },
  );

  return server;
};

if (import.meta.main) {
  const server = createRecallMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
