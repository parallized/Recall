import { deduplicateTruths, type CollectedTruth, type SearchProviderKind, type TaxonomyNode, type TruthDraft } from "@recall/domain";

import type { CaptureJobRepository } from "../db/capture-jobs";
import type { KnowledgeStore } from "../db";
import type {
  CaptureJob,
  CaptureJobDetail,
  CaptureSource,
  CreateCaptureJobInput,
  QueuedDocument,
  StartCaptureProcessingInput,
} from "./capture-types";
import type {
  EmbeddingService,
  ProgressReporter,
  SearchProvider,
  SourceContentReader,
  TaxonomyPlanner,
  TruthExtractor,
} from "./types";
import type { HybridHierarchicalTagClassifier } from "./pipeline";
import { buildStudySearchQuery } from "./search";

type CaptureJobServiceDependencies = {
  repository: CaptureJobRepository;
  providers: SearchProvider[];
  sourceReader: SourceContentReader;
  taxonomyPlanner: TaxonomyPlanner;
  truthExtractor: TruthExtractor;
  tagClassifier: HybridHierarchicalTagClassifier;
  embedder: EmbeddingService;
  knowledgeStore: KnowledgeStore;
};

type DocumentWaiter<T> = (value: T | null) => void;

class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<DocumentWaiter<T>> = [];
  private closed = false;

  push(item: T) {
    if (this.closed) {
      return;
    }

    const waiter = this.waiters.shift();

    if (waiter) {
      waiter(item);
      return;
    }

    this.items.push(item);
  }

  close() {
    if (this.closed) {
      return;
    }

    this.closed = true;

    while (this.waiters.length > 0) {
      this.waiters.shift()!(null);
    }
  }

  async next(): Promise<T | null> {
    if (this.items.length > 0) {
      return this.items.shift()!;
    }

    if (this.closed) {
      return null;
    }

    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

class AsyncMutex {
  private tail = Promise.resolve();

  async runExclusive<T>(operation: () => Promise<T>) {
    const previous = this.tail.catch(() => undefined);
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;

    try {
      return await operation();
    } finally {
      release();
    }
  }
}

const mergeTaxonomy = (existingNodes: TaxonomyNode[], plannedNodes: TaxonomyNode[]) => {
  const mergedById = new Map<string, TaxonomyNode>();

  for (const node of existingNodes) {
    mergedById.set(node.id, node);
  }

  for (const node of plannedNodes) {
    mergedById.set(node.id, node);
  }

  return [...mergedById.values()];
};

const dedupeHits = (hits: Awaited<ReturnType<SearchProvider["search"]>>) => {
  const byUrl = new Map<string, (typeof hits)[number]>();

  for (const hit of hits) {
    if (!hit.url) {
      continue;
    }

    if (!byUrl.has(hit.url)) {
      byUrl.set(hit.url, {
        ...hit,
        title: hit.title.trim() || hit.url,
        snippet: hit.snippet.trim(),
      });
    }
  }

  return [...byUrl.values()];
};

const toErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const describeStudyCard = (truth: Pick<TruthDraft, "statement" | "summary" | "answer" | "explanation" | "options">) =>
  [
    truth.statement,
    truth.summary,
    truth.answer ?? "",
    truth.explanation ?? "",
    truth.options?.join("\n") ?? "",
  ]
    .filter(Boolean)
    .join("\n");

const runWithConcurrency = async <T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
) => {
  let index = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (index < items.length) {
        const current = items[index];
        index += 1;

        if (!current) {
          continue;
        }

        await worker(current);
      }
    }),
  );
};

export interface CaptureJobService {
  listJobs(): CaptureJob[];
  getJobDetail(jobId: string): CaptureJobDetail | null;
  createJob(input: CreateCaptureJobInput): Promise<CaptureJobDetail>;
  startProcessing(input: StartCaptureProcessingInput): Promise<CaptureJobDetail>;
  resumePendingJobs(): Promise<void>;
}

export class PersistentCaptureJobService implements CaptureJobService {
  private readonly runningJobs = new Map<string, Promise<void>>();
  private readonly extractionMutex = new AsyncMutex();

  constructor(private readonly options: CaptureJobServiceDependencies) {}

  listJobs() {
    return this.options.repository.listJobs();
  }

  getJobDetail(jobId: string) {
    return this.options.repository.getJobDetail(jobId);
  }

  async createJob(input: CreateCaptureJobInput) {
    const job = this.options.repository.createJob(input);
    this.options.repository.appendEvent(job.id, {
      channel: "status",
      label: "QUEUED",
      text: `Queued source discovery for "${job.query}".`,
    });
    this.runInBackground(job.id, () => this.runDiscovery(job.id));

    return this.getRequiredDetail(job.id);
  }

