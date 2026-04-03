import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import {
  loadRuntimeConfig,
  type RuntimeConfig,
} from "./runtime/config";
import { HtmlSourceContentReader, JinaReaderSourceContentReader } from "./runtime/content";
import { LocalTransformersEmbeddingService } from "./runtime/embedder";
import {
  AiTaxonomyPlanner,
  AiTruthExtractor,
  HybridHierarchicalTagClassifier,
  KnowledgeCollectionOrchestrator,
} from "./runtime/pipeline";
import { SemanticTruthSearchService } from "./runtime/semantic-search";
import type { CollectionProgressEvent, TokenUsage } from "./runtime/types";
import type { CaptureJobService } from "./runtime/capture-service";
import { PersistentCaptureJobService } from "./runtime/capture-service";
import {
  DirectWebSearchApiProvider,
  GrokWebSearchProvider,
  MissingSearchProvider,
} from "./runtime/search";
import { MissingChatJsonGateway, OpenAiCompatibleJsonGateway } from "./runtime/ai";
import { createSqlitePersistence, type KnowledgeStore } from "./db";
import { createSqliteCaptureJobRepository } from "./db/capture-jobs";
import { learningSignalSchema } from "./schema";
import { t } from "elysia";

export type CollectionPipeline = Pick<KnowledgeCollectionOrchestrator, "collect">;
export type QueryReadModel = Pick<
  KnowledgeStore,
  "listTruths" | "listTagProgress" | "listRecommendations" | "getTaxonomy"
>;

const collectRequestSchema = t.Object({
  query: t.String({ minLength: 1 }),
  provider: t.Union([t.Literal("web-search-api"), t.Literal("grok-search")]),
});

const createCaptureJobSchema = t.Object({
  query: t.String({ minLength: 1 }),
  provider: t.Union([t.Literal("web-search-api"), t.Literal("grok-search")]),
  searchLimit: t.Optional(t.Number({ minimum: 1, maximum: 100 })),
  readConcurrency: t.Optional(t.Number({ minimum: 1, maximum: 8 })),
});

const startCaptureProcessingSchema = t.Object({
  readConcurrency: t.Optional(t.Number({ minimum: 1, maximum: 8 })),
});

const createEmptyUsage = (): TokenUsage => ({
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
});

const accumulateUsage = (left: TokenUsage, right: TokenUsage): TokenUsage => ({
  promptTokens: left.promptTokens + right.promptTokens,
  completionTokens: left.completionTokens + right.completionTokens,
  totalTokens: left.totalTokens + right.totalTokens,
});

const toErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isInvalidStreamStateError = (error: unknown) =>
  error instanceof TypeError &&
  typeof (error as { code?: unknown }).code === "string" &&
  (error as { code?: string }).code === "ERR_INVALID_STATE";

const buildRepositorySnapshot = (persistence: KnowledgeStore) => {
  const taxonomy = persistence.getTaxonomy();
  const truths = persistence.listTruths();
  const progressByNodeId = new Map(persistence.listTagProgress().map((entry) => [entry.nodeId, entry]));
  const nodeById = new Map(taxonomy.map((node) => [node.id, node]));

  return {
    summary: {
      truthCount: truths.length,
      level1TagCount: taxonomy.filter((node) => node.level === 1).length,
      level2TagCount: taxonomy.filter((node) => node.level === 2).length,
      level3TagCount: taxonomy.filter((node) => node.level === 3).length,
      multipleChoiceCount: truths.filter((truth) => truth.questionType === "multiple_choice").length,
      openEndedCount: truths.filter((truth) => truth.questionType !== "multiple_choice").length,
    },
    taxonomy: taxonomy.map((node) => ({
      ...node,
      progress: progressByNodeId.get(node.id)?.progress ?? 0,
      truthCount: progressByNodeId.get(node.id)?.truthCount ?? 0,
    })),
    truths: truths
      .map((truth) => ({
        ...truth,
        level1TagName: nodeById.get(truth.level1TagId)?.name ?? truth.level1TagId,
        level2TagName: nodeById.get(truth.level2TagId)?.name ?? truth.level2TagId,
        level3TagName: nodeById.get(truth.level3TagId)?.name ?? truth.level3TagId,
      }))
      .sort((left, right) =>
        `${left.level1TagName}/${left.level2TagName}/${left.level3TagName}/${left.statement}`.localeCompare(
          `${right.level1TagName}/${right.level2TagName}/${right.level3TagName}/${right.statement}`,
          "zh-CN",
        ),
      ),
  };
};

