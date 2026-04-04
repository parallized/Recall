import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { deduplicateTruths, type CollectedTruth, type SearchProviderKind, type TaxonomyNode, type TruthDraft } from "@recall/domain";

import type { CaptureJobRepository } from "../db/capture-jobs";
import type { KnowledgeStore } from "../db";
import type {
  CaptureActiveOperation,
  CaptureFailureKind,
  CaptureJob,
  CaptureJobDetail,
  CapturePendingItem,
  CapturePendingItemStatus,
  CaptureSource,
  CreateCaptureJobInput,
  QueuedDocument,
  StartCaptureProcessingInput,
  StoredTruthDraft,
} from "./capture-types";
import type {
  EmbeddingService,
  ProgressReporter,
  SearchProvider,
  SourceContentReader,
  TaxonomyPlanner,
  TruthExtractor,
} from "./types";
import { normalizeTruthClassificationResult, type HybridHierarchicalTagClassifier } from "./pipeline";
import { describePreferredOutputLanguage } from "./output-language";
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
  retryPolicy?: Partial<CaptureJobRetryPolicy>;
};

type CaptureJobRetryPolicy = {
  maxReadAttempts: number;
  maxExtractAttempts: number;
  baseDelayMs: number;
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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
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
const truthIdentityKey = (truth: Pick<TruthDraft, "sourceId" | "statement" | "evidenceQuote">) =>
  `${truth.sourceId}::${truth.statement}::${truth.evidenceQuote}`;
const sensitiveWordsMarker = "sensitive_words_detected";
const jinaReader451Pattern = /jina reader failed .* status 451/i;
const logDirectoryPattern = /See logs at (.+?)(?:\.\s*|$)/i;

const defaultRetryPolicy: CaptureJobRetryPolicy = {
  maxReadAttempts: 3,
  maxExtractAttempts: 3,
  baseDelayMs: 3_000,
};

const extractLogDirectoryFromMessage = (message: string | null) => {
  if (!message) {
    return null;
  }

  const match = message.match(logDirectoryPattern);
  return match?.[1] ?? null;
};

const readLoggedOutput = (directory: string | null) => {
  if (!directory) {
    return null;
  }

  const outputPath = join(directory, "output.txt");

  if (!existsSync(outputPath)) {
    return null;
  }

  try {
    return readFileSync(outputPath, "utf8");
  } catch {
    return null;
  }
};

const readLoggedInput = (directory: string | null) => {
  if (!directory) {
    return null;
  }

  const inputPath = join(directory, "input.json");

  if (!existsSync(inputPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(inputPath, "utf8")) as {
      schemaName?: string;
      request?: {
        messages?: Array<{
          role?: string;
          content?: string;
        }>;
      };
    };
  } catch {
    return null;
  }
};

const extractFailedTruthStatementFromMessage = (message: string | null) => {
  const input = readLoggedInput(extractLogDirectoryFromMessage(message));
  const content = input?.request?.messages?.find((entry) => entry.role === "user")?.content;

  if (!content) {
    return null;
  }

  const match = content.match(/Question stem:\s*([\s\S]*?)\n\nShort answer:/);
  return match?.[1]?.trim() ?? null;
};

const isSensitiveFailureMessage = (message: string | null) => {
  if (!message) {
    return false;
  }

  const lowered = message.toLowerCase();

  if (lowered.includes(sensitiveWordsMarker)) {
    return true;
  }

  const output = readLoggedOutput(extractLogDirectoryFromMessage(message));
  return output?.toLowerCase().includes(sensitiveWordsMarker) ?? false;
};

const isJinaReader451FailureMessage = (message: string | null) =>
  typeof message === "string" && jinaReader451Pattern.test(message);

const normalizeFailureMessage = (message: string | null): {
  failureKind: CaptureFailureKind | null;
  failureLabel: string | null;
} => {
  if (!message) {
    return {
      failureKind: null,
      failureLabel: null,
    };
  }

  if (isSensitiveFailureMessage(message)) {
    return {
      failureKind: "sensitive_content",
      failureLabel: "包含敏感内容",
    };
  }

  if (isJinaReader451FailureMessage(message)) {
    return {
      failureKind: "jina_reader",
      failureLabel: "Jina 阅读错误",
    };
  }

  return {
    failureKind: "generic",
    failureLabel: message,
  };
};

const sourcePendingStatus = (source: CaptureSource): CapturePendingItemStatus | null => {
  switch (source.status) {
    case "pending_read":
      return "waiting_to_read";
    case "reading":
      return "reading_source";
    case "pending_extract":
      return "waiting_to_extract";
    case "extracting":
      return "extracting_questions";
    case "failed":
      return source.contentCached ? "failed_extract" : "failed_read";
    case "completed":
      return null;
  }
};

const truthPendingStatus = (job: CaptureJob): CapturePendingItemStatus => {
  if (job.status === "failed") {
    return "blocked_after_failure";
  }

  switch (job.phase) {
    case "taxonomy":
      return "waiting_for_classify";
    case "classify":
      return "waiting_for_classify";
    case "embed":
      return "classified_waiting_for_embed";
    case "persist":
      return "embedded_waiting_for_persist";
    case "idle":
    case "search":
    case "read":
    case "truths":
    default:
      return "waiting_for_finalize";
  }
};

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
  private readonly retryPolicy: CaptureJobRetryPolicy;
  private readonly activeOperations = new Map<string, CaptureActiveOperation>();

  constructor(private readonly options: CaptureJobServiceDependencies) {
    this.retryPolicy = {
      ...defaultRetryPolicy,
      ...options.retryPolicy,
    };
  }

  listJobs() {
    return this.options.repository.listJobs();
  }

  getJobDetail(jobId: string) {
    const detail = this.options.repository.getJobDetail(jobId);

    if (!detail) {
      return null;
    }

    const presentedSources = detail.sources.map((source) => this.presentSource(source));

    return {
      ...detail,
      sources: presentedSources,
      pendingItems: this.buildPendingItems(detail.job, detail.sources),
      activeOperation: this.buildActiveOperation(detail.job, detail.sources),
    };
  }

  async createJob(input: CreateCaptureJobInput) {
    const job = this.options.repository.createJob(input);
    this.options.repository.appendEvent(job.id, {
      channel: "status",
      label: "QUEUED",
      text: `Queued source discovery for "${job.query}" with output language ${describePreferredOutputLanguage(job.preferredOutputLanguage)}.`,
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
    const detail = this.getJobDetail(jobId);

    if (!detail) {
      throw new Error(`Capture job not found: ${jobId}`);
    }

    return detail;
  }

  private hasExhaustedRetries(source: CaptureSource) {
    if (source.status !== "failed") {
      return false;
    }

    if (source.contentCached) {
      return source.extractAttemptCount >= this.retryPolicy.maxExtractAttempts;
    }

    return source.readAttemptCount >= this.retryPolicy.maxReadAttempts;
  }

  private presentFailure(message: string | null, skipped = false, attemptCount = 3) {
    const normalized = normalizeFailureMessage(message);

    if (!normalized.failureLabel) {
      return {
        error: null,
        failureKind: normalized.failureKind,
        failureLabel: null,
        skipped,
      };
    }

    return {
      error: skipped ? `${normalized.failureLabel}（已重试 ${attemptCount} 次，已跳过）` : normalized.failureLabel,
      failureKind: normalized.failureKind,
      failureLabel: normalized.failureLabel,
      skipped,
    };
  }

  private presentSource(source: CaptureSource): CaptureSource {
    const attemptCount = source.contentCached ? source.extractAttemptCount : source.readAttemptCount;
    const presentedFailure = this.presentFailure(source.error, this.hasExhaustedRetries(source), attemptCount);

    return {
      ...source,
      error: presentedFailure.error,
      failureKind: presentedFailure.failureKind,
      failureLabel: presentedFailure.failureLabel,
      skipped: presentedFailure.skipped,
    };
  }

  private setActiveOperation(jobId: string, operation: CaptureActiveOperation | null) {
    if (operation) {
      this.activeOperations.set(jobId, operation);
      return;
    }

    this.activeOperations.delete(jobId);
  }

  private buildActiveOperation(job: CaptureJob, sources: CaptureSource[]) {
    const active = this.activeOperations.get(job.id);

    if (active) {
      return active;
    }

    const sourceByUrl = new Map(sources.map((source) => [source.url, source]));
    const drafts = deduplicateTruths(this.options.repository.listTruthDrafts(job.id)) as StoredTruthDraft[];

    if (job.status === "queued_search" || job.status === "searching") {
      return {
        itemId: null,
        kind: "job",
        status: "discovering_sources",
        title: job.query,
        subtitle: job.provider,
        detail: `正在从 ${job.provider} 检索信源`,
        progressCurrent: null,
        progressTotal: null,
        startedAt: job.updatedAt,
      } satisfies CaptureActiveOperation;
    }

    const extractingSource = sources.find((source) => source.status === "extracting");

    if (extractingSource) {
      return {
        itemId: extractingSource.id,
        kind: "source",
        status: "extracting_questions",
        title: extractingSource.title || extractingSource.url,
        subtitle: extractingSource.url,
        detail: "AI 正在从这个信源抽取题目卡片",
        progressCurrent: null,
        progressTotal: null,
        startedAt: extractingSource.lastExtractAttemptAt ?? job.updatedAt,
      } satisfies CaptureActiveOperation;
    }

    if (job.status === "processing" && job.phase === "taxonomy") {
      return {
        itemId: null,
        kind: "job",
        status: "planning_taxonomy",
        title: job.query,
        subtitle: `${job.truthDraftCount} 张待处理卡片`,
        detail: "AI 正在规划这一批题目的分类树",
        progressCurrent: null,
        progressTotal: null,
        startedAt: job.updatedAt,
      } satisfies CaptureActiveOperation;
    }

    if (job.status === "processing" && job.phase === "classify" && drafts.length > 0) {
      const draft = drafts[0]!;
      const source = sourceByUrl.get(draft.sourceId);

      return {
        itemId: draft.id,
        kind: "truth",
        status: "classifying_question",
        title: draft.statement,
        subtitle: source?.title ?? draft.sourceId,
        detail: "AI 正在为这张卡片挑选最终分类路径",
        progressCurrent: null,
        progressTotal: drafts.length,
        startedAt: job.updatedAt,
      } satisfies CaptureActiveOperation;
    }

    if (job.status === "failed" && job.phase === "classify" && drafts.length > 0) {
      const failedStatement = extractFailedTruthStatementFromMessage(job.lastError);
      const failedDraft = drafts.find((draft) => draft.statement === failedStatement) ?? drafts[0]!;
      const source = sourceByUrl.get(failedDraft.sourceId);

      return {
        itemId: failedDraft.id,
        kind: "truth",
        status: "blocked_after_failure",
        title: failedDraft.statement,
        subtitle: source?.title ?? failedDraft.sourceId,
        detail: "上一条 AI 绑定请求在这张卡片上失败，当前队列已暂停。",
        progressCurrent: null,
        progressTotal: drafts.length,
        startedAt: job.updatedAt,
      } satisfies CaptureActiveOperation;
    }

    if (job.status === "processing" && job.phase === "embed") {
      return {
        itemId: null,
        kind: "job",
        status: "embedding_question",
        title: job.query,
        subtitle: `${job.truthDraftCount} 张卡片`,
        detail: "AI 已完成，正在做本地向量化",
        progressCurrent: null,
        progressTotal: null,
        startedAt: job.updatedAt,
      } satisfies CaptureActiveOperation;
    }

    if (job.status === "processing" && job.phase === "persist") {
      return {
        itemId: null,
        kind: "job",
        status: "persisting_question",
        title: job.query,
        subtitle: `${job.truthDraftCount} 张卡片`,
        detail: "正在把这批题目正式写入 repository",
        progressCurrent: null,
        progressTotal: null,
        startedAt: job.updatedAt,
      } satisfies CaptureActiveOperation;
    }

    return null;
  }

  private buildPendingItems(job: CaptureJob, sources: CaptureSource[]): CapturePendingItem[] {
    const pendingItems: CapturePendingItem[] = [];

    if (job.status === "queued_search" || job.status === "searching") {
      pendingItems.push({
        id: `${job.id}:discovering`,
        kind: "source",
        position: -1,
        title: job.query,
        subtitle: "正在检索可读信源",
        status: "discovering_sources",
        sourceUrl: null,
        sourceTitle: null,
        error: null,
      });
    }

    const sourceByUrl = new Map(sources.map((source) => [source.url, source]));
    const activeOperation = this.buildActiveOperation(job, sources);

    for (const source of sources) {
      const status = sourcePendingStatus(source);

      if (!status) {
        continue;
      }

      const presentedSource = this.presentSource(source);

      pendingItems.push({
        id: source.id,
        kind: "source",
        position: source.position,
        title: source.title || source.url,
        subtitle: source.url,
        status,
        sourceUrl: source.url,
        sourceTitle: source.title,
        error: presentedSource.error,
        failureKind: presentedSource.failureKind ?? null,
        failureLabel: presentedSource.failureLabel ?? null,
        skipped: presentedSource.skipped,
      });
    }

    if (job.collectionId) {
      return pendingItems;
    }

    const drafts = deduplicateTruths(this.options.repository.listTruthDrafts(job.id)) as StoredTruthDraft[];
    const draftStatus = truthPendingStatus(job);

    drafts.forEach((draft, index) => {
      const source = sourceByUrl.get(draft.sourceId);
      const sourcePosition = source?.position ?? 10_000;
      const isActiveTruth =
        activeOperation?.kind === "truth" &&
        activeOperation.itemId === draft.id &&
        activeOperation.status === "classifying_question";
      let status = draftStatus;

      if (job.phase === "taxonomy" && job.status === "processing") {
        status = "waiting_for_classify";
      }

      if (job.phase === "classify" && job.status === "processing") {
        if (activeOperation?.kind === "truth" && activeOperation.status === "classifying_question") {
          if (isActiveTruth) {
            status = "classifying_question";
          } else if (
            activeOperation.progressCurrent &&
            activeOperation.progressTotal &&
            index < activeOperation.progressCurrent - 1
          ) {
            status = "classified_waiting_for_embed";
          } else {
            status = "waiting_for_classify";
          }
        } else {
          status = "waiting_for_classify";
        }
      }

      if (job.phase === "embed" && job.status === "processing") {
        status = "classified_waiting_for_embed";
      }

      if (job.phase === "persist" && job.status === "processing") {
        status = "embedded_waiting_for_persist";
      }

      pendingItems.push({
        id: draft.id,
        kind: "truth",
        position: sourcePosition * 1_000 + index,
        title: draft.statement,
        subtitle: source?.title || draft.sourceId,
        status,
        sourceUrl: draft.sourceId,
        sourceTitle: source?.title ?? null,
        ...this.presentFailure(job.status === "failed" && activeOperation?.itemId === draft.id ? job.lastError : null),
      });
    });

    return pendingItems.sort((left, right) => left.position - right.position);
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

  private isRetryReady(source: CaptureSource) {
    return !source.nextRetryAt || Date.parse(source.nextRetryAt) <= Date.now();
  }

  private getRetryDelayMs(attemptCount: number) {
    return this.retryPolicy.baseDelayMs * 2 ** Math.max(0, attemptCount - 1);
  }

  private formatRetryDelay(delayMs: number) {
    if (delayMs < 1_000) {
      return `${delayMs}ms`;
    }

    const seconds = delayMs / 1_000;
    return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
  }

  private getQueueTailPosition(jobId: string) {
    return this.options.repository.listSources(jobId).reduce((max, source) => Math.max(max, source.position), -1) + 1;
  }

  private getNextRetryWaitMs(sources: CaptureSource[]) {
    const waits = sources
      .filter((source) => source.status === "pending_read" || source.status === "pending_extract")
      .map((source) => (source.nextRetryAt ? Date.parse(source.nextRetryAt) - Date.now() : 0))
      .filter((delayMs) => delayMs > 0);

    if (waits.length === 0) {
      return null;
    }

    return Math.min(...waits);
  }

  private async scheduleRetry(input: {
    jobId: string;
    source: CaptureSource;
    stage: "read" | "extract";
    attemptCount: number;
    error: string;
  }) {
    const maxAttempts =
      input.stage === "read" ? this.retryPolicy.maxReadAttempts : this.retryPolicy.maxExtractAttempts;
    const presentedFailure = this.presentFailure(input.error, input.attemptCount >= maxAttempts, input.attemptCount);

    if (input.attemptCount >= maxAttempts) {
      this.options.repository.updateSource(input.source.id, {
        status: "failed",
        nextRetryAt: null,
        truthDraftCount: input.stage === "extract" ? 0 : input.source.truthDraftCount,
        error: input.error,
      });
      this.appendError(
        input.jobId,
        "RETRY",
        `${input.source.title}: ${input.stage} failed after ${input.attemptCount} attempts. ${presentedFailure.error ?? input.error}`,
      );
      return;
    }

    const delayMs = this.getRetryDelayMs(input.attemptCount);
    const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
    const nextStatus = input.stage === "read" ? "pending_read" : "pending_extract";
    const queueTail = this.getQueueTailPosition(input.jobId);

    this.options.repository.updateSource(input.source.id, {
      position: queueTail,
      status: nextStatus,
      nextRetryAt,
      truthDraftCount: input.stage === "extract" ? 0 : input.source.truthDraftCount,
      error: input.error,
    });
    this.appendStatus(
      input.jobId,
      "RETRY",
      `${input.source.title}: ${input.stage} failed (${input.attemptCount}/${maxAttempts}). ${presentedFailure.failureLabel ?? input.error} Re-queued to the end of the queue; retry in ${this.formatRetryDelay(delayMs)}.`,
    );
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
      this.setActiveOperation(jobId, {
        itemId: null,
        kind: "job",
        status: "discovering_sources",
        title: job.query,
        subtitle: job.provider,
        detail: `正在从 ${job.provider} 检索最多 ${job.searchLimit} 个信源`,
        progressCurrent: null,
        progressTotal: null,
        startedAt: new Date().toISOString(),
      });

      const provider = this.resolveProvider(job.provider);
      const searchHits = dedupeHits(
        await provider.search({
          query:
            provider.kind === "web-search-api"
              ? buildStudySearchQuery(job.query, job.preferredOutputLanguage)
              : job.query,
          limit: job.searchLimit,
          preferredOutputLanguage: job.preferredOutputLanguage,
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
    } finally {
      this.setActiveOperation(jobId, null);
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
      const activeOperation = this.activeOperations.get(jobId);

      if (activeOperation) {
        this.setActiveOperation(jobId, {
          ...activeOperation,
          status: "blocked_after_failure",
          detail: "上一条 AI 操作在这里失败，当前队列已暂停。",
        });
      }

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
    let recoveredCount = 0;

    for (const source of sources) {
      if (source.status === "reading") {
        this.options.repository.updateSource(source.id, {
          status: source.contentCached ? "pending_extract" : "pending_read",
          nextRetryAt: null,
          error: null,
        });
        recoveredCount += 1;
      }

      if (source.status === "extracting") {
        this.options.repository.updateSource(source.id, {
          status: "pending_extract",
          nextRetryAt: null,
          error: null,
        });
        recoveredCount += 1;
      }

      if (
        source.status === "failed" &&
        !source.contentCached &&
        source.readAttemptCount < this.retryPolicy.maxReadAttempts
      ) {
        this.options.repository.updateSource(source.id, {
          status: "pending_read",
          nextRetryAt: null,
        });
        recoveredCount += 1;
      }

      if (
        source.status === "failed" &&
        source.contentCached &&
        source.extractAttemptCount < this.retryPolicy.maxExtractAttempts
      ) {
        this.options.repository.updateSource(source.id, {
          status: "pending_extract",
          nextRetryAt: null,
        });
        recoveredCount += 1;
      }
    }

    if (recoveredCount > 0) {
      this.appendStatus(jobId, "RECOVER", `Recovered ${recoveredCount} unfinished or retryable sources after restart.`);
    }
  }

  private async processSources(jobId: string, reporter: ProgressReporter) {
    const job = this.requireJob(jobId);
    while (true) {
      const queue = new AsyncQueue<QueuedDocument>();
      const sources = this.options.repository.listSources(jobId);
      const preloadedSources = sources.filter(
        (source) => source.status === "pending_extract" && this.isRetryReady(source),
      );
      const cachedSources = sources.filter((source) => {
        if (source.status !== "pending_read" || !this.isRetryReady(source)) {
          return false;
        }

        return Boolean(this.options.repository.getSourceCache(source.url)?.content);
      });
      const networkSources = sources.filter((source) => {
        if (source.status !== "pending_read" || !this.isRetryReady(source)) {
          return false;
        }

        return !this.options.repository.getSourceCache(source.url)?.content;
      });

      if (preloadedSources.length === 0 && cachedSources.length === 0 && networkSources.length === 0) {
        const hasPendingSources = sources.some(
          (source) => source.status === "pending_read" || source.status === "pending_extract",
        );

        if (!hasPendingSources) {
          break;
        }

        const waitMs = this.getNextRetryWaitMs(sources);

        if (waitMs === null) {
          break;
        }

        this.appendStatus(
          jobId,
          "RETRY",
          `Waiting ${this.formatRetryDelay(waitMs)} before retrying deferred sources.`,
        );
        await sleep(waitMs);
        continue;
      }

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
  }

  private async enqueueCachedSource(jobId: string, source: CaptureSource, queue: AsyncQueue<QueuedDocument>) {
    const cache = this.options.repository.getSourceCache(source.url);

    if (!cache?.content) {
      return;
    }

    const updatedSource = this.options.repository.updateSource(source.id, {
      status: "pending_extract",
      contentCached: true,
      nextRetryAt: null,
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
    const startedAt = new Date().toISOString();
    this.options.repository.updateSource(source.id, {
      status: "reading",
      readAttemptCount: source.readAttemptCount + 1,
      lastReadAttemptAt: startedAt,
      nextRetryAt: null,
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
        nextRetryAt: null,
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
      this.options.repository.upsertSourceCache({
        url: source.url,
        title: source.title,
        snippet: source.snippet,
        content: null,
        fetchedAt: null,
        error: message,
      });
      await this.scheduleRetry({
        jobId,
        source: {
          ...source,
          readAttemptCount: source.readAttemptCount + 1,
        },
        stage: "read",
        attemptCount: source.readAttemptCount + 1,
        error: message,
      });
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
        const startedAt = new Date().toISOString();
        const source = this.options.repository.updateSource(item.source.id, {
          status: "extracting",
          extractAttemptCount: item.source.extractAttemptCount + 1,
          lastExtractAttemptAt: startedAt,
          nextRetryAt: null,
          error: null,
        });
        this.appendStatus(jobId, "QUESTION", `Extracting study questions from ${source.title}.`);
        this.setActiveOperation(jobId, {
          itemId: source.id,
          kind: "source",
          status: "extracting_questions",
          title: source.title || source.url,
          subtitle: source.url,
          detail: "AI 正在从这个信源抽取题目卡片",
          progressCurrent: null,
          progressTotal: null,
          startedAt,
        });

        try {
          const drafts = await this.options.truthExtractor.extract({
            query: this.requireJob(jobId).query,
            documents: [item.document],
            preferredOutputLanguage: this.requireJob(jobId).preferredOutputLanguage,
            reporter,
          });

          this.options.repository.replaceSourceTruthDrafts(jobId, source.url, drafts);
          this.options.repository.updateSource(source.id, {
            status: "completed",
            truthDraftCount: drafts.length,
            nextRetryAt: null,
            extractedAt: new Date().toISOString(),
            error: null,
          });
          this.appendStatus(jobId, "QUESTION", `${source.title}: extracted ${drafts.length} study-question drafts.`);
        } catch (error) {
          const message = toErrorMessage(error);
          await this.scheduleRetry({
            jobId,
            source,
            stage: "extract",
            attemptCount: source.extractAttemptCount,
            error: message,
          });
        } finally {
          this.setActiveOperation(jobId, null);
        }
      });
    }
  }

  private async finalizeCollection(jobId: string, reporter: ProgressReporter) {
    const job = this.requireJob(jobId);
    const storedDrafts = deduplicateTruths(this.options.repository.listTruthDrafts(jobId)) as StoredTruthDraft[];
    const drafts = storedDrafts.map((draft) => ({
      sourceId: draft.sourceId,
      statement: draft.statement,
      summary: draft.summary,
      questionType: draft.questionType,
      options: draft.options,
      answer: draft.answer,
      explanation: draft.explanation,
      evidenceQuote: draft.evidenceQuote,
      confidence: draft.confidence,
    }));
    const sourceByUrl = new Map(this.options.repository.listSources(jobId).map((source) => [source.url, source]));
    const draftIdByTruthKey = new Map(storedDrafts.map((draft) => [truthIdentityKey(draft), draft.id]));

    if (drafts.length === 0) {
      throw new Error("No study-question drafts were extracted from cached sources.");
    }

    this.options.repository.updateJob(jobId, {
      phase: "taxonomy",
    });
    this.appendStatus(jobId, "TAXONOMY", "Planning taxonomy from extracted study questions.");
    this.setActiveOperation(jobId, {
      itemId: null,
      kind: "job",
      status: "planning_taxonomy",
      title: job.query,
      subtitle: `${drafts.length} 张待分类卡片`,
      detail: "AI 正在规划这批题目的分类树",
      progressCurrent: null,
      progressTotal: null,
      startedAt: new Date().toISOString(),
    });

    const existingTaxonomy = this.options.knowledgeStore.getTaxonomy();
    const plannedTaxonomy = await this.options.taxonomyPlanner.plan({
      query: job.query,
      existingNodes: existingTaxonomy,
      preferredOutputLanguage: job.preferredOutputLanguage,
      reporter,
    });
    const taxonomy = mergeTaxonomy(existingTaxonomy, plannedTaxonomy);

    this.options.repository.updateJob(jobId, {
      phase: "classify",
    });
    this.appendStatus(jobId, "CLASSIFY", `Classifying ${drafts.length} study questions into taxonomy paths.`);
    const classification = normalizeTruthClassificationResult(
      drafts,
      await this.options.tagClassifier.classify({
        truths: drafts,
        taxonomy,
        preferredOutputLanguage: job.preferredOutputLanguage,
        reporter,
        onTruthStart: async ({ truth, index, total }) => {
          const source = sourceByUrl.get(truth.sourceId);
          const itemId = draftIdByTruthKey.get(truthIdentityKey(truth)) ?? null;
          this.setActiveOperation(jobId, {
            itemId,
            kind: "truth",
            status: "classifying_question",
            title: truth.statement,
            subtitle: source?.title ?? truth.sourceId,
            detail: "AI 正在为这张卡片挑选最终分类路径",
            progressCurrent: index + 1,
            progressTotal: total,
            startedAt: new Date().toISOString(),
          });
        },
      }),
    );

    if (classification.truths.length === 0) {
      throw new Error("All study-question drafts were stripped during taxonomy classification.");
    }

    if (classification.strippedTruthCount > 0) {
      this.appendStatus(
        jobId,
        "CLASSIFY",
        `Stripped ${classification.strippedTruthCount} moderated study questions during taxonomy binding.`,
      );
    }

    this.options.repository.updateJob(jobId, {
      phase: "embed",
    });
    this.appendStatus(jobId, "EMBED", `Embedding ${classification.truths.length} study questions for semantic search.`);
    this.setActiveOperation(jobId, {
      itemId: null,
      kind: "job",
      status: "embedding_question",
      title: job.query,
      subtitle: `${classification.truths.length} 张已分类卡片`,
      detail: "AI 已完成，正在做本地向量化",
      progressCurrent: null,
      progressTotal: null,
      startedAt: new Date().toISOString(),
    });
    const embeddings = await this.options.embedder.embed({
      texts: classification.truths.map(describeStudyCard),
    });

    this.options.repository.updateJob(jobId, {
      phase: "persist",
    });
    this.appendStatus(jobId, "PERSIST", "Saving study questions into the knowledge store.");
    this.setActiveOperation(jobId, {
      itemId: null,
      kind: "job",
      status: "persisting_question",
      title: job.query,
      subtitle: `${classification.truths.length} 张卡片准备入库`,
      detail: "正在把这批题目正式写入 repository",
      progressCurrent: null,
      progressTotal: null,
      startedAt: new Date().toISOString(),
    });

    const truths: CollectedTruth[] = classification.truths.map((truth, index) => ({
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
      level1TagId: classification.assignments[index]!.level1TagId,
      level2TagId: classification.assignments[index]!.level2TagId,
      level3TagId: classification.assignments[index]!.level3TagId,
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
    this.setActiveOperation(jobId, null);
  }

  private requireJob(jobId: string) {
    const job = this.options.repository.getJob(jobId);

    if (!job) {
      throw new Error(`Capture job not found: ${jobId}`);
    }

    return job;
  }
}
