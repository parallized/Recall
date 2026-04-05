import {
  deduplicateTruths,
  type CollectionResult,
  type CollectedTruth,
  type SearchProviderKind,
  type TagAssignmentCandidate,
  type TaxonomyNode,
  type TruthDraft,
} from "@recall/domain";

import { cosineSimilarity } from "./embedder";
import {
  buildPreferredOutputInstruction,
  describePreferredOutputLanguage,
} from "./output-language";
import { buildStudySearchQuery } from "./search";
import type {
  ChatJsonGateway,
  EmbeddingService,
  ProgressReporter,
  SearchProvider,
  SourceContentReader,
  SourceDocument,
  TaxonomyPlanner,
  TruthExtractor,
} from "./types";

type TaxonomyBlueprint = {
  level1: {
    name: string;
    description: string;
  };
  level2: Array<{
    name: string;
    description: string;
    children: Array<{
      name: string;
      description: string;
    }>;
  }>;
};

type ExtractedTruthPayload = {
  truths: Array<{
    statement: string;
    summary: string;
    questionType?: "multiple_choice" | "open_ended";
    options?: string[];
    answer?: string;
    explanation?: string;
    evidenceQuote: string;
    confidence: number;
  }>;
};

type RerankedPath = {
  level1Id: string;
  level2Id: string;
  level3Id: string;
  reason: string;
};

type KnowledgeTaxonomyStore = {
  getTaxonomy(): TaxonomyNode[];
};

export type TruthClassificationResult = {
  truths: TruthDraft[];
  assignments: Array<Pick<CollectedTruth, "level1TagId" | "level2TagId" | "level3TagId">>;
  strippedTruthCount: number;
};

const toNodeId = (parentId: string | null, name: string) => {
  const slug = name
    .trim()
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");

  return parentId ? `${parentId}.${slug}` : slug;
};

const nodeDescriptor = (node: TaxonomyNode) => `${node.name}\n${node.description}`;
const truthDescriptor = (truth: Pick<TruthDraft, "statement" | "summary" | "answer" | "explanation" | "options">) =>
  [
    truth.statement,
    truth.summary,
    truth.answer ?? "",
    truth.explanation ?? "",
    truth.options?.join("\n") ?? "",
  ]
    .filter(Boolean)
    .join("\n");

const chunkDocuments = (documents: SourceDocument[]) =>
  documents.map((document) => ({
    ...document,
    content: document.content.slice(0, 6000),
  }));

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

const runWithConcurrencyLimit = async (
  total: number,
  concurrency: number,
  worker: (index: number) => Promise<void>,
) => {
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, total));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < total) {
        const current = cursor;
        cursor += 1;
        await worker(current);
      }
    }),
  );
};

const isSensitiveWordsError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("sensitive_words_detected");
};

const contextDependentTruthPatterns = [
  /(?:本文|本章|本节|本页|本站|本教程|本课程|本系列|上文|下文|见上文|见下文|该文|该文章|这篇文章|这篇教程|如下图|上图|下图)/,
  /\b(?:this article|this guide|this tutorial|this chapter|this section|this page|our site|our guide|the above|the following)\b/i,
  /第[一二三四五六七八九十百千万0-9]+章/,
  /第[一二三四五六七八九十百千万0-9]+节/,
  /(?:哪些章节|哪几个章节|哪一章|哪几章|哪一节|哪几节|哪一页|哪几页)/,
  /《[^》]*(?:学习笔记|面经|八股|题解|教程|指南|课程|手册)[^》]*》/,
  /(?:使用《[^》]+》时|阅读本文时|看这篇文章时|在本站|在本教程中)/,
  /\b(?:when using|while reading) (?:this|the)\b/i,
];

const timeSensitiveTruthPatterns = [
  /(?:截至|截止到|截止|目前|当前|现阶段|最近|近期|最新|本周|本月|今年|明年|季度|Q[1-4]|赛季|活动期间|限时)/i,
  /\b(?:as of|currently|latest|recent|this week|this month|this year|next year|quarter|seasonal|limited-time)\b/i,
  /(?:版本答案|补丁答案|补丁改动|版本改动|版本最强|当前版本|当前环境|meta|tier list|patch\s*\d)/i,
];

