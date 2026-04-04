import { describe, expect, test } from "bun:test";

import type { TaxonomyNode, TruthDraft } from "@recall/domain";

import { AiTruthExtractor, HybridHierarchicalTagClassifier } from "../src/runtime/pipeline";
import type { ChatJsonGateway, EmbeddingService } from "../src/runtime/types";

describe("pipeline-sensitive-words", () => {
  test("truth extractor skips documents rejected by upstream moderation", async () => {
    let callCount = 0;
    const gateway: ChatJsonGateway = {
      async generateJson<T>() {
        callCount += 1;

        if (callCount === 2) {
          throw new Error("Chat completion failed with status 500 (sensitive_words_detected: blocked).");
        }

        return {
          truths: [
            {
              statement: "什么是 React 批处理更新？",
              summary: "同一事件中的更新会被合并提交。",
              questionType: "open_ended",
              answer: "同一事件中的更新会被合并提交。",
              explanation: "React 会合并同一事件中的更新，减少重复渲染。",
              evidenceQuote: "React batches updates within one event.",
              confidence: 0.9,
            },
          ],
        } as T;
      },
    };

    const extractor = new AiTruthExtractor(gateway);
    const drafts = await extractor.extract({
      query: "react",
      documents: [
        {
          title: "React batching",
          url: "https://example.com/react-batching",
          snippet: "React batching guide",
          content: "React batches updates within one event.",
        },
        {
          title: "Blocked source",
          url: "https://example.com/blocked",
          snippet: "Blocked source",
          content: "This source is blocked upstream.",
        },
      ],
    });

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      sourceId: "https://example.com/react-batching",
      statement: "什么是 React 批处理更新？",
    });
  });

  test("classifier strips moderated truths and continues with the rest", async () => {
    const truths: TruthDraft[] = [
      {
        sourceId: "https://example.com/react-batching",
        statement: "什么是 React 批处理更新？",
        summary: "同一事件中的更新会被合并提交。",
        questionType: "open_ended",
        answer: "同一事件中的更新会被合并提交。",
        explanation: "React 会合并同一事件中的更新，减少重复渲染。",
        evidenceQuote: "React batches updates within one event.",
        confidence: 0.9,
      },
      {
        sourceId: "https://example.com/blocked",
        statement: "这个题会触发审核吗？",
        summary: "会被审核掉。",
        questionType: "open_ended",
        answer: "会被审核掉。",
        explanation: "用于测试过滤逻辑。",
        evidenceQuote: "blocked by moderation",
        confidence: 0.8,
      },
    ];
    const taxonomy: TaxonomyNode[] = [
      {
        id: "frontend",
        parentId: null,
        level: 1,
        name: "Frontend",
        description: "Frontend knowledge.",
      },
      {
        id: "frontend.react",
        parentId: "frontend",
        level: 2,
        name: "React",
        description: "React rendering and state.",
      },
      {
        id: "frontend.react.state",
        parentId: "frontend.react",
        level: 3,
        name: "State",
        description: "State updates and render timing.",
      },
    ];

    let rerankCallCount = 0;
    const gateway: ChatJsonGateway = {
      async generateJson<T>() {
        rerankCallCount += 1;

        if (rerankCallCount === 2) {
          throw new Error("Chat completion failed with status 500 (sensitive_words_detected: blocked).");
        }

        return {
          level1Id: "frontend",
          level2Id: "frontend.react",
          level3Id: "frontend.react.state",
          reason: "React batching belongs to state update behavior.",
        } as T;
      },
    };
    const embedder: EmbeddingService = {
      async embed(input) {
        return input.texts.map(() => [1, 0, 0]);
      },
    };

    const classifier = new HybridHierarchicalTagClassifier({
      gateway,
      embedder,
    });

    const result = await classifier.classify({
      truths,
      taxonomy,
    });

    expect(result.truths).toEqual([truths[0]]);
    expect(result.assignments).toEqual([
      {
        level1TagId: "frontend",
        level2TagId: "frontend.react",
        level3TagId: "frontend.react.state",
      },
    ]);
    expect(result.strippedTruthCount).toBe(1);
  });
});
