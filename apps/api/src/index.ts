import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import {
  loadRuntimeConfig,
  type RuntimeConfig,
} from "./runtime/config";
import { HtmlSourceContentReader } from "./runtime/content";
import { LocalTransformersEmbeddingService } from "./runtime/embedder";
import {
  AiTaxonomyPlanner,
  AiTruthExtractor,
  HybridHierarchicalTagClassifier,
  KnowledgeCollectionOrchestrator,
} from "./runtime/pipeline";
import { SemanticTruthSearchService } from "./runtime/semantic-search";
import {
  DirectWebSearchApiProvider,
  GrokWebSearchProvider,
  MissingSearchProvider,
} from "./runtime/search";
import { MissingChatJsonGateway, OpenAiCompatibleJsonGateway } from "./runtime/ai";
import { createSqlitePersistence, type KnowledgeStore } from "./db";
import { learningSignalSchema } from "./schema";
import { t } from "elysia";

export const createApp = ({
  pipeline,
  persistence,
  semanticSearch,
  settings,
}: {
  pipeline: KnowledgeCollectionOrchestrator;
  persistence: KnowledgeStore;
  semanticSearch?: SemanticTruthSearchService;
  settings?: any;
}) =>
  new Elysia()
    .use(cors())
    .get("/health", () => ({ status: "ok" }))
    .get("/truths", () => persistence.listTruths())
    .get("/tags/progress", () => persistence.listTagProgress())
    .get("/graph", () => {
      const taxonomy = persistence.getTaxonomy();
      const progress = persistence.listTagProgress();
      const nodeMap = new Map(taxonomy.map(n => [n.id, n]));
      return progress.map(p => {
        const node = nodeMap.get(p.nodeId);
        return node ? { ...node, progress: p.progress, truthCount: p.truthCount } : null;
      }).filter(n => n !== null);
    })
    .get("/recommendations", ({ query }) => persistence.listRecommendations(typeof query.now === "string" ? query.now : new Date().toISOString()))
    .get("/search/semantic", async ({ query }) => semanticSearch?.search(typeof query.q === "string" ? query.q : "") ?? [])
    .get("/settings", () => settings ?? null)
    .post("/learning/signals", ({ body }) => {
      persistence.recordSignal(body);
      return { ok: true };
    }, { body: learningSignalSchema })
    .post("/knowledge/collect", async ({ body }) => {
      const result = await pipeline.collect(body);
      return persistence.saveCollection(result);
    }, {
      body: t.Object({
        query: t.String({ minLength: 1 }),
        provider: t.Union([t.Literal("web-search-api"), t.Literal("grok-search")]),
      }),
    });

export const createProductionRuntime = (config: RuntimeConfig) => {
  const store = createSqlitePersistence(config.databasePath);
  const aiConfigured = Boolean(config.aiBaseUrl && config.aiApiKey && config.aiChatModel);
  const webSearchConfigured = Boolean(config.webSearchApiUrl && config.webSearchApiKey);
  const grokConfigured = Boolean(config.grokBaseUrl && config.grokApiKey && config.grokModel);

  const gateway = aiConfigured
    ? new OpenAiCompatibleJsonGateway({ baseUrl: config.aiBaseUrl!, apiKey: config.aiApiKey!, model: config.aiChatModel! })
    : new MissingChatJsonGateway("AI gateway missing.");

  const embedder = new LocalTransformersEmbeddingService(config.embeddingModel);
  const pipeline = new KnowledgeCollectionOrchestrator({
    providers: [
      webSearchConfigured ? new DirectWebSearchApiProvider({ baseUrl: config.webSearchApiUrl!, apiKey: config.webSearchApiKey! }) : new MissingSearchProvider("web-search-api", "Missing config"),
      grokConfigured ? new GrokWebSearchProvider({ baseUrl: config.grokBaseUrl!, apiKey: config.grokApiKey!, model: config.grokModel! }) : new MissingSearchProvider("grok-search", "Missing config"),
    ],
    sourceReader: new HtmlSourceContentReader(),
    taxonomyPlanner: new AiTaxonomyPlanner(gateway),
    truthExtractor: new AiTruthExtractor(gateway),
    tagClassifier: new HybridHierarchicalTagClassifier({ gateway, embedder }),
    embedder,
    taxonomyStore: store,
  });

  const semanticSearch = new SemanticTruthSearchService({ embedder, store });

  return {
    config,
    app: createApp({
      pipeline,
      persistence: store,
      semanticSearch,
      settings: {
        ai: { configured: aiConfigured, baseUrl: config.aiBaseUrl ?? null, chatModel: config.aiChatModel ?? null },
        embeddingModel: config.embeddingModel,
        providers: [
          { id: "web-search-api", configured: webSearchConfigured, summary: "External search API" },
          { id: "grok-search", configured: grokConfigured, summary: "Grok chat-completion bridge" },
        ],
      },
    }),
  };
};

if (import.meta.main) {
  const runtime = createProductionRuntime(loadRuntimeConfig());
  runtime.app.listen(runtime.app.server?.port || 4174);
  console.log(`Recall API active at http://localhost:${runtime.app.server?.port || 4174}`);
}