const limitedScopeTruthPatterns = [
  /(?:只适合|仅适合|适用于.*?(?:同学|候选人|公司|团队|岗位|场景)|针对.*?(?:同学|新人|应届生|社招|校招|转岗))/,
  /(?:应届生|社招|校招|毕业[一二三四五六七八九十0-9]+年内|转岗新人|特定公司|某公司面试)/,
  /(?:我的经验|个人经验|作者建议|这位作者|博主建议|up主建议|阿秀的学习笔记|某公司内推|某团队内部)/,
  /\b(?:for fresh graduates|for campus hires|for experienced hires|for this company|for our team|my notes|personal notes)\b/i,
];

const normalizeMarkdownLists = (content?: string | null) => {
  if (!content) {
    return content;
  }

  return content
    .replace(/\r\n/g, "\n")
    .replace(/([^\n])\s+((?:\d+\.|[-*])\s*)/g, "$1\n$2")
    .trim();
};

const normalizeTruthDraftText = <
  T extends Pick<ExtractedTruthPayload["truths"][number], "answer" | "explanation">
>(
  truth: T,
) => ({
  ...truth,
  answer: normalizeMarkdownLists(truth.answer),
  explanation: normalizeMarkdownLists(truth.explanation),
});

const isContextDependentTruth = (
  truth: Pick<ExtractedTruthPayload["truths"][number], "statement" | "summary" | "answer" | "explanation">,
) => {
  const combined = [truth.statement, truth.summary, truth.answer ?? "", truth.explanation ?? ""]
    .filter(Boolean)
    .join("\n");

  return contextDependentTruthPatterns.some((pattern) => pattern.test(combined));
};

const isTimeSensitiveTruth = (
  truth: Pick<ExtractedTruthPayload["truths"][number], "statement" | "summary" | "answer" | "explanation">,
) => {
  const combined = [truth.statement, truth.summary, truth.answer ?? "", truth.explanation ?? ""]
    .filter(Boolean)
    .join("\n");

  return timeSensitiveTruthPatterns.some((pattern) => pattern.test(combined));
};

const isLimitedScopeTruth = (
  truth: Pick<ExtractedTruthPayload["truths"][number], "statement" | "summary" | "answer" | "explanation">,
) => {
  const combined = [truth.statement, truth.summary, truth.answer ?? "", truth.explanation ?? ""]
    .filter(Boolean)
    .join("\n");

  return limitedScopeTruthPatterns.some((pattern) => pattern.test(combined));
};

export const normalizeTruthClassificationResult = (
  truths: TruthDraft[],
  result:
    | TruthClassificationResult
    | Array<Pick<CollectedTruth, "level1TagId" | "level2TagId" | "level3TagId">>,
): TruthClassificationResult =>
  Array.isArray(result)
    ? {
        truths,
        assignments: result,
        strippedTruthCount: 0,
      }
    : result;

export class AiTaxonomyPlanner implements TaxonomyPlanner {
  constructor(private readonly gateway: ChatJsonGateway) {}

