import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

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
});
