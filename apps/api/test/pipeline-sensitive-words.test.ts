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

  test("truth extractor rejects source-specific cards with missing standalone context", async () => {
    const gateway: ChatJsonGateway = {
      async generateJson<T>() {
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
            {
              statement: "毕业三年内的社招同学在使用《阿秀的学习笔记》时，应重点关注哪些章节？",
              summary: "可以集中精力攻第四章和第五章。",
              questionType: "open_ended",
              answer: "重点关注第四章校招八股文和第五章数据结构与算法。",
              explanation: "这篇文章建议优先看这些章节。",
              evidenceQuote: "第四章校招八股文、第五章数据结构与算法。",
              confidence: 0.88,
            },
          ],
        } as T;
      },
    };

    const extractor = new AiTruthExtractor(gateway);
    const drafts = await extractor.extract({
      query: "计算机行业求职简历编写方式",
      documents: [
        {
          title: "Resume guide",
          url: "https://example.com/resume-guide",
          snippet: "resume guide",
          content: "A mixed source that also mentions one person's study note chapters.",
        },
      ],
    });

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.statement).toBe("什么是 React 批处理更新？");
  });

  test("truth extractor rejects time-sensitive and narrow-scope cards", async () => {
    const gateway: ChatJsonGateway = {
      async generateJson<T>() {
        return {
          truths: [
            {
              statement: "React 为什么要批处理同一事件中的更新？",
              summary: "为了减少重复渲染并保证状态提交更高效。",
              questionType: "open_ended",
              answer: "为了减少重复渲染并保证状态提交更高效。",
              explanation: "这是 React 更新模型中的长期有效知识。",
              evidenceQuote: "React batches updates within one event.",
              confidence: 0.91,
            },
            {
              statement: "截至 2026 年，当前版本最强的 React 状态管理库是什么？",
              summary: "目前大家更推荐某个最新方案。",
              questionType: "open_ended",
              answer: "当前版本答案会随生态和版本变化而失效。",
              explanation: "这是一个明显依赖当前时间和生态趋势的问题。",
              evidenceQuote: "Current best libraries change frequently.",
              confidence: 0.72,
            },
            {
              statement: "毕业三年内的社招同学在某公司面试前应该死记哪些八股？",
              summary: "重点背这份特定清单。",
              questionType: "open_ended",
              answer: "这类建议只适合特定人群和特定场景。",
              explanation: "范围过窄，无法作为通用知识卡片复用。",
              evidenceQuote: "Focus on this checklist for experienced hires.",
              confidence: 0.7,
            },
          ],
        } as T;
      },
    };

    const extractor = new AiTruthExtractor(gateway);
    const drafts = await extractor.extract({
      query: "react state management",
      documents: [
        {
          title: "React guide",
          url: "https://example.com/react-guide",
          snippet: "react guide",
          content: "A mixed source.",
        },
      ],
    });

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.statement).toBe("React 为什么要批处理同一事件中的更新？");
  });

  test("truth extractor normalizes collapsed numbered lists into markdown lines", async () => {
    const gateway: ChatJsonGateway = {
      async generateJson<T>() {
        return {
          truths: [
            {
              statement: "AI Agent 的三个核心组成是什么？",
              summary: "语言模型、工具、编排层。",
              questionType: "open_ended",
              answer:
                "1.语言模型：思考大脑，用于理解请求、推理和决策。 2.工具：允许智能体在现实世界中行动的附加组件，如 API 调用。 3.编排层：管理语言模型和工具的使用逻辑。",
              explanation:
                "1.语言模型负责理解和推理。 2.工具负责执行动作。 3.编排层负责把调用顺序组织起来。",
              evidenceQuote: "Agents combine models, tools, and orchestration.",
              confidence: 0.88,
            },
          ],
        } as T;
      },
    };

    const extractor = new AiTruthExtractor(gateway);
    const drafts = await extractor.extract({
      query: "ai agent architecture",
      documents: [
        {
          title: "Agent guide",
          url: "https://example.com/agent-guide",
          snippet: "agent guide",
          content: "Agents combine models, tools, and orchestration.",
        },
      ],
    });

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.answer).toContain("\n2.");
    expect(drafts[0]?.answer).toContain("\n3.");
    expect(drafts[0]?.explanation).toContain("\n2.");
    expect(drafts[0]?.explanation).toContain("\n3.");
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

  test("classifier skips truths when reranker returns a path outside the candidate set", async () => {
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
        sourceId: "https://example.com/react-hooks",
        statement: "Hooks 为什么依赖稳定调用顺序？",
        summary: "因为 React 依赖调用顺序定位状态槽位。",
        questionType: "open_ended",
        answer: "因为 React 依赖调用顺序定位状态槽位。",
        explanation: "这是 React Hooks 的底层约束之一。",
        evidenceQuote: "Hooks rely on call order.",
        confidence: 0.88,
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
          return {
            level1Id: "frontend",
            level2Id: "frontend.react",
            level3Id: "frontend.react.non-existent",
            reason: "invalid path",
          } as T;
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