  async plan(input: {
    query: string;
    existingNodes: TaxonomyNode[];
    preferredOutputLanguage?: string;
    reporter?: ProgressReporter;
  }): Promise<TaxonomyNode[]> {
    const existingLevel1Summary = input.existingNodes
      .filter((node) => node.level === 1)
      .slice(0, 20)
      .map((node) => `- ${node.name}: ${node.description}`)
      .join("\n");
    const existingSummary = input.existingNodes
      .slice(0, 50)
      .map((node) => `${node.level}:${node.id}:${node.name} | ${node.description}`)
      .join("\n");

    const payload = await this.gateway.generateJson<TaxonomyBlueprint>({
      schemaName: "taxonomy_blueprint",
      system: [
        "You design three-level learning taxonomies for question-bank memorization systems.",
        "Return a taxonomy focused on interview-style recall and learning progression rather than encyclopedic breadth.",
        "The output must contain exactly one level1 node, 4-6 level2 nodes, and 3-5 level3 nodes per level2 node.",
        "Level1 must be a short human knowledge domain such as AI Agent, Game Design, Frontend Engineering, or World of Warcraft.",
        "Do not use a raw topic title, search query, article title, or temporary campaign name as the level1 node.",
        "Before creating a new level1 or level2 branch, compare against the existing taxonomy and reuse the closest matching human category whenever it already fits.",
        "Keep the exact spelling of any reused node name so the system can append into the existing branch instead of creating duplicates.",
        "Only create the minimum missing branch when the existing taxonomy truly lacks the concept.",
        buildPreferredOutputInstruction(input.preferredOutputLanguage),
      ].join("\n"),
      user: [
        `Topic query: ${input.query}`,
        `Preferred output language: ${describePreferredOutputLanguage(input.preferredOutputLanguage)}.`,
        "Produce a JSON object with keys level1 and level2.",
        'level1 = {"name":"","description":""}',
        'level2 = [{"name":"","description":"","children":[{"name":"","description":""}]}]',
        "Use a create-and-append or append-only mindset: prefer extending the existing taxonomy instead of inventing parallel branches.",
        "Avoid duplicating existing nodes when the same semantic concept already exists.",
        `Existing level1 tags to reuse when possible:\n${existingLevel1Summary || "none"}`,
        `Existing nodes:\n${existingSummary || "none"}`,
      ].join("\n\n"),
      reporter: input.reporter,
    });

    const level1Id = toNodeId(null, payload.level1.name);
    const nodes: TaxonomyNode[] = [
      {
        id: level1Id,
        parentId: null,
        level: 1,
        name: payload.level1.name,
        description: payload.level1.description,
      },
    ];

    for (const level2 of payload.level2) {
      const level2Id = toNodeId(level1Id, level2.name);
      nodes.push({
        id: level2Id,
        parentId: level1Id,
        level: 2,
        name: level2.name,
        description: level2.description,
      });

      for (const level3 of level2.children) {
        nodes.push({
          id: toNodeId(level2Id, level3.name),
          parentId: level2Id,
          level: 3,
          name: level3.name,
          description: level3.description,
        });
      }
    }

    return nodes;
  }
}

export class AiTruthExtractor implements TruthExtractor {
  constructor(private readonly gateway: ChatJsonGateway) {}

  async extract(input: {
    query: string;
    documents: SourceDocument[];
    preferredOutputLanguage?: string;
    reporter?: ProgressReporter;
  }): Promise<TruthDraft[]> {
    const drafts: TruthDraft[] = [];

    for (const document of chunkDocuments(input.documents)) {
      let payload: ExtractedTruthPayload;

      try {
        payload = await this.gateway.generateJson<ExtractedTruthPayload>({
          schemaName: "truth_list",
          system: [
            "You convert source material into interview-style study questions for deliberate memorization systems.",
            "Each item must be a standalone question-answer card that helps a learner practice recall.",
            "Prefer question-bank style prompts when the source already contains questions; otherwise synthesize high-quality questions from the source.",
            "Every card must stay directly grounded in the supplied source text.",
            "statement = the question stem shown to the learner.",
            "summary = a short standard answer for quick review.",
            "questionType must be either multiple_choice or open_ended.",
            "For multiple_choice, provide 3-5 plausible options and set answer to the exact correct option text.",
            "For open_ended, omit options and set answer to the canonical answer.",
            "answer and explanation may use concise GitHub-flavored Markdown when it improves clarity.",
            "Use headings, bullet lists, tables, or mermaid class diagrams only when they materially help the learner understand a relational concept.",
            "If answer or explanation contains a list, every bullet or numbered item must be on its own line in valid Markdown.",
            "Never compress multiple items into one paragraph like '1.xxx 2.xxx 3.xxx'.",
            "explanation should explain why the answer is correct or what key points must be recalled.",
            "Only keep cards that are self-contained, evergreen, and broadly reusable for a learner who has not opened the original source.",
            "Reject cards whose meaning depends on source-local context such as this article, this chapter, the above section, chapter numbers, or a named personal note/guide/playbook.",
            "Reject cards that are mainly time-sensitive, patch-sensitive, season-sensitive, event-limited, or likely to expire quickly.",
            "Reject cards aimed at a narrow audience, one company, one person's workflow, or one short-lived scenario unless the source clearly states an enduring general principle.",
            "Do not repair missing context by inventing or filling in assumptions. If the source does not provide enough standalone context, drop the card.",
            "Confidence must be between 0 and 1.",
            buildPreferredOutputInstruction(input.preferredOutputLanguage),
          ].join("\n"),
          user: [
            `Topic query: ${input.query}`,
            `Preferred output language: ${describePreferredOutputLanguage(input.preferredOutputLanguage)}.`,
            `Source title: ${document.title}`,
            `Source URL: ${document.url}`,
            `Source snippet: ${document.snippet}`,
            "Return JSON with the shape {\"truths\":[{\"statement\":\"\",\"summary\":\"\",\"questionType\":\"open_ended\",\"options\":[],\"answer\":\"\",\"explanation\":\"\",\"evidenceQuote\":\"\",\"confidence\":0.0}]}",
            "Extract 4 to 8 high-value study questions. Questions should resemble computer interview prep, quiz practice, or deliberate recall prompts.",
            "If the source is not already a question bank, derive questions from the densest, most testable concepts in the source.",
            "Keep statement, summary, answer, explanation, and user-facing option text in the preferred output language.",
            "Reject source-specific recommendation cards such as which chapter of a named note to read, what this article suggests focusing on, or advice tied to one person's notes.",
            "Reject cards that depend on current rankings, current pricing, current policies, current patch notes, or current best picks unless the durable principle itself is clearly stated in the source.",
            "Prefer durable fundamentals over fast-changing tactics.",
            "Quotes must be copied from the source text exactly as evidence.",
            `Source text:\n${document.content}`,
          ].join("\n\n"),
          reporter: input.reporter,
        });
      } catch (error) {
        if (isSensitiveWordsError(error)) {
          continue;
        }

        throw error;
      }

      for (const truth of payload.truths) {
        const normalizedTruth = normalizeTruthDraftText(truth);

        if (
          isContextDependentTruth(normalizedTruth) ||
          isTimeSensitiveTruth(normalizedTruth) ||
          isLimitedScopeTruth(normalizedTruth)
        ) {
          continue;
        }

        drafts.push({
          sourceId: document.url,
          statement: normalizedTruth.statement,
          summary: normalizedTruth.summary,
          questionType: normalizedTruth.questionType,
          options: normalizedTruth.options,
          answer: normalizedTruth.answer,
          explanation: normalizedTruth.explanation,
          evidenceQuote: normalizedTruth.evidenceQuote,
          confidence: normalizedTruth.confidence,
        });
      }
    }

    return drafts;
  }
}