export const createApp = ({
  pipeline,
  persistence,
  readModel: _readModel,
  semanticSearch,
  captureJobs,
  settings,
}: {
  pipeline: CollectionPipeline;
  persistence: KnowledgeStore;
  readModel?: QueryReadModel;
  semanticSearch?: SemanticTruthSearchService;
  captureJobs?: CaptureJobService;
  settings?: any;
}) =>
  new Elysia()
    .use(cors())
    .onError(({ code, error, set }) => {
      set.status = code === "VALIDATION" ? 400 : 500;

      return {
        code,
        message: toErrorMessage(error),
      };
    })
    .get("/health", () => ({ status: "ok" }))
    .get("/truths", () => persistence.listTruths())
    .get("/repository", () => buildRepositorySnapshot(persistence))
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
    .get("/capture/jobs", () => captureJobs?.listJobs() ?? [])
    .get("/capture/jobs/:id", ({ params, set }) => {
      if (!captureJobs) {
        set.status = 503;
        return {
          message: "Capture jobs are not configured.",
        };
      }

      const detail = captureJobs.getJobDetail(params.id);

      if (!detail) {
        set.status = 404;
        return {
          message: `Capture job not found: ${params.id}`,
        };
      }

      return detail;
    })
    .post("/capture/jobs", async ({ body, set }) => {
      if (!captureJobs) {
        set.status = 503;
        return {
          message: "Capture jobs are not configured.",
        };
      }

      set.status = 202;
      return captureJobs.createJob({
        query: body.query,
        provider: body.provider,
        searchLimit: body.searchLimit ?? 100,
        readConcurrency: body.readConcurrency ?? 3,
      });
    }, { body: createCaptureJobSchema })
    .post("/capture/jobs/:id/process", async ({ params, body, set }) => {
      if (!captureJobs) {
        set.status = 503;
        return {
          message: "Capture jobs are not configured.",
        };
      }

      set.status = 202;
      return captureJobs.startProcessing({
        jobId: params.id,
        readConcurrency: body.readConcurrency ?? 3,
      });
    }, { body: startCaptureProcessingSchema })
    .post("/learning/signals", ({ body }) => {
      persistence.recordSignal(body);
      return { ok: true };
    }, { body: learningSignalSchema })
    .post("/knowledge/collect", async ({ body }) => {
      const result = await pipeline.collect(body);
      return persistence.saveCollection(result);
    }, { body: collectRequestSchema })
    .post("/knowledge/collect/stream", async ({ body }) => {
      const encoder = new TextEncoder();
      let streamClosed = false;

      const stream = new ReadableStream({
        start(controller) {
          const totals = createEmptyUsage();
          const close = () => {
            if (streamClosed) {
              return;
            }

            try {
              controller.close();
            } catch (error) {
              if (!isInvalidStreamStateError(error)) {
                throw error;
              }
            } finally {
              streamClosed = true;
            }
          };
          const send = (event: CollectionProgressEvent | { type: "error"; message: string } | { type: "result"; result: { collectionId: string; truthCount: number; sourceCount: number; taxonomyCount: number }; usage: TokenUsage }) => {
            if (streamClosed) {
              return;
            }

            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            } catch (error) {
              if (!isInvalidStreamStateError(error)) {
                throw error;
              }

              streamClosed = true;
            }
          };

          const reporter = (event: CollectionProgressEvent) => {
            if (event.type === "usage") {
              const nextTotals = accumulateUsage(totals, event.usage);
              totals.promptTokens = nextTotals.promptTokens;
              totals.completionTokens = nextTotals.completionTokens;
              totals.totalTokens = nextTotals.totalTokens;

              send({
                ...event,
                usage: event.usage,
                totals: nextTotals,
              });
              return;
            }

            send(event);
          };

          void (async () => {
            try {
              const result = await pipeline.collect({
                ...body,
                reporter,
              });

              reporter({
                type: "phase",
                phase: "persist",
                status: "start",
                message: "Persisting collection into SQLite.",
              });

              const saved = persistence.saveCollection(result);

              reporter({
                type: "phase",
                phase: "persist",
                status: "complete",
                message: `Saved ${saved.truthCount} truths.`,
                count: saved.truthCount,
              });

              send({
                type: "result",
                result: {
                  collectionId: saved.collectionId,
                  truthCount: saved.truthCount,
                  sourceCount: saved.sourceCount,
                  taxonomyCount: saved.taxonomy.length,
                },
                usage: totals,
              });
            } catch (error) {
              send({
                type: "error",
                message: toErrorMessage(error),
              });
            } finally {
              close();
            }
          })();
        },
        cancel() {
          streamClosed = true;
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        },
      });
    }, { body: collectRequestSchema });