  async startProcessing(input: StartCaptureProcessingInput) {
    const job = this.options.repository.getJob(input.jobId);

    if (!job) {
      throw new Error(`Capture job not found: ${input.jobId}`);
    }

    if (job.status === "queued_search" || job.status === "searching") {
      throw new Error("Source discovery is still running. Start reading after search completes.");
    }

    if (job.status === "completed") {
      throw new Error("This capture job is already complete. Create a new job to run another capture.");
    }

    this.options.repository.updateJob(job.id, {
      readConcurrency: input.readConcurrency,
    });
    this.options.repository.appendEvent(job.id, {
      channel: "status",
      label: "PROCESS",
      text: `Queued reading with concurrency ${input.readConcurrency}. Source-to-question extraction uses one shared AI lane.`,
    });
    this.runInBackground(job.id, () => this.runProcessing(job.id));

    return this.getRequiredDetail(job.id);
  }

  async resumePendingJobs() {
    for (const job of this.options.repository.listResumableJobs()) {
      if (job.status === "queued_search" || job.status === "searching") {
        this.runInBackground(job.id, () => this.runDiscovery(job.id));
        continue;
      }

      if (job.status === "processing") {
        this.runInBackground(job.id, () => this.runProcessing(job.id));
      }
    }
  }

  private getRequiredDetail(jobId: string) {
    const detail = this.options.repository.getJobDetail(jobId);

    if (!detail) {
      throw new Error(`Capture job not found: ${jobId}`);
    }

    return detail;
  }

  private appendStatus(jobId: string, label: string, text: string) {
    this.options.repository.appendEvent(jobId, {
      channel: "status",
      label,
      text,
    });
  }

  private appendError(jobId: string, label: string, text: string) {
    this.options.repository.appendEvent(jobId, {
      channel: "error",
      label,
      text,
    });
  }

  private buildUsageReporter(jobId: string): ProgressReporter {
    return async (event) => {
      if (event.type === "usage") {
        this.options.repository.addUsage(jobId, event.usage);
      }
    };
  }

  private resolveProvider(kind: SearchProviderKind) {
    const provider = this.options.providers.find((candidate) => candidate.kind === kind);

    if (!provider) {
      throw new Error(`Search provider not configured: ${kind}`);
    }

    return provider;
  }

  private runInBackground(jobId: string, taskFactory: () => Promise<void>) {
    if (this.runningJobs.has(jobId)) {
      return;
    }

    const task = taskFactory().finally(() => {
      if (this.runningJobs.get(jobId) === task) {
        this.runningJobs.delete(jobId);
      }
    });

    this.runningJobs.set(jobId, task);
  }

  private async runDiscovery(jobId: string) {
    const job = this.options.repository.getJob(jobId);

    if (!job) {
      return;
    }

    if (job.status === "ready_to_read" || job.status === "processing" || job.status === "completed") {
      return;
    }

    try {
      this.options.repository.updateJob(jobId, {
        status: "searching",
        phase: "search",
        lastError: null,
        startedAt: job.startedAt ?? new Date().toISOString(),
        finishedAt: null,
      });
      this.appendStatus(jobId, "SEARCH", `Searching ${job.provider} for up to ${job.searchLimit} source URLs.`);

      const provider = this.resolveProvider(job.provider);
      const searchHits = dedupeHits(
        await provider.search({
          query: provider.kind === "web-search-api" ? buildStudySearchQuery(job.query) : job.query,
          limit: job.searchLimit,
          reporter: this.buildUsageReporter(jobId),
        }),
      );

      if (searchHits.length === 0) {
        throw new Error("Search returned zero source URLs.");
      }

      const storedSources = this.options.repository.replaceSources(jobId, searchHits);
      this.options.repository.updateJob(jobId, {
        status: "ready_to_read",
        phase: "read",
        lastError: null,
        finishedAt: null,
      });
      this.appendStatus(
        jobId,
        "SEARCH",
        `Cached ${storedSources.length} sources. You can start reading whenever you want.`,
      );
    } catch (error) {
      const message = toErrorMessage(error);
      this.options.repository.updateJob(jobId, {
        status: "failed",
        phase: "search",
        lastError: message,
        finishedAt: new Date().toISOString(),
      });
      this.appendError(jobId, "SEARCH", message);
    }
  }