const buildCandidatePaths = (taxonomy: TaxonomyNode[], candidates: TagAssignmentCandidate[]) => {
  const scoreById = new Map(candidates.map((candidate) => [candidate.nodeId, candidate.score]));
  const nodesById = new Map(taxonomy.map((node) => [node.id, node]));
  const level1Nodes = taxonomy.filter((node) => node.level === 1);
  const childrenByParent = new Map<string, TaxonomyNode[]>();

  for (const node of taxonomy) {
    if (!node.parentId) {
      continue;
    }

    const children = childrenByParent.get(node.parentId) ?? [];
    children.push(node);
    childrenByParent.set(node.parentId, children);
  }

  return level1Nodes
    .flatMap((level1) =>
      (childrenByParent.get(level1.id) ?? []).flatMap((level2) =>
        (childrenByParent.get(level2.id) ?? []).map((level3) => ({
          level1Id: level1.id,
          level2Id: level2.id,
          level3Id: level3.id,
          label: `${level1.name} > ${level2.name} > ${level3.name}`,
          description: [
            nodeDescriptor(level1),
            nodeDescriptor(level2),
            nodeDescriptor(level3),
          ].join("\n\n"),
          score:
            ((scoreById.get(level1.id) ?? 0) +
              (scoreById.get(level2.id) ?? 0) +
              (scoreById.get(level3.id) ?? 0)) /
            3,
        })),
      ),
    )
    .sort((left, right) => right.score - left.score)
    .map((path) => ({
      ...path,
      nodes: [nodesById.get(path.level1Id)!, nodesById.get(path.level2Id)!, nodesById.get(path.level3Id)!],
    }));
};

export class HybridHierarchicalTagClassifier {
  constructor(
    private readonly options: {
      gateway: ChatJsonGateway;
      embedder: EmbeddingService;
    },
  ) {}

