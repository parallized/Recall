import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createApp,
  createInMemoryPersistence,
  createSqlitePersistence,
  type CollectionPipeline,
  type QueryReadModel,
} from "../src/index";

describe("api", () => {
  let persistence = createInMemoryPersistence();

  beforeEach(() => {
    persistence = createInMemoryPersistence();
  });

  test("persists collected truths and exposes progress plus recommendations", async () => {
    const pipeline: CollectionPipeline = {
      collect: async () => ({
        collectionId: "collection-1",
        query: "React state management",
        provider: "grok-search",
        truthCount: 2,
        sourceCount: 1,
        taxonomy: [
          {
            id: "engineering",
            parentId: null,
            level: 1,
            name: "Software Engineering",
            description: "Programming, architecture, software delivery, and runtime systems.",
          },
          {
            id: "frontend",
            parentId: "engineering",
            level: 2,
            name: "Frontend Engineering",
            description: "Browser runtime, UI composition, interaction models, and client state.",
          },
          {
            id: "react",
            parentId: "frontend",
            level: 3,
            name: "React",
            description: "React rendering, hooks, component architecture, and state coordination.",
          },
        ],
        truths: [
          {
            id: "truth-1",
            statement: "React 在同一个事件循环中会如何处理多次 state update？",
            summary: "同一事件中的更新会被批处理。",
            questionType: "open_ended",
            answer: "React 会把同一事件循环中的多次 state 更新批处理后再统一提交，以减少重复渲染。",
            explanation: "这是 React 渲染性能优化的核心机制之一，也是面试中常见的开放题。",
            evidenceQuote: "React batches updates within one event.",
            confidence: 0.92,
            sourceUrl: "https://react.dev",
            level1TagId: "engineering",
            level2TagId: "frontend",
            level3TagId: "react",
          },
          {
            id: "truth-2",
            statement: "关于 Hooks 的调用顺序，下面哪项是正确的？",
            summary: "Hooks 必须在每次渲染时保持相同调用顺序。",
            questionType: "multiple_choice",
            options: [
              "只要组件最终渲染成功，Hooks 顺序可以变化",
              "Hooks 必须在每次渲染时保持相同调用顺序",
              "只有 useState 需要稳定顺序，其他 Hooks 不需要",
              "Hooks 可以放进条件分支里，只要开发者能保证逻辑正确",
            ],
            answer: "Hooks 必须在每次渲染时保持相同调用顺序",
            explanation: "React 依赖 Hook 调用顺序去把状态槽位和具体 Hook 对应起来。",
            evidenceQuote: "Hooks rely on call order.",
            confidence: 0.88,
            sourceUrl: "https://react.dev",
            level1TagId: "engineering",
            level2TagId: "frontend",
            level3TagId: "react",
          },
        ],
      }),
    };

    const readModel: QueryReadModel = {
      ...persistence,
    };

    const app = createApp({
      pipeline,
      readModel,
      persistence,
    });

    const emptyGraphResponse = await app.handle(new Request("http://localhost/graph"));
    expect(await emptyGraphResponse.json()).toEqual([]);

    const collectResponse = await app.handle(
      new Request("http://localhost/knowledge/collect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "React state management",
          provider: "grok-search",
        }),
      }),
    );

    expect(collectResponse.status).toBe(200);

    const collectBody = await collectResponse.json();
    expect(collectBody).toMatchObject({
      collectionId: "collection-1",
      truthCount: 2,
      sourceCount: 1,
    });

    persistence.recordSignal({
      truthId: "truth-1",
      masteryDelta: 0.3,
      happenedAt: "2026-04-01T08:00:00.000Z",
    });

    const truthsResponse = await app.handle(new Request("http://localhost/truths"));
    const repositoryResponse = await app.handle(new Request("http://localhost/repository"));
    const progressResponse = await app.handle(new Request("http://localhost/tags/progress"));
    const graphResponse = await app.handle(new Request("http://localhost/graph"));
    const recommendationResponse = await app.handle(
      new Request("http://localhost/recommendations?now=2026-04-02T08:00:00.000Z"),
    );

    const truthsBody = await truthsResponse.json();
    expect(truthsBody).toHaveLength(2);
    expect(truthsBody[0]).toMatchObject({
      questionType: "open_ended",
      answer: "React 会把同一事件循环中的多次 state 更新批处理后再统一提交，以减少重复渲染。",
    });
    expect(truthsBody[1]).toMatchObject({
      questionType: "multiple_choice",
      options: [
        "只要组件最终渲染成功，Hooks 顺序可以变化",
        "Hooks 必须在每次渲染时保持相同调用顺序",
        "只有 useState 需要稳定顺序，其他 Hooks 不需要",
        "Hooks 可以放进条件分支里，只要开发者能保证逻辑正确",
      ],
    });
    expect(await repositoryResponse.json()).toEqual({
      summary: {
        truthCount: 2,
        unreadCount: 2,
        level1TagCount: 1,
        level2TagCount: 1,
        level3TagCount: 1,
        multipleChoiceCount: 1,
        openEndedCount: 1,
      },
      taxonomy: [
        {
          id: "engineering",
          parentId: null,
          level: 1,
          name: "Software Engineering",
          description: "Programming, architecture, software delivery, and runtime systems.",
          progress: 0.15,
          truthCount: 2,
          unreadCount: 2,
        },
        {
          id: "frontend",
          parentId: "engineering",
          level: 2,
          name: "Frontend Engineering",
          description: "Browser runtime, UI composition, interaction models, and client state.",
          progress: 0.15,
          truthCount: 2,
          unreadCount: 2,
        },
        {
          id: "react",
          parentId: "frontend",
          level: 3,
          name: "React",
          description: "React rendering, hooks, component architecture, and state coordination.",
          progress: 0.15,
          truthCount: 2,
          unreadCount: 2,
        },
      ],
      truths: [
        {
          id: "truth-2",
          statement: "关于 Hooks 的调用顺序，下面哪项是正确的？",
          summary: "Hooks 必须在每次渲染时保持相同调用顺序。",
          questionType: "multiple_choice",
          options: [
            "只要组件最终渲染成功，Hooks 顺序可以变化",
            "Hooks 必须在每次渲染时保持相同调用顺序",
            "只有 useState 需要稳定顺序，其他 Hooks 不需要",
            "Hooks 可以放进条件分支里，只要开发者能保证逻辑正确",
          ],
          answer: "Hooks 必须在每次渲染时保持相同调用顺序",
          explanation: "React 依赖 Hook 调用顺序去把状态槽位和具体 Hook 对应起来。",
          evidenceQuote: "Hooks rely on call order.",
          confidence: 0.88,
          sourceUrl: "https://react.dev",
          level1TagId: "engineering",
          level2TagId: "frontend",
          level3TagId: "react",
          level1TagName: "Software Engineering",
          level2TagName: "Frontend Engineering",
          level3TagName: "React",
          readCount: 0,
          createdAt: expect.any(String),
          lastReadAt: null,
          isUnread: true,
        },
        {
          id: "truth-1",
          statement: "React 在同一个事件循环中会如何处理多次 state update？",
          summary: "同一事件中的更新会被批处理。",
          questionType: "open_ended",
          answer: "React 会把同一事件循环中的多次 state 更新批处理后再统一提交，以减少重复渲染。",
          explanation: "这是 React 渲染性能优化的核心机制之一，也是面试中常见的开放题。",
          evidenceQuote: "React batches updates within one event.",
          confidence: 0.92,
          sourceUrl: "https://react.dev",
          level1TagId: "engineering",
          level2TagId: "frontend",
          level3TagId: "react",
          level1TagName: "Software Engineering",
          level2TagName: "Frontend Engineering",
          level3TagName: "React",
          readCount: 0,
          createdAt: expect.any(String),
          lastReadAt: null,
          isUnread: true,
        },
      ],
    });
    expect(await graphResponse.json()).toEqual([
      {
        id: "engineering",
        parentId: null,
        level: 1,
        name: "Software Engineering",
        description: "Programming, architecture, software delivery, and runtime systems.",
        progress: 0.15,
        truthCount: 2,
      },
      {
        id: "frontend",
        parentId: "engineering",
        level: 2,
        name: "Frontend Engineering",
        description: "Browser runtime, UI composition, interaction models, and client state.",
        progress: 0.15,
        truthCount: 2,
      },
      {
        id: "react",
        parentId: "frontend",
        level: 3,
        name: "React",
        description: "React rendering, hooks, component architecture, and state coordination.",
        progress: 0.15,
        truthCount: 2,
      },
    ]);
    expect(await progressResponse.json()).toEqual([
      {
        nodeId: "engineering",
        nodeName: "Software Engineering",
        level: 1,
        truthCount: 2,
        masteredTruthCount: 0,
        progress: 0.15,
      },
      {
        nodeId: "frontend",
        nodeName: "Frontend Engineering",
        level: 2,
        truthCount: 2,
        masteredTruthCount: 0,
        progress: 0.15,
      },
      {
        nodeId: "react",
        nodeName: "React",
        level: 3,
        truthCount: 2,
        masteredTruthCount: 0,
        progress: 0.15,
      },
    ]);
    expect(await recommendationResponse.json()).toEqual([
      {
        truthId: "truth-2",
        statement: "关于 Hooks 的调用顺序，下面哪项是正确的？",
        level3TagId: "react",
        score: 1,
      },
      {
        truthId: "truth-1",
        statement: "React 在同一个事件循环中会如何处理多次 state update？",
        level3TagId: "react",
        score: 0.84,
      },
    ]);
  });

  test("marks truths as read and permanently destroys them", async () => {
    const pipeline: CollectionPipeline = {
      collect: async () => ({
        collectionId: "collection-read-destroy",
        query: "React state management",
        provider: "grok-search",
        truthCount: 1,
        sourceCount: 1,
        taxonomy: [
          {
            id: "engineering",
            parentId: null,
            level: 1,
            name: "Software Engineering",
            description: "Programming, architecture, software delivery, and runtime systems.",
          },
          {
            id: "frontend",
            parentId: "engineering",
            level: 2,
            name: "Frontend Engineering",
            description: "Browser runtime, UI composition, interaction models, and client state.",
          },
          {
            id: "react",
            parentId: "frontend",
            level: 3,
            name: "React",
            description: "React rendering, hooks, component architecture, and state coordination.",
          },
        ],
        truths: [
          {
            id: "truth-destroy-1",
            statement: "React 在同一个事件循环中会如何处理多次 state update？",
            summary: "同一事件中的更新会被批处理。",
            evidenceQuote: "React batches updates within one event.",
            confidence: 0.92,
            sourceUrl: "https://react.dev",
            level1TagId: "engineering",
            level2TagId: "frontend",
            level3TagId: "react",
          },
        ],
      }),
    };

    const app = createApp({
      pipeline,
      persistence,
    });

    await app.handle(
      new Request("http://localhost/knowledge/collect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "React state management",
          provider: "grok-search",
        }),
      }),
    );

    const markReadResponse = await app.handle(
      new Request("http://localhost/truths/truth-destroy-1/read", {
        method: "POST",
      }),
    );

    expect(markReadResponse.status).toBe(200);
    expect(await markReadResponse.json()).toMatchObject({
      id: "truth-destroy-1",
      readCount: 1,
      lastReadAt: expect.any(String),
    });

    const repositoryAfterRead = await app.handle(new Request("http://localhost/repository"));
    expect(await repositoryAfterRead.json()).toMatchObject({
      summary: {
        truthCount: 1,
        unreadCount: 0,
      },
      taxonomy: [
        expect.objectContaining({ id: "engineering", unreadCount: 0 }),
        expect.objectContaining({ id: "frontend", unreadCount: 0 }),
        expect.objectContaining({ id: "react", unreadCount: 0 }),
      ],
      truths: [
        expect.objectContaining({
          id: "truth-destroy-1",
          readCount: 1,
          isUnread: false,
        }),
      ],
    });

    const destroyResponse = await app.handle(
      new Request("http://localhost/truths/truth-destroy-1", {
        method: "DELETE",
      }),
    );

    expect(destroyResponse.status).toBe(200);
    expect(await destroyResponse.json()).toEqual({ ok: true });

    const repositoryAfterDestroy = await app.handle(new Request("http://localhost/repository"));
    expect(await repositoryAfterDestroy.json()).toEqual({
      summary: {
        truthCount: 0,
        unreadCount: 0,
        level1TagCount: 0,
        level2TagCount: 0,
        level3TagCount: 0,
        multipleChoiceCount: 0,
        openEndedCount: 0,
      },
      taxonomy: [],
      truths: [],
    });
  });

  test("streams collection progress, token usage, and final result", async () => {
    const pipeline: CollectionPipeline = {
      collect: async (input) => {
        await input.reporter?.({
          type: "phase",
          phase: "search",
          status: "start",
          message: "Starting grok search.",
          provider: "grok-search",
        });
        await input.reporter?.({
          type: "model",
          schemaName: "taxonomy_blueprint",
          channel: "reasoning",
          text: "Thinking about the topic.",
        });
        await input.reporter?.({
          type: "usage",
          scope: "ai",
          schemaName: "taxonomy_blueprint",
          usage: {
            promptTokens: 20,
            completionTokens: 30,
            totalTokens: 50,
          },
        });

        return {
          collectionId: "collection-stream-1",
          query: input.query,
          provider: input.provider,
          truthCount: 1,
          sourceCount: 1,
          taxonomy: [
            {
              id: "react",
              parentId: null,
              level: 1,
              name: "React",
              description: "React learning map.",
            },
          ],
          truths: [
            {
              id: "truth-stream-1",
              statement: "React batches state updates within the same event.",
              summary: "Batched state updates share the same event loop turn.",
              evidenceQuote: "React batches updates within the same event.",
              confidence: 0.9,
              sourceUrl: "https://react.dev",
              level1TagId: "react",
              level2TagId: "react",
              level3TagId: "react",
            },
          ],
        };
      },
    };

    const app = createApp({
      pipeline,
      persistence,
    });

    const response = await app.handle(
      new Request("http://localhost/knowledge/collect/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "React batching",
          provider: "grok-search",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const payloads = (await response.text())
      .split("\n\n")
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk.startsWith("data: "))
      .map((chunk) => JSON.parse(chunk.slice("data: ".length)));

    expect(payloads).toEqual([
      {
        type: "phase",
        phase: "search",
        status: "start",
        message: "Starting grok search.",
        provider: "grok-search",
      },
      {
        type: "model",
        schemaName: "taxonomy_blueprint",
        channel: "reasoning",
        text: "Thinking about the topic.",
      },
      {
        type: "usage",
        scope: "ai",
        schemaName: "taxonomy_blueprint",
        usage: {
          promptTokens: 20,
          completionTokens: 30,
          totalTokens: 50,
        },
        totals: {
          promptTokens: 20,
          completionTokens: 30,
          totalTokens: 50,
        },
      },
      {
        type: "phase",
        phase: "persist",
        status: "start",
        message: "Persisting collection into SQLite.",
      },
      {
        type: "phase",
        phase: "persist",
        status: "complete",
        message: "Saved 1 truths.",
        count: 1,
      },
      {
        type: "result",
        result: {
          collectionId: "collection-stream-1",
          truthCount: 1,
          sourceCount: 1,
          taxonomyCount: 1,
        },
        usage: {
          promptTokens: 20,
          completionTokens: 30,
          totalTokens: 50,
        },
      },
    ]);
  });

  test("keeps running cleanly after the stream client disconnects", async () => {
    let completed = false;
    const pipeline: CollectionPipeline = {
      collect: async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        await input.reporter?.({
          type: "phase",
          phase: "search",
          status: "start",
          message: "Starting grok search.",
          provider: "grok-search",
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        completed = true;

        return {
          collectionId: "collection-stream-disconnect",
          query: input.query,
          provider: input.provider,
          truthCount: 1,
          sourceCount: 1,
          taxonomy: [
            {
              id: "react",
              parentId: null,
              level: 1,
              name: "React",
              description: "React learning map.",
            },
          ],
          truths: [
            {
              id: "truth-stream-disconnect-1",
              statement: "React batches state updates within the same event.",
              summary: "Batched state updates share the same event loop turn.",
              evidenceQuote: "React batches updates within the same event.",
              confidence: 0.9,
              sourceUrl: "https://react.dev",
              level1TagId: "react",
              level2TagId: "react",
              level3TagId: "react",
            },
          ],
        };
      },
    };

    const app = createApp({
      pipeline,
      persistence,
    });

    const response = await app.handle(
      new Request("http://localhost/knowledge/collect/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "React batching",
          provider: "grok-search",
        }),
      }),
    );

    expect(response.status).toBe(200);

    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(completed).toBe(true);
  });

  test("removes capture jobs through the HTTP API without touching repository data", async () => {
    const app = createApp({
      pipeline: {
        collect: async () => ({
          collectionId: "unused",
          query: "unused",
          provider: "grok-search",
          truthCount: 0,
          sourceCount: 0,
          taxonomy: [],
          truths: [],
        }),
      },
      persistence,
      captureJobs: {
        listJobs() {
          return [];
        },
        getJobDetail() {
          return null;
        },
        async createJob() {
          throw new Error("not implemented");
        },
        async startProcessing() {
          throw new Error("not implemented");
        },
        async deleteJob(jobId: string) {
          return jobId === "job-1";
        },
        async resumePendingJobs() {},
      },
    });

    const okResponse = await app.handle(
      new Request("http://localhost/capture/jobs/job-1", {
        method: "DELETE",
      }),
    );

    expect(okResponse.status).toBe(200);
    expect(await okResponse.json()).toEqual({
      ok: true,
    });

    const missingResponse = await app.handle(
      new Request("http://localhost/capture/jobs/job-2", {
        method: "DELETE",
      }),
    );

    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toEqual({
      message: "Capture job not found: job-2",
    });
  });

  test("prunes orphan taxonomy left by older builds on restart", () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "recall-api-"));
    const databasePath = join(tempDirectory, "recall.sqlite");
    const database = new Database(databasePath, { create: true });

    try {
      database.exec(`
        CREATE TABLE IF NOT EXISTS taxonomy_nodes (
          id TEXT PRIMARY KEY,
          parent_id TEXT,
          level INTEGER NOT NULL,
          name TEXT NOT NULL,
          description TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS truths (
          id TEXT PRIMARY KEY,
          statement TEXT NOT NULL,
          summary TEXT NOT NULL,
          evidence_quote TEXT NOT NULL,
          confidence REAL NOT NULL,
          source_url TEXT NOT NULL,
          level1_tag_id TEXT NOT NULL,
          level2_tag_id TEXT NOT NULL,
          level3_tag_id TEXT NOT NULL,
          embedding_json TEXT,
          collection_id TEXT NOT NULL
        );
      `);

      const insertNode = database.query(`
        INSERT INTO taxonomy_nodes (id, parent_id, level, name, description)
        VALUES (?, ?, ?, ?, ?)
      `);

      insertNode.run(
        "engineering",
        null,
        1,
        "Software Engineering",
        "Programming, architecture, software delivery, and runtime systems.",
      );
      insertNode.run(
        "frontend",
        "engineering",
        2,
        "Frontend Engineering",
        "Browser runtime, UI composition, interaction models, and client state.",
      );
      insertNode.run(
        "react",
        "frontend",
        3,
        "React",
        "React rendering, hooks, component architecture, and state coordination.",
      );
    } finally {
      database.close();
    }

    const restarted = createSqlitePersistence(databasePath);

    expect(restarted.getTaxonomy()).toEqual([]);
    expect(restarted.listTagProgress()).toEqual([]);
  });
});