  private async runProcessing(jobId: string) {
    const currentJob = this.options.repository.getJob(jobId);

    if (!currentJob) {
      return;
    }

    const reporter = this.buildUsageReporter(jobId);

    try {
      this.options.repository.updateJob(jobId, {
        status: "processing",
        phase: "read",
        lastError: null,
        startedAt: currentJob.startedAt ?? new Date().toISOString(),
        finishedAt: null,
      });
      this.appendStatus(
        jobId,
        "READ",
        `Reading cached sources with concurrency ${currentJob.readConcurrency}. Source-to-question extraction runs through one shared AI lane.`,
      );

      await this.resumeInterruptedSources(jobId);
      await this.processSources(jobId, reporter);
      await this.finalizeCollection(jobId, reporter);
    } catch (error) {
      const message = toErrorMessage(error);
      const job = this.options.repository.getJob(jobId);
      this.options.repository.updateJob(jobId, {
        status: "failed",
        phase: job?.phase ?? "read",
        lastError: message,
        finishedAt: new Date().toISOString(),
      });
      this.appendError(jobId, "PROCESS", message);
    }
  }

  private async resumeInterruptedSources(jobId: string) {
    const sources = this.options.repository.listSources(jobId);

    for (const source of sources) {
      if (source.status === "reading") {
        this.options.repository.updateSource(source.id, {
          status: source.contentCached ? "pending_extract" : "pending_read",
          error: null,
        });
      }

      if (source.status === "extracting") {
        this.options.repository.updateSource(source.id, {
          status: "pending_extract",
          error: null,
        });
      }
    }
  }

  private async processSources(jobId: string, reporter: ProgressReporter) {
    const job = this.requireJob(jobId);
    const queue = new AsyncQueue<QueuedDocument>();
    const sources = this.options.repository.listSources(jobId);
    const preloadedSources = sources.filter((source) => source.status === "pending_extract");
    const cachedSources = sources.filter((source) => {
      if (source.status !== "pending_read" && source.status !== "failed") {
        return false;
      }

      return Boolean(this.options.repository.getSourceCache(source.url)?.content);
    });
    const networkSources = sources.filter((source) => {
      if (source.status !== "pending_read" && source.status !== "failed") {
        return false;
      }

      return !this.options.repository.getSourceCache(source.url)?.content;
    });

    for (const source of [...preloadedSources, ...cachedSources]) {
      await this.enqueueCachedSource(jobId, source, queue);
    }

    const aiWorker = this.consumeQueuedDocuments(jobId, queue, reporter);

    await runWithConcurrency(networkSources, job.readConcurrency, async (source) => {
      await this.readSource(jobId, source, queue);
    });

    queue.close();
    await aiWorker;
  }

  private async enqueueCachedSource(jobId: string, source: CaptureSource, queue: AsyncQueue<QueuedDocument>) {
    const cache = this.options.repository.getSourceCache(source.url);

    if (!cache?.content) {
      return;
    }

    const updatedSource = this.options.repository.updateSource(source.id, {
      status: "pending_extract",
      contentCached: true,
      fetchedAt: cache.fetchedAt,
      error: null,
    });

    this.appendStatus(jobId, "CACHE", `Reused cached content for ${updatedSource.title}.`);
    queue.push({
      source: updatedSource,
      document: {
        url: updatedSource.url,
        title: cache.title || updatedSource.title,
        snippet: cache.snippet || updatedSource.snippet,
        content: cache.content,
      },
    });
  }

  private async readSource(jobId: string, source: CaptureSource, queue: AsyncQueue<QueuedDocument>) {
    this.options.repository.updateSource(source.id, {
      status: "reading",
      error: null,
    });
    this.appendStatus(jobId, "READ", `Fetching ${source.title}.`);

    try {
      const document = await this.options.sourceReader.read({
        url: source.url,
        title: source.title,
        snippet: source.snippet,
      });
      const fetchedAt = new Date().toISOString();

      this.options.repository.upsertSourceCache({
        url: source.url,
        title: document.title,
        snippet: source.snippet,
        content: document.content,
        fetchedAt,
        error: null,
      });

      const updatedSource = this.options.repository.updateSource(source.id, {
        status: "pending_extract",
        contentCached: true,
        fetchedAt,
        error: null,
      });

      this.appendStatus(jobId, "READ", `Cached source content for ${updatedSource.title}.`);
      queue.push({
        source: updatedSource,
        document,
      });
    } catch (error) {
      const message = toErrorMessage(error);
      this.options.repository.updateSource(source.id, {
        status: "failed",
        error: message,
      });
      this.options.repository.upsertSourceCache({
        url: source.url,
        title: source.title,
        snippet: source.snippet,
        content: null,
        fetchedAt: null,
        error: message,
      });
      this.appendError(jobId, "READ", `${source.title}: ${message}`);
    }
  }

