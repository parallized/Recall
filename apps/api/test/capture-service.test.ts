import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import type { TruthDraft } from "@recall/domain";

import { createSqliteCaptureJobRepository } from "../src/db/capture-jobs";
import { createSqlitePersistence } from "../src/db";
import { PersistentCaptureJobService } from "../src/runtime/capture-service";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async <T>(read: () => T | null | undefined, predicate: (value: T) => boolean, timeoutMs = 4000) => {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const value = read();

    if (value && predicate(value)) {
      return value;
    }

    await sleep(20);
  }

  throw new Error("Timed out waiting for capture job state.");
};

describe("capture-job-service", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map(async (directory) => {
        try {
          await rm(directory, {
            recursive: true,
            force: true,
          });
        } catch {
          // SQLite keeps the file handle open for the process lifetime in these tests.
        }
      }),
    );
  });

  test("persists discovered sources, processes them with bounded concurrency, and reuses cached Jina content", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "recall-capture-service-"));
    const databasePath = join(tempDirectory, "recall.sqlite");
    temporaryDirectories.push(tempDirectory);

    const repository = createSqliteCaptureJobRepository(databasePath);
    const knowledgeStore = createSqlitePersistence(databasePath);
    const searchHits = [
      { title: "Frontend Guide", url: "https://example.com/frontend-guide", snippet: "Guide snippet" },
      { title: "CSS Layout", url: "https://example.com/css-layout", snippet: "Layout snippet" },
      { title: "JS Runtime", url: "https://example.com/js-runtime", snippet: "Runtime snippet" },
    ];
    let readerCalls = 0;
    let activeReads = 0;
    let maxActiveReads = 0;
    let activeExtractions = 0;
    let maxActiveExtractions = 0;

    const service = new PersistentCaptureJobService({
      repository,
      knowledgeStore,
      providers: [
        {
          kind: "grok-search",
          async search() {
            return searchHits;
          },
        },
      ],
      sourceReader: {
        async read(hit) {
          readerCalls += 1;
          activeReads += 1;
          maxActiveReads = Math.max(maxActiveReads, activeReads);
          await sleep(25);
          activeReads -= 1;

          return {
            ...hit,
            content: `Article body for ${hit.title}`,
          };
        },
      },
      taxonomyPlanner: {
        async plan() {
          return [
            {
              id: "frontend",
              parentId: null,
              level: 1,
              name: "Frontend",
              description: "Frontend knowledge.",
            },
            {
              id: "frontend.web",
              parentId: "frontend",
              level: 2,
              name: "Web",
              description: "Browser and document work.",
            },
            {
              id: "frontend.web.basics",
              parentId: "frontend.web",
              level: 3,
              name: "Basics",
              description: "Core frontend fundamentals.",
            },
          ];
        },
      },
      truthExtractor: {
        async extract(input) {
          const document = input.documents[0]!;
          activeExtractions += 1;
          maxActiveExtractions = Math.max(maxActiveExtractions, activeExtractions);
          await sleep(15);
          activeExtractions -= 1;

          return [
            {
              sourceId: document.url,
              statement: `${document.title} 里最值得记忆的一个问题是什么？`,
              summary: `${document.title} 的核心知识点摘要`,
              questionType: "open_ended",
              answer: `${document.title} 的标准答案`,
              explanation: `${document.title} 的解释说明`,
              evidenceQuote: `Quote from ${document.title}`,
              confidence: 0.9,
            },
          ];
        },
      },
      tagClassifier: {
        async classify(input: { truths: Array<unknown> }) {
          return input.truths.map(() => ({
            level1TagId: "frontend",
            level2TagId: "frontend.web",
            level3TagId: "frontend.web.basics",
          }));
        },
      } as any,
      embedder: {
        async embed(input: { texts: string[] }) {
          return input.texts.map(() => [0.1, 0.2, 0.3]);
        },
      },
    });

    const firstJob = await service.createJob({
      query: "frontend development",
      provider: "grok-search",
      searchLimit: 3,
      readConcurrency: 2,
    });

    await waitFor(
      () => repository.getJob(firstJob.job.id),
      (job) => job.status === "ready_to_read",
    );

    const discoveredDetail = service.getJobDetail(firstJob.job.id)!;
    expect(discoveredDetail.sources).toHaveLength(3);
    expect(discoveredDetail.sources.every((source) => source.status === "pending_read")).toBe(true);

    await service.startProcessing({
      jobId: firstJob.job.id,
      readConcurrency: 2,
    });

    const completedFirstJob = await waitFor(
      () => repository.getJob(firstJob.job.id),
      (job) => job.status === "completed",
    );

    expect(completedFirstJob.truthCount).toBe(3);
    expect(completedFirstJob.completedSourceCount).toBe(3);
    expect(maxActiveReads).toBe(2);
    expect(maxActiveExtractions).toBe(1);
    expect(knowledgeStore.listTruths()).toHaveLength(3);
    expect(knowledgeStore.listTruths()[0]).toMatchObject({
      questionType: "open_ended",
      answer: "Frontend Guide 的标准答案",
    });

    const readerCallsAfterFirstRun = readerCalls;

    const secondJob = await service.createJob({
      query: "frontend development",
      provider: "grok-search",
      searchLimit: 3,
      readConcurrency: 2,
    });

    await waitFor(
      () => repository.getJob(secondJob.job.id),
      (job) => job.status === "ready_to_read",
    );

    await service.startProcessing({
      jobId: secondJob.job.id,
      readConcurrency: 2,
    });

    const completedSecondJob = await waitFor(
      () => repository.getJob(secondJob.job.id),
      (job) => job.status === "completed",
    );

    expect(completedSecondJob.truthCount).toBe(3);
    expect(readerCalls).toBe(readerCallsAfterFirstRun);

    const secondDetail = service.getJobDetail(secondJob.job.id)!;
    expect(secondDetail.sources.every((source) => source.contentCached)).toBe(true);
    expect(secondDetail.events.some((event) => event.label === "CACHE")).toBe(true);
  });

  test("serializes source-to-question extraction across capture jobs", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "recall-capture-service-"));
    const databasePath = join(tempDirectory, "recall.sqlite");
    temporaryDirectories.push(tempDirectory);

    const repository = createSqliteCaptureJobRepository(databasePath);
    const knowledgeStore = createSqlitePersistence(databasePath);
    let activeExtractions = 0;
    let maxActiveExtractions = 0;

    const service = new PersistentCaptureJobService({
      repository,
      knowledgeStore,
      providers: [
        {
          kind: "grok-search",
          async search(input) {
            return [
              {
                title: `${input.query} Source`,
                url: `https://example.com/${encodeURIComponent(input.query)}`,
                snippet: `${input.query} snippet`,
              },
            ];
          },
        },
      ],
      sourceReader: {
        async read(hit) {
          await sleep(10);

          return {
            ...hit,
            content: `Article body for ${hit.title}`,
          };
        },
      },
      taxonomyPlanner: {
        async plan() {
          return [
            {
              id: "frontend",
              parentId: null,
              level: 1,
              name: "Frontend",
              description: "Frontend knowledge.",
            },
            {
              id: "frontend.web",
              parentId: "frontend",
              level: 2,
              name: "Web",
              description: "Browser and document work.",
            },
            {
              id: "frontend.web.basics",
              parentId: "frontend.web",
              level: 3,
              name: "Basics",
              description: "Core frontend fundamentals.",
            },
          ];
        },
      },
      truthExtractor: {
        async extract(input) {
          const document = input.documents[0]!;
          activeExtractions += 1;
          maxActiveExtractions = Math.max(maxActiveExtractions, activeExtractions);
          await sleep(40);
          activeExtractions -= 1;

          return [
            {
              sourceId: document.url,
              statement: `${document.title} 里的高频题是什么？`,
              summary: `${document.title} 的标准答案摘要`,
              questionType: "open_ended",
              answer: `${document.title} 的标准答案`,
              explanation: `${document.title} 的展开说明`,
              evidenceQuote: `Quote from ${document.title}`,
              confidence: 0.92,
            },
          ];
        },
      },
      tagClassifier: {
        async classify(input: { truths: Array<unknown> }) {
          return input.truths.map(() => ({
            level1TagId: "frontend",
            level2TagId: "frontend.web",
            level3TagId: "frontend.web.basics",
          }));
        },
      } as any,
      embedder: {
        async embed(input: { texts: string[] }) {
          return input.texts.map(() => [0.1, 0.2, 0.3]);
        },
      },
    });

    const firstJob = await service.createJob({
      query: "react",
      provider: "grok-search",
      searchLimit: 1,
      readConcurrency: 2,
    });
    const secondJob = await service.createJob({
      query: "css",
      provider: "grok-search",
      searchLimit: 1,
      readConcurrency: 2,
    });

    await waitFor(
      () => repository.getJob(firstJob.job.id),
      (job) => job.status === "ready_to_read",
    );
    await waitFor(
      () => repository.getJob(secondJob.job.id),
      (job) => job.status === "ready_to_read",
    );

    await Promise.all([
      service.startProcessing({
        jobId: firstJob.job.id,
        readConcurrency: 2,
      }),
      service.startProcessing({
        jobId: secondJob.job.id,
        readConcurrency: 2,
      }),
    ]);

    const completedFirstJob = await waitFor(
      () => repository.getJob(firstJob.job.id),
      (job) => job.status === "completed",
      6000,
    );
    const completedSecondJob = await waitFor(
      () => repository.getJob(secondJob.job.id),
      (job) => job.status === "completed",
      6000,
    );

    expect(completedFirstJob.truthCount).toBe(1);
    expect(completedSecondJob.truthCount).toBe(1);
    expect(maxActiveExtractions).toBe(1);

    const secondDetail = service.getJobDetail(secondJob.job.id)!;
    expect(secondDetail.events.some((event) => event.text.includes("shared AI extraction lane"))).toBe(true);
  });

  test("requeues failed extraction sources to the end of the queue and retries them later", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "recall-capture-service-"));
    const databasePath = join(tempDirectory, "recall.sqlite");
    temporaryDirectories.push(tempDirectory);

    const repository = createSqliteCaptureJobRepository(databasePath);
    const knowledgeStore = createSqlitePersistence(databasePath);
    const extractOrder: string[] = [];
    const extractAttempts = new Map<string, number>();
    const searchHits = [
      { title: "Frontend Guide", url: "https://example.com/frontend-guide", snippet: "Guide snippet" },
      { title: "CSS Layout", url: "https://example.com/css-layout", snippet: "Layout snippet" },
      { title: "JS Runtime", url: "https://example.com/js-runtime", snippet: "Runtime snippet" },
    ];

    const service = new PersistentCaptureJobService({
      repository,
      knowledgeStore,
      retryPolicy: {
        baseDelayMs: 20,
        maxExtractAttempts: 2,
      },
      providers: [
        {
          kind: "grok-search",
          async search() {
            return searchHits;
          },
        },
      ],
      sourceReader: {
        async read(hit) {
          await sleep(5);

          return {
            ...hit,
            content: `Article body for ${hit.title}`,
          };
        },
      },
      taxonomyPlanner: {
        async plan() {
          return [
            {
              id: "frontend",
              parentId: null,
              level: 1,
              name: "Frontend",
              description: "Frontend knowledge.",
            },
            {
              id: "frontend.web",
              parentId: "frontend",
              level: 2,
              name: "Web",
              description: "Browser and document work.",
            },
            {
              id: "frontend.web.basics",
              parentId: "frontend.web",
              level: 3,
              name: "Basics",
              description: "Core frontend fundamentals.",
            },
          ];
        },
      },
      truthExtractor: {
        async extract(input) {
          const document = input.documents[0]!;
          const attempt = (extractAttempts.get(document.title) ?? 0) + 1;

          extractAttempts.set(document.title, attempt);
          extractOrder.push(document.title);
          await sleep(10);

          if (document.title === "Frontend Guide" && attempt === 1) {
            throw new Error("temporary extractor failure");
          }

          return [
            {
              sourceId: document.url,
              statement: `${document.title} 里的高频题是什么？`,
              summary: `${document.title} 的标准答案摘要`,
              questionType: "open_ended",
              answer: `${document.title} 的标准答案`,
              explanation: `${document.title} 的展开说明`,
              evidenceQuote: `Quote from ${document.title}`,
              confidence: 0.91,
            },
          ];
        },
      },
      tagClassifier: {
        async classify(input: { truths: Array<unknown> }) {
          return input.truths.map(() => ({
            level1TagId: "frontend",
            level2TagId: "frontend.web",
            level3TagId: "frontend.web.basics",
          }));
        },
      } as any,
      embedder: {
        async embed(input: { texts: string[] }) {
          return input.texts.map(() => [0.1, 0.2, 0.3]);
        },
      },
    });

    const job = await service.createJob({
      query: "frontend development",
      provider: "grok-search",
      searchLimit: 3,
      readConcurrency: 1,
    });

    await waitFor(
      () => repository.getJob(job.job.id),
      (currentJob) => currentJob.status === "ready_to_read",
    );

    await service.startProcessing({
      jobId: job.job.id,
      readConcurrency: 1,
    });

    const completedJob = await waitFor(
      () => repository.getJob(job.job.id),
      (currentJob) => currentJob.status === "completed",
      6000,
    );

    expect(completedJob.truthCount).toBe(3);
    expect(extractOrder).toEqual(["Frontend Guide", "CSS Layout", "JS Runtime", "Frontend Guide"]);

    const detail = service.getJobDetail(job.job.id)!;
    const retriedSource = detail.sources.find((source) => source.title === "Frontend Guide");
    const cssSource = detail.sources.find((source) => source.title === "CSS Layout");
    const jsSource = detail.sources.find((source) => source.title === "JS Runtime");

    expect(retriedSource?.extractAttemptCount).toBe(2);
    expect(retriedSource?.position).toBeGreaterThan(cssSource?.position ?? -1);
    expect(retriedSource?.position).toBeGreaterThan(jsSource?.position ?? -1);
    expect(detail.events.some((event) => event.label === "RETRY" && event.text.includes("Re-queued to the end of the queue"))).toBe(true);
  });

  test("resumes in-flight source processing after a service restart", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "recall-capture-service-"));
    const databasePath = join(tempDirectory, "recall.sqlite");
    temporaryDirectories.push(tempDirectory);

    const repository = createSqliteCaptureJobRepository(databasePath);
    const knowledgeStore = createSqlitePersistence(databasePath);
    const blockedRead = new Promise<never>(() => {});

    const firstService = new PersistentCaptureJobService({
      repository,
      knowledgeStore,
      retryPolicy: {
        baseDelayMs: 20,
      },
      providers: [
        {
          kind: "grok-search",
          async search() {
            return [
              {
                title: "React Guide",
                url: "https://example.com/react-guide",
                snippet: "React snippet",
              },
            ];
          },
        },
      ],
      sourceReader: {
        async read() {
          return blockedRead;
        },
      },
      taxonomyPlanner: {
        async plan() {
          return [
            {
              id: "frontend",
              parentId: null,
              level: 1,
              name: "Frontend",
              description: "Frontend knowledge.",
            },
            {
              id: "frontend.web",
              parentId: "frontend",
              level: 2,
              name: "Web",
              description: "Browser and document work.",
            },
            {
              id: "frontend.web.basics",
              parentId: "frontend.web",
              level: 3,
              name: "Basics",
              description: "Core frontend fundamentals.",
            },
          ];
        },
      },
      truthExtractor: {
        async extract(input) {
          const document = input.documents[0]!;

          return [
            {
              sourceId: document.url,
              statement: `${document.title} 里的高频题是什么？`,
              summary: `${document.title} 的标准答案摘要`,
              questionType: "open_ended",
              answer: `${document.title} 的标准答案`,
              explanation: `${document.title} 的展开说明`,
              evidenceQuote: `Quote from ${document.title}`,
              confidence: 0.9,
            },
          ];
        },
      },
      tagClassifier: {
        async classify(input: { truths: Array<unknown> }) {
          return input.truths.map(() => ({
            level1TagId: "frontend",
            level2TagId: "frontend.web",
            level3TagId: "frontend.web.basics",
          }));
        },
      } as any,
      embedder: {
        async embed(input: { texts: string[] }) {
          return input.texts.map(() => [0.1, 0.2, 0.3]);
        },
      },
    });

    const job = await firstService.createJob({
      query: "react",
      provider: "grok-search",
      searchLimit: 1,
      readConcurrency: 1,
    });

    await waitFor(
      () => repository.getJob(job.job.id),
      (currentJob) => currentJob.status === "ready_to_read",
    );

    await firstService.startProcessing({
      jobId: job.job.id,
      readConcurrency: 1,
    });

    await waitFor(
      () => firstService.getJobDetail(job.job.id)?.sources[0],
      (source) => source.status === "reading",
    );

    const restartedRepository = createSqliteCaptureJobRepository(databasePath);
    const restartedKnowledgeStore = createSqlitePersistence(databasePath);
    const restartedService = new PersistentCaptureJobService({
      repository: restartedRepository,
      knowledgeStore: restartedKnowledgeStore,
      retryPolicy: {
        baseDelayMs: 20,
      },
      providers: [
        {
          kind: "grok-search",
          async search() {
            return [];
          },
        },
      ],
      sourceReader: {
        async read(hit) {
          await sleep(5);

          return {
            ...hit,
            content: `Article body for ${hit.title}`,
          };
        },
      },
      taxonomyPlanner: {
        async plan() {
          return [
            {
              id: "frontend",
              parentId: null,
              level: 1,
              name: "Frontend",
              description: "Frontend knowledge.",
            },
            {
              id: "frontend.web",
              parentId: "frontend",
              level: 2,
              name: "Web",
              description: "Browser and document work.",
            },
            {
              id: "frontend.web.basics",
              parentId: "frontend.web",
              level: 3,
              name: "Basics",
              description: "Core frontend fundamentals.",
            },
          ];
        },
      },
      truthExtractor: {
        async extract(input) {
          const document = input.documents[0]!;

          return [
            {
              sourceId: document.url,
              statement: `${document.title} 里的高频题是什么？`,
              summary: `${document.title} 的标准答案摘要`,
              questionType: "open_ended",
              answer: `${document.title} 的标准答案`,
              explanation: `${document.title} 的展开说明`,
              evidenceQuote: `Quote from ${document.title}`,
              confidence: 0.9,
            },
          ];
        },
      },
      tagClassifier: {
        async classify(input: { truths: Array<unknown> }) {
          return input.truths.map(() => ({
            level1TagId: "frontend",
            level2TagId: "frontend.web",
            level3TagId: "frontend.web.basics",
          }));
        },
      } as any,
      embedder: {
        async embed(input: { texts: string[] }) {
          return input.texts.map(() => [0.1, 0.2, 0.3]);
        },
      },
    });

    await restartedService.resumePendingJobs();

    const completedJob = await waitFor(
      () => restartedRepository.getJob(job.job.id),
      (currentJob) => currentJob.status === "completed",
      6000,
    );

    expect(completedJob.truthCount).toBe(1);

    const detail = restartedService.getJobDetail(job.job.id)!;
    expect(detail.sources[0]?.readAttemptCount).toBe(2);
    expect(detail.events.some((event) => event.label === "RECOVER" && event.text.includes("Recovered"))).toBe(true);
  });

  test("surfaces pending cards and normalizes exhausted source failures for display", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "recall-capture-service-"));
    const databasePath = join(tempDirectory, "recall.sqlite");
    temporaryDirectories.push(tempDirectory);

    const repository = createSqliteCaptureJobRepository(databasePath);
    const knowledgeStore = createSqlitePersistence(databasePath);

    const service = new PersistentCaptureJobService({
      repository,
      knowledgeStore,
      providers: [],
      sourceReader: {
        async read() {
          throw new Error("not used");
        },
      },
      taxonomyPlanner: {
        async plan() {
          return [];
        },
      },
      truthExtractor: {
        async extract() {
          return [];
        },
      },
      tagClassifier: {
        async classify() {
          return {
            truths: [],
            assignments: [],
            strippedTruthCount: 0,
          };
        },
      } as any,
      embedder: {
        async embed() {
          return [];
        },
      },
    });

    const job = repository.createJob({
      query: "react",
      provider: "grok-search",
      searchLimit: 5,
      readConcurrency: 1,
    });

    repository.replaceSources(job.id, [
      { title: "Allowed source", url: "https://example.com/allowed", snippet: "allowed" },
      { title: "Moderated source", url: "https://example.com/blocked", snippet: "blocked" },
      { title: "Broken source", url: "https://example.com/broken", snippet: "broken" },
    ]);

    const [allowedSource, moderatedSource, brokenSource] = repository.listSources(job.id);
    repository.updateSource(allowedSource!.id, {
      status: "completed",
      contentCached: true,
      truthDraftCount: 1,
      extractedAt: "2026-04-04T10:00:00.000Z",
    });
    repository.replaceSourceTruthDrafts(job.id, allowedSource!.url, [
      {
        sourceId: allowedSource!.url,
        statement: "什么是 React 批处理更新？",
        summary: "同一事件中的 state 更新会被合并。",
        questionType: "open_ended",
        answer: "同一事件中的 state 更新会被合并。",
        explanation: "React 会批量提交同一事件中的更新。",
        evidenceQuote: "React batches updates within one event.",
        confidence: 0.9,
      },
    ]);
    repository.updateSource(moderatedSource!.id, {
      status: "failed",
      contentCached: true,
      extractAttemptCount: 3,
      error: "Chat completion failed with status 500 (sensitive_words_detected: blocked).",
    });
    repository.updateSource(brokenSource!.id, {
      status: "failed",
      readAttemptCount: 3,
      error: "Jina reader failed for https://example.com/broken with status 451.",
    });
    repository.updateJob(job.id, {
      status: "processing",
      phase: "classify",
    });

    const detail = service.getJobDetail(job.id)!;

    expect(detail.activeOperation).toMatchObject({
      kind: "truth",
      status: "classifying_question",
      title: "什么是 React 批处理更新？",
    });
    expect(detail.pendingItems).toEqual([
      expect.objectContaining({
        kind: "truth",
        title: "什么是 React 批处理更新？",
        subtitle: "Allowed source",
        status: "classifying_question",
        error: null,
      }),
      expect.objectContaining({
        kind: "source",
        title: "Moderated source",
        status: "failed_extract",
        error: "包含敏感内容（已重试 3 次，已跳过）",
        failureKind: "sensitive_content",
        skipped: true,
      }),
      expect.objectContaining({
        kind: "source",
        title: "Broken source",
        status: "failed_read",
        error: "Jina 阅读错误（已重试 3 次，已跳过）",
        failureKind: "jina_reader",
        skipped: true,
      }),
    ]);
    expect(detail.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Moderated source",
          error: "包含敏感内容（已重试 3 次，已跳过）",
          skipped: true,
        }),
        expect.objectContaining({
          title: "Broken source",
          error: "Jina 阅读错误（已重试 3 次，已跳过）",
          skipped: true,
        }),
      ]),
    );
  });

  test("continues to completion when classification strips moderated truths", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "recall-capture-service-"));
    const databasePath = join(tempDirectory, "recall.sqlite");
    temporaryDirectories.push(tempDirectory);

    const repository = createSqliteCaptureJobRepository(databasePath);
    const knowledgeStore = createSqlitePersistence(databasePath);

    const service = new PersistentCaptureJobService({
      repository,
      knowledgeStore,
      providers: [
        {
          kind: "grok-search",
          async search() {
            return [
              { title: "React Guide", url: "https://example.com/react-guide", snippet: "React snippet" },
            ];
          },
        },
      ],
      sourceReader: {
        async read(hit) {
          return {
            ...hit,
            content: `Article body for ${hit.title}`,
          };
        },
      },
      taxonomyPlanner: {
        async plan() {
          return [
            {
              id: "frontend",
              parentId: null,
              level: 1,
              name: "Frontend",
              description: "Frontend knowledge.",
            },
            {
              id: "frontend.web",
              parentId: "frontend",
              level: 2,
              name: "Web",
              description: "Browser and document work.",
            },
            {
              id: "frontend.web.react",
              parentId: "frontend.web",
              level: 3,
              name: "React",
              description: "React fundamentals.",
            },
          ];
        },
      },
      truthExtractor: {
        async extract(input) {
          const document = input.documents[0]!;

          return [
            {
              sourceId: document.url,
              statement: `${document.title} 的正常题目是什么？`,
              summary: `${document.title} 的标准答案摘要`,
              questionType: "open_ended",
              answer: `${document.title} 的标准答案`,
              explanation: `${document.title} 的展开说明`,
              evidenceQuote: `Quote from ${document.title}`,
              confidence: 0.91,
            },
            {
              sourceId: document.url,
              statement: `${document.title} 的敏感题目会被剥离吗？`,
              summary: `${document.title} 的敏感答案`,
              questionType: "open_ended",
              answer: `${document.title} 的敏感答案`,
              explanation: `${document.title} 的敏感解释`,
              evidenceQuote: `Sensitive quote from ${document.title}`,
              confidence: 0.5,
            },
          ];
        },
      },
      tagClassifier: {
        async classify(input: { truths: TruthDraft[] }) {
          return {
            truths: [input.truths[0]!],
            assignments: [
              {
                level1TagId: "frontend",
                level2TagId: "frontend.web",
                level3TagId: "frontend.web.react",
              },
            ],
            strippedTruthCount: 1,
          };
        },
      } as any,
      embedder: {
        async embed(input: { texts: string[] }) {
          return input.texts.map(() => [0.1, 0.2, 0.3]);
        },
      },
    });

    const job = await service.createJob({
      query: "react",
      provider: "grok-search",
      searchLimit: 1,
      readConcurrency: 1,
    });

    await waitFor(
      () => repository.getJob(job.job.id),
      (currentJob) => currentJob.status === "ready_to_read",
    );

    await service.startProcessing({
      jobId: job.job.id,
      readConcurrency: 1,
    });

    const completedJob = await waitFor(
      () => repository.getJob(job.job.id),
      (currentJob) => currentJob.status === "completed",
      6000,
    );

    expect(completedJob.truthCount).toBe(1);
    expect(knowledgeStore.listTruths()).toHaveLength(1);
    expect(knowledgeStore.listTruths()[0]?.statement).toContain("正常题目");

    const detail = service.getJobDetail(job.job.id)!;
    expect(detail.events.some((event) => event.label === "CLASSIFY" && event.text.includes("Stripped 1 moderated"))).toBe(true);
  });
});