  async classify(input: {
    truths: TruthDraft[];
    taxonomy: TaxonomyNode[];
    aiConcurrency?: number;
    preferredOutputLanguage?: string;
    reporter?: ProgressReporter;
    onTruthStart?: (input: { truth: TruthDraft; index: number; total: number }) => void | Promise<void>;
  }): Promise<TruthClassificationResult> {
    const nodeEmbeddings = await this.options.embedder.embed({
      texts: input.taxonomy.map(nodeDescriptor),
    });
    const truthEmbeddings = await this.options.embedder.embed({
      texts: input.truths.map(truthDescriptor),
    });

    const results = new Array<{
      truth: TruthDraft;
      assignment: Pick<CollectedTruth, "level1TagId" | "level2TagId" | "level3TagId">;
    } | null>(input.truths.length).fill(null);

    await runWithConcurrencyLimit(input.truths.length, input.aiConcurrency ?? 1, async (truthIndex) => {
      const truth = input.truths[truthIndex]!;

      await input.onTruthStart?.({
        truth,
        index: truthIndex,
        total: input.truths.length,
      });

      const candidateScores: TagAssignmentCandidate[] = input.taxonomy.map((node, nodeIndex) => ({
        nodeId: node.id,
        score: Math.max(cosineSimilarity(truthEmbeddings[truthIndex]!, nodeEmbeddings[nodeIndex]!), 0),
      }));

      const topPaths = buildCandidatePaths(input.taxonomy, candidateScores).slice(0, 5);

      try {
        const reranked = await this.options.gateway.generateJson<RerankedPath>({
          schemaName: "reranked_tag_path",
          system: [
            "You rerank candidate taxonomy paths for question-answer study cards.",
            "Choose exactly one path from the supplied candidates.",
            "The chosen path must be semantically precise and useful for memorizing interview-style questions.",
            buildPreferredOutputInstruction(input.preferredOutputLanguage),
          ].join("\n"),
          user: [
            `Preferred output language: ${describePreferredOutputLanguage(input.preferredOutputLanguage)}.`,
            `Question stem: ${truth.statement}`,
            `Short answer: ${truth.summary}`,
            `Canonical answer: ${truth.answer ?? truth.summary}`,
            `Explanation: ${truth.explanation ?? ""}`,
            `Evidence: ${truth.evidenceQuote}`,
            "Return JSON with keys level1Id, level2Id, level3Id, reason.",
            `Candidate paths:\n${topPaths
              .map(
                (path) =>
                  `- ${path.label} | ids=${path.level1Id},${path.level2Id},${path.level3Id} | score=${path.score.toFixed(4)}\n${path.description}`,
              )
              .join("\n\n")}`,
          ].join("\n\n"),
          reporter: input.reporter,
        });

        const matchedCandidate = topPaths.find(
          (path) =>
            path.level1Id === reranked.level1Id &&
            path.level2Id === reranked.level2Id &&
            path.level3Id === reranked.level3Id,
        );

        if (!matchedCandidate) {
          throw new Error("LLM reranker returned a taxonomy path outside the provided candidate set.");
        }

        results[truthIndex] = {
          truth,
          assignment: {
            level1TagId: matchedCandidate.level1Id,
            level2TagId: matchedCandidate.level2Id,
            level3TagId: matchedCandidate.level3Id,
          },
        };
      } catch {
        results[truthIndex] = null;
      }
    });

    const classifiedTruths: TruthDraft[] = [];
    const classifications: Array<Pick<CollectedTruth, "level1TagId" | "level2TagId" | "level3TagId">> = [];

    for (const result of results) {
      if (!result) {
        continue;
      }

      classifiedTruths.push(result.truth);
      classifications.push(result.assignment);
    }

    return {
      truths: classifiedTruths,
      assignments: classifications,
      strippedTruthCount: input.truths.length - classifiedTruths.length,
    };
  }
}

export class KnowledgeCollectionOrchestrator {
  constructor(
    private readonly options: {
      providers: SearchProvider[];
      sourceReader: SourceContentReader;
      taxonomyPlanner: TaxonomyPlanner;
      truthExtractor: TruthExtractor;
      tagClassifier: HybridHierarchicalTagClassifier;
      embedder: EmbeddingService;
      taxonomyStore: KnowledgeTaxonomyStore;
    },
  ) {}

