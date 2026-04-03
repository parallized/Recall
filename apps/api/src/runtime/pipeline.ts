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
import type {
  ChatJsonGateway,
  EmbeddingService,
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

export class AiTaxonomyPlanner implements TaxonomyPlanner {
  constructor(private readonly gateway: ChatJsonGateway) {}

  async plan(input: { query: string; existingNodes: TaxonomyNode[] }): Promise<TaxonomyNode[]> {
    const existingSummary = input.existingNodes
      .slice(0, 50)
      .map((node) => `${node.level}:${node.id}:${node.name}`)
      .join("\n");

    const payload = await this.gateway.generateJson<TaxonomyBlueprint>({
      schemaName: "taxonomy_blueprint",
      system: [
        "You design three-level learning taxonomies for atomic truth extraction systems.",
        "Return a taxonomy focused on learning progression rather than encyclopedic breadth.",
        "The output must contain exactly one level1 node, 4-6 level2 nodes, and 3-5 level3 nodes per level2 node.",
      ].join("\n"),
      user: [
        `Topic query: ${input.query}`,
        "Produce a JSON object with keys level1 and level2.",
        'level1 = {"name":"","description":""}',
        'level2 = [{"name":"","description":"","children":[{"name":"","description":""}]}]',
        "Avoid duplicating existing nodes when the same semantic concept already exists.",
        `Existing nodes:\n${existingSummary || "none"}`,
      ].join("\n\n"),
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

  async extract(input: { query: string; documents: SourceDocument[] }): Promise<TruthDraft[]> {
    const drafts: TruthDraft[] = [];

    for (const document of chunkDocuments(input.documents)) {
      const payload = await this.gateway.generateJson<ExtractedTruthPayload>({
        schemaName: "truth_list",
        system: [
          "You extract atomic truths from source material for deliberate learning systems.",
          "Each truth must be a standalone factual claim that can be reviewed, tagged, and recommended.",
          "Only keep claims directly grounded in the supplied source text.",
          "Confidence must be between 0 and 1.",
        ].join("\n"),
        user: [
          `Topic query: ${input.query}`,
          `Source title: ${document.title}`,
          `Source URL: ${document.url}`,
          `Source snippet: ${document.snippet}`,
          "Return JSON with the shape {\"truths\":[{\"statement\":\"\",\"summary\":\"\",\"evidenceQuote\":\"\",\"confidence\":0.0}]}",
          "Extract 4 to 8 high-value truths. Quotes must be copied from the source text exactly as evidence.",
          `Source text:\n${document.content}`,
        ].join("\n\n"),
      });

      for (const truth of payload.truths) {
        drafts.push({
          sourceId: document.url,
          statement: truth.statement,
          summary: truth.summary,
          evidenceQuote: truth.evidenceQuote,
          confidence: truth.confidence,
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
  }): Promise<Array<Pick<CollectedTruth, "level1TagId" | "level2TagId" | "level3TagId">>> {
    const nodeEmbeddings = await this.options.embedder.embed({
      texts: input.taxonomy.map(nodeDescriptor),
    });
    const truthEmbeddings = await this.options.embedder.embed({
      texts: input.truths.map((truth) => `${truth.statement}\n${truth.summary}`),
    });

    const classifications: Array<Pick<CollectedTruth, "level1TagId" | "level2TagId" | "level3TagId">> = [];

    for (const [truthIndex, truth] of input.truths.entries()) {
      const candidateScores: TagAssignmentCandidate[] = input.taxonomy.map((node, nodeIndex) => ({
        nodeId: node.id,
        score: Math.max(cosineSimilarity(truthEmbeddings[truthIndex]!, nodeEmbeddings[nodeIndex]!), 0),
      }));

      const topPaths = buildCandidatePaths(input.taxonomy, candidateScores).slice(0, 5);

      const reranked = await this.options.gateway.generateJson<RerankedPath>({
        schemaName: "reranked_tag_path",
        system: [
          "You rerank candidate taxonomy paths for atomic truths.",
          "Choose exactly one path from the supplied candidates.",
          "The chosen path must be semantically precise and educationally actionable.",
        ].join("\n"),
        user: [
          `Truth statement: ${truth.statement}`,
          `Truth summary: ${truth.summary}`,
          `Evidence: ${truth.evidenceQuote}`,
          "Return JSON with keys level1Id, level2Id, level3Id, reason.",
          `Candidate paths:\n${topPaths
            .map(
              (path) =>
                `- ${path.label} | ids=${path.level1Id},${path.level2Id},${path.level3Id} | score=${path.score.toFixed(4)}\n${path.description}`,
            )
            .join("\n\n")}`,
        ].join("\n\n"),
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

      classifications.push({
        level1TagId: matchedCandidate.level1Id,
        level2TagId: matchedCandidate.level2Id,
        level3TagId: matchedCandidate.level3Id,
      });
    }

    return classifications;
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
  }): Promise<CollectionResult> {
    const provider = this.options.providers.find((candidate) => candidate.kind === input.provider);

    if (!provider) {
      throw new Error(`Search provider not configured: ${input.provider}`);
    }

    const searchHits = await provider.search({
      query: input.query,
      limit: 5,
    });

    const readableDocuments = (
      await Promise.allSettled(searchHits.map((hit) => this.options.sourceReader.read(hit)))
    )
      .flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
      .slice(0, 5);

    if (readableDocuments.length === 0) {
      throw new Error("Unable to extract any readable source documents from search results.");
    }

    const existingTaxonomy = this.options.taxonomyStore.getTaxonomy();
    const plannedTaxonomy = await this.options.taxonomyPlanner.plan({
      query: input.query,
      existingNodes: existingTaxonomy,
    });
    const taxonomy = mergeTaxonomy(existingTaxonomy, plannedTaxonomy);
    const truthDrafts = deduplicateTruths(
      await this.options.truthExtractor.extract({
        query: input.query,
        documents: readableDocuments,
      }),
    );

    if (truthDrafts.length === 0) {
      throw new Error("Truth extraction returned zero atomic truths.");
    }

    const tagAssignments = await this.options.tagClassifier.classify({
      truths: truthDrafts,
      taxonomy,
    });
    const embeddings = await this.options.embedder.embed({
      texts: truthDrafts.map((truth) => `${truth.statement}\n${truth.summary}`),
    });

    const truths: CollectedTruth[] = truthDrafts.map((truth, index) => ({
      id: crypto.randomUUID(),
      statement: truth.statement,
      summary: truth.summary,
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