export const createProductionRuntime = (config: RuntimeConfig) => {
  const store = createSqlitePersistence(config.databasePath);
  const captureRepository = createSqliteCaptureJobRepository(config.databasePath);
  const aiConfigured = Boolean(config.aiBaseUrl && config.aiApiKey && config.aiChatModel);
  const webSearchConfigured = Boolean(config.webSearchApiUrl && config.webSearchApiKey);
  const grokConfigured = Boolean(config.grokBaseUrl && config.grokApiKey && config.grokModel);

  const gateway = aiConfigured
    ? new OpenAiCompatibleJsonGateway({ baseUrl: config.aiBaseUrl!, apiKey: config.aiApiKey!, model: config.aiChatModel! })
    : new MissingChatJsonGateway("AI gateway missing.");

  const embedder = new LocalTransformersEmbeddingService(config.embeddingModel);
  const providers = [
    webSearchConfigured ? new DirectWebSearchApiProvider({ baseUrl: config.webSearchApiUrl!, apiKey: config.webSearchApiKey! }) : new MissingSearchProvider("web-search-api", "Missing config"),
    grokConfigured ? new GrokWebSearchProvider({ baseUrl: config.grokBaseUrl!, apiKey: config.grokApiKey!, model: config.grokModel! }) : new MissingSearchProvider("grok-search", "Missing config"),
  ];
  const pipeline = new KnowledgeCollectionOrchestrator({
    providers,
    sourceReader: new HtmlSourceContentReader(),
    taxonomyPlanner: new AiTaxonomyPlanner(gateway),
    truthExtractor: new AiTruthExtractor(gateway),
    tagClassifier: new HybridHierarchicalTagClassifier({ gateway, embedder }),
    embedder,
    taxonomyStore: store,
  });
  const captureJobs = new PersistentCaptureJobService({
    repository: captureRepository,
    providers,
    sourceReader: new JinaReaderSourceContentReader({
      baseUrl: config.jinaReaderBaseUrl ?? "https://r.jina.ai/http://",
      apiKey: config.jinaReaderApiKey,
    }),
    taxonomyPlanner: new AiTaxonomyPlanner(gateway),
    truthExtractor: new AiTruthExtractor(gateway),
    tagClassifier: new HybridHierarchicalTagClassifier({ gateway, embedder }),
    embedder,
    knowledgeStore: store,
  });

  const semanticSearch = new SemanticTruthSearchService({ embedder, store });

  void captureJobs.resumePendingJobs();

  return {
    config,
    store,
    pipeline,
    captureJobs,
    semanticSearch,
    app: createApp({
      pipeline,
      persistence: store,
      semanticSearch,
      captureJobs,
      settings: {
        ai: { configured: aiConfigured, baseUrl: config.aiBaseUrl ?? null, chatModel: config.aiChatModel ?? null },
        embeddingModel: config.embeddingModel,
        capture: {
          jinaReaderBaseUrl: config.jinaReaderBaseUrl ?? null,
          defaults: {
            searchLimit: 100,
            readConcurrency: 3,
            aiConcurrency: 1,
          },
        },
        providers: [
          { id: "web-search-api", configured: webSearchConfigured, summary: "External search API" },
          { id: "grok-search", configured: grokConfigured, summary: "Grok chat-completion bridge" },
        ],
      },
    }),
  };
};

export { createInMemoryPersistence, createSqlitePersistence } from "./db";
export { loadRuntimeConfig };

if (import.meta.main) {
  const runtime = createProductionRuntime(loadRuntimeConfig());
  runtime.app.listen(runtime.app.server?.port || 4174);
  console.log(`Recall API active at http://localhost:${runtime.app.server?.port || 4174}`);
}