  async collect(input: {
    query: string;
    provider: SearchProviderKind;
    preferredOutputLanguage?: string;
    reporter?: ProgressReporter;
  }): Promise<CollectionResult> {
    const provider = this.options.providers.find((candidate) => candidate.kind === input.provider);

    if (!provider) {
      throw new Error(`Search provider not configured: ${input.provider}`);
    }

    await input.reporter?.({
      type: "phase",
      phase: "search",
      status: "start",
      message: `Starting ${input.provider} search.`,
      provider: input.provider,
    });

    const searchHits = await provider.search({
      query:
        provider.kind === "web-search-api"
          ? buildStudySearchQuery(input.query, input.preferredOutputLanguage)
          : input.query,
      limit: 5,
      preferredOutputLanguage: input.preferredOutputLanguage,
      reporter: input.reporter,
    });

    await input.reporter?.({
      type: "phase",
      phase: "search",
      status: "complete",
      message: `Search returned ${searchHits.length} hits.`,
      count: searchHits.length,
      provider: input.provider,
    });

    await input.reporter?.({
      type: "phase",
      phase: "read",
      status: "start",
      message: "Reading and simplifying source pages.",
    });

    const readableDocuments = (
      await Promise.allSettled(searchHits.map((hit) => this.options.sourceReader.read(hit)))
    )
      .flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
      .slice(0, 5);

    await input.reporter?.({
      type: "phase",
      phase: "read",
      status: "complete",
      message: `Prepared ${readableDocuments.length} readable documents.`,
      count: readableDocuments.length,
    });

    if (readableDocuments.length === 0) {
      throw new Error("Unable to extract any readable source documents from search results.");
    }

    const existingTaxonomy = this.options.taxonomyStore.getTaxonomy();
    await input.reporter?.({
      type: "phase",
      phase: "taxonomy",
      status: "start",
      message: "Planning the three-level taxonomy.",
    });
    const plannedTaxonomy = await this.options.taxonomyPlanner.plan({
      query: input.query,
      existingNodes: existingTaxonomy,
      preferredOutputLanguage: input.preferredOutputLanguage,
      reporter: input.reporter,
    });
    await input.reporter?.({
      type: "phase",
      phase: "taxonomy",
      status: "complete",
      message: `Generated ${plannedTaxonomy.length} taxonomy nodes.`,
      count: plannedTaxonomy.length,
    });
    const taxonomy = mergeTaxonomy(existingTaxonomy, plannedTaxonomy);

    await input.reporter?.({
      type: "phase",
      phase: "truths",
      status: "start",
      message: "Extracting interview-style study questions from source documents.",
    });
    const truthDrafts = deduplicateTruths(
      await this.options.truthExtractor.extract({
        query: input.query,
        documents: readableDocuments,
        preferredOutputLanguage: input.preferredOutputLanguage,
        reporter: input.reporter,
      }),
    );
    await input.reporter?.({
      type: "phase",
      phase: "truths",
      status: "complete",
      message: `Extracted ${truthDrafts.length} question-answer drafts.`,
      count: truthDrafts.length,
    });

    if (truthDrafts.length === 0) {
      throw new Error("Question extraction returned zero study cards.");
    }

    await input.reporter?.({
      type: "phase",
      phase: "classify",
      status: "start",
      message: "Binding each study question to one taxonomy path.",
    });
    const classification = normalizeTruthClassificationResult(
      truthDrafts,
      await this.options.tagClassifier.classify({
        truths: truthDrafts,
        taxonomy,
        preferredOutputLanguage: input.preferredOutputLanguage,
        reporter: input.reporter,
      }),
    );
    const classifiedTruths = classification.truths;
    const tagAssignments = classification.assignments;
    await input.reporter?.({
      type: "phase",
      phase: "classify",
      status: "complete",
      message: `Classified ${tagAssignments.length} question assignments.${classification.strippedTruthCount > 0 ? ` Stripped ${classification.strippedTruthCount} moderated items.` : ""}`,
      count: tagAssignments.length,
    });

    if (classifiedTruths.length === 0) {
      throw new Error("All study questions were stripped during taxonomy classification.");
    }

    await input.reporter?.({
      type: "phase",
      phase: "embed",
      status: "start",
      message: "Embedding study questions for semantic search and recall.",
    });
    const embeddings = await this.options.embedder.embed({
      texts: classifiedTruths.map(truthDescriptor),
    });
    await input.reporter?.({
      type: "phase",
      phase: "embed",
      status: "complete",
      message: `Embedded ${embeddings.length} study questions.`,
      count: embeddings.length,
    });

    const truths: CollectedTruth[] = classifiedTruths.map((truth, index) => ({
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

    return {
      collectionId: crypto.randomUUID(),
      query: input.query,
      provider: input.provider,
      truthCount: truths.length,
      sourceCount: readableDocuments.length,
      taxonomy: plannedTaxonomy,
      truths,
    };
  }
}