  private async consumeQueuedDocuments(jobId: string, queue: AsyncQueue<QueuedDocument>, reporter: ProgressReporter) {
    while (true) {
      const item = await queue.next();

      if (!item) {
        break;
      }

      this.appendStatus(jobId, "QUESTION", `${item.source.title}: waiting for the shared AI extraction lane.`);

      await this.extractionMutex.runExclusive(async () => {
        const source = this.options.repository.updateSource(item.source.id, {
          status: "extracting",
          error: null,
        });
        this.appendStatus(jobId, "QUESTION", `Extracting study questions from ${source.title}.`);

        try {
          const drafts = await this.options.truthExtractor.extract({
            query: this.requireJob(jobId).query,
            documents: [item.document],
            reporter,
          });

          this.options.repository.replaceSourceTruthDrafts(jobId, source.url, drafts);
          this.options.repository.updateSource(source.id, {
            status: "completed",
            truthDraftCount: drafts.length,
            extractedAt: new Date().toISOString(),
            error: null,
          });
          this.appendStatus(jobId, "QUESTION", `${source.title}: extracted ${drafts.length} study-question drafts.`);
        } catch (error) {
          const message = toErrorMessage(error);
          this.options.repository.updateSource(source.id, {
            status: "failed",
            truthDraftCount: 0,
            error: message,
          });
          this.appendError(jobId, "QUESTION", `${source.title}: ${message}`);
        }
      });
    }
  }

  private async finalizeCollection(jobId: string, reporter: ProgressReporter) {
    const job = this.requireJob(jobId);
    const drafts = deduplicateTruths(
      this.options.repository.listTruthDrafts(jobId).map((draft) => ({
        sourceId: draft.sourceId,
        statement: draft.statement,
        summary: draft.summary,
        questionType: draft.questionType,
        options: draft.options,
        answer: draft.answer,
        explanation: draft.explanation,
        evidenceQuote: draft.evidenceQuote,
        confidence: draft.confidence,
      })),
    );

    if (drafts.length === 0) {
      throw new Error("No study-question drafts were extracted from cached sources.");
    }

    this.options.repository.updateJob(jobId, {
      phase: "taxonomy",
    });
    this.appendStatus(jobId, "TAXONOMY", "Planning taxonomy from extracted study questions.");

    const existingTaxonomy = this.options.knowledgeStore.getTaxonomy();
    const plannedTaxonomy = await this.options.taxonomyPlanner.plan({
      query: job.query,
      existingNodes: existingTaxonomy,
      reporter,
    });
    const taxonomy = mergeTaxonomy(existingTaxonomy, plannedTaxonomy);

    this.options.repository.updateJob(jobId, {
      phase: "classify",
    });
    this.appendStatus(jobId, "CLASSIFY", `Classifying ${drafts.length} study questions into taxonomy paths.`);
    const tagAssignments = await this.options.tagClassifier.classify({
      truths: drafts,
      taxonomy,
      reporter,
    });

    this.options.repository.updateJob(jobId, {
      phase: "embed",
    });
    this.appendStatus(jobId, "EMBED", `Embedding ${drafts.length} study questions for semantic search.`);
    const embeddings = await this.options.embedder.embed({
      texts: drafts.map(describeStudyCard),
    });

    this.options.repository.updateJob(jobId, {
      phase: "persist",
    });
    this.appendStatus(jobId, "PERSIST", "Saving study questions into the knowledge store.");

    const truths: CollectedTruth[] = drafts.map((truth, index) => ({
      id: crypto.randomUUID(),
      statement: truth.statement,
      summary: truth.summary,
      questionType: truth.questionType,
      options: truth.options,
      answer: truth.answer,
      explanation: truth.explanation,
      evidenceQuote: truth.evidenceQuote,
      confidence: truth.confidence,
      sourceUrl: truth.sourceId,
      level1TagId: tagAssignments[index]!.level1TagId,
      level2TagId: tagAssignments[index]!.level2TagId,
      level3TagId: tagAssignments[index]!.level3TagId,
      embedding: embeddings[index],
    }));

    const saved = this.options.knowledgeStore.saveCollection({
      collectionId: crypto.randomUUID(),
      query: job.query,
      provider: job.provider,
      truthCount: truths.length,
      sourceCount: this.requireJob(jobId).completedSourceCount,
      taxonomy: plannedTaxonomy,
      truths,
    });

    this.options.repository.updateJob(jobId, {
      status: "completed",
      phase: "persist",
      truthCount: saved.truthCount,
      taxonomyCount: saved.taxonomy.length,
      collectionId: saved.collectionId,
      lastError: null,
      finishedAt: new Date().toISOString(),
    });
    this.appendStatus(
      jobId,
      "DONE",
      `Saved ${saved.truthCount} study questions from ${saved.sourceCount} sources into collection ${saved.collectionId}.`,
    );
  }

  private requireJob(jobId: string) {
    const job = this.options.repository.getJob(jobId);

    if (!job) {
      throw new Error(`Capture job not found: ${jobId}`);
    }

    return job;
  }
}
