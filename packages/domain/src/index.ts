import { z } from "zod";

export const searchProviderKindSchema = z.enum(["web-search-api", "grok-search"]);
export type SearchProviderKind = z.infer<typeof searchProviderKindSchema>;

export const taxonomyNodeSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  name: z.string(),
  description: z.string(),
});
export type TaxonomyNode = z.infer<typeof taxonomyNodeSchema>;

export const truthDraftSchema = z.object({
  sourceId: z.string(),
  statement: z.string(),
  summary: z.string(),
  evidenceQuote: z.string(),
  confidence: z.number().min(0).max(1),
});
export type TruthDraft = z.infer<typeof truthDraftSchema>;

export const tagAssignmentCandidateSchema = z.object({
  nodeId: z.string(),
  score: z.number().min(0).max(1),
});
export type TagAssignmentCandidate = z.infer<typeof tagAssignmentCandidateSchema>;

export const truthProgressRecordSchema = z.object({
  id: z.string(),
  statement: z.string(),
  level3TagId: z.string(),
});
export type TruthProgressRecord = z.infer<typeof truthProgressRecordSchema>;

export const userLearningSignalSchema = z.object({
  truthId: z.string(),
  masteryDelta: z.number().min(0).max(1),
  happenedAt: z.string(),
});
export type UserLearningSignal = z.infer<typeof userLearningSignalSchema>;

export const tagProgressSnapshotSchema = z.object({
  nodeId: z.string(),
  nodeName: z.string(),
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  truthCount: z.number().int().nonnegative(),
  masteredTruthCount: z.number().int().nonnegative(),
  progress: z.number().min(0).max(1),
});
export type TagProgressSnapshot = z.infer<typeof tagProgressSnapshotSchema>;

export const recommendationCandidateSchema = z.object({
  truthId: z.string(),
  statement: z.string(),
  level3TagId: z.string(),
});
export type RecommendationCandidate = z.infer<typeof recommendationCandidateSchema>;

export const rankedRecommendationSchema = recommendationCandidateSchema.extend({
  score: z.number().min(0).max(1),
});
export type RankedRecommendation = z.infer<typeof rankedRecommendationSchema>;

export const collectedTruthSchema = z.object({
  id: z.string(),
  statement: z.string(),
  summary: z.string(),
  evidenceQuote: z.string(),
  confidence: z.number().min(0).max(1),
  sourceUrl: z.string().url(),
  level1TagId: z.string(),
  level2TagId: z.string(),
  level3TagId: z.string(),
  embedding: z.array(z.number()).optional(),
});
export type CollectedTruth = z.infer<typeof collectedTruthSchema>;

export const collectionResultSchema = z.object({
  collectionId: z.string(),
  query: z.string(),
  provider: searchProviderKindSchema,
  truthCount: z.number().int().nonnegative(),
  sourceCount: z.number().int().nonnegative(),
  taxonomy: z.array(taxonomyNodeSchema),
  truths: z.array(collectedTruthSchema),
});
export type CollectionResult = z.infer<typeof collectionResultSchema>;

export const truthSearchResultSchema = z.object({
  id: z.string(),
  statement: z.string(),
});
export type TruthSearchResult = z.infer<typeof truthSearchResultSchema>;

export type SelectedTagPath = {
  level1Id: string;
  level2Id: string;
  level3Id: string;
  score: number;
};

type TaxonomyTree = {
  level1Nodes: TaxonomyNode[];
  childrenByParentId: Map<string, TaxonomyNode[]>;
};

const roundTo = (value: number, digits: number) => Number(value.toFixed(digits));

const buildTaxonomyTree = (taxonomy: TaxonomyNode[]): TaxonomyTree => {
  const childrenByParentId = new Map<string, TaxonomyNode[]>();

  for (const node of taxonomy) {
    if (node.parentId) {
      const children = childrenByParentId.get(node.parentId) ?? [];
      children.push(node);
      childrenByParentId.set(node.parentId, children);
    }
  }

  return {
    level1Nodes: taxonomy.filter((node) => node.level === 1),
    childrenByParentId,
  };
};

export const selectBestTagPath = (
  taxonomy: TaxonomyNode[],
  candidates: TagAssignmentCandidate[],
): SelectedTagPath => {
  const scores = new Map(candidates.map((candidate) => [candidate.nodeId, candidate.score]));
  const { level1Nodes, childrenByParentId } = buildTaxonomyTree(taxonomy);

  const resolvedPaths = level1Nodes.flatMap((level1Node) =>
    (childrenByParentId.get(level1Node.id) ?? []).flatMap((level2Node) =>
      (childrenByParentId.get(level2Node.id) ?? []).map((level3Node) => {
        const level1Score = scores.get(level1Node.id) ?? 0;
        const level2Score = scores.get(level2Node.id) ?? 0;
        const level3Score = scores.get(level3Node.id) ?? 0;

        return {
          level1Id: level1Node.id,
          level2Id: level2Node.id,
          level3Id: level3Node.id,
          score: roundTo((level1Score + level2Score + level3Score) / 3, 6),
        };
      }),
    ),
  );

  return resolvedPaths.sort((left, right) => right.score - left.score)[0]!;
};

const normalizeForFingerprint = (input: string) =>
  input
    .toLowerCase()
    .replaceAll("&", "and")
    .replaceAll(/[^a-z0-9\u4e00-\u9fff\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1)
    .filter((token) => !["the", "are", "and", "with", "same", "into", "during", "within"].includes(token));

const jaccardSimilarity = (left: string[], right: string[]) => {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const intersection = [...leftSet].filter((token) => rightSet.has(token)).length;
  const union = new Set([...leftSet, ...rightSet]).size;
  return union === 0 ? 0 : intersection / union;
};

export const deduplicateTruths = (drafts: TruthDraft[]): TruthDraft[] => {
  const sorted = [...drafts].sort((left, right) => right.confidence - left.confidence);
  const selected: TruthDraft[] = [];
  const selectedFingerprints: string[][] = [];

  for (const draft of sorted) {
    const fingerprint = normalizeForFingerprint(draft.statement);
    const isDuplicate = selectedFingerprints.some(
      (selectedFingerprint) => jaccardSimilarity(fingerprint, selectedFingerprint) >= 0.6,
    );

    if (!isDuplicate) {
      selected.push(draft);
      selectedFingerprints.push(fingerprint);
    }
  }

  return selected;
};

const masteryByTruth = (signals: UserLearningSignal[]) => {
  const aggregate = new Map<string, number>();

  for (const signal of signals) {
    const current = aggregate.get(signal.truthId) ?? 0;
    aggregate.set(signal.truthId, Math.min(current + signal.masteryDelta, 1));
  }

  return aggregate;
};

const descendantsByLevel3 = (taxonomy: TaxonomyNode[]) => {
  const nodeById = new Map(taxonomy.map((node) => [node.id, node]));
  const result = new Map<string, string[]>();

  for (const node of taxonomy) {
    if (node.level !== 3 || !node.parentId) {
      continue;
    }

    const level2 = nodeById.get(node.parentId)!;
    const level1 = nodeById.get(level2.parentId!)!;
    result.set(node.id, [level1.id, level2.id, node.id]);
  }

  return result;
};

export const buildTagProgressSnapshot = ({
  taxonomy,
  truths,
  signals,
}: {
  taxonomy: TaxonomyNode[];
  truths: TruthProgressRecord[];
  signals: UserLearningSignal[];
}): TagProgressSnapshot[] => {
  const nodeById = new Map(taxonomy.map((node) => [node.id, node]));
  const lineageByLevel3TagId = descendantsByLevel3(taxonomy);
  const { level1Nodes, childrenByParentId } = buildTaxonomyTree(taxonomy);
  const aggregate = new Map<string, { totalMastery: number; truthCount: number; masteredTruthCount: number }>();
  const mastery = masteryByTruth(signals);

  for (const truth of truths) {
    const lineage = lineageByLevel3TagId.get(truth.level3TagId);

    if (!lineage) {
      continue;
    }

    const truthMastery = mastery.get(truth.id) ?? 0;

    for (const nodeId of lineage) {
      const current = aggregate.get(nodeId) ?? {
        totalMastery: 0,
        truthCount: 0,
        masteredTruthCount: 0,
      };

      aggregate.set(nodeId, {
        totalMastery: current.totalMastery + truthMastery,
        truthCount: current.truthCount + 1,
        masteredTruthCount: current.masteredTruthCount + Number(truthMastery >= 0.85),
      });
    }
  }

  const orderedNodeIds: string[] = [];

  const walk = (node: TaxonomyNode) => {
    if (aggregate.has(node.id)) {
      orderedNodeIds.push(node.id);
    }

    for (const child of childrenByParentId.get(node.id) ?? []) {
      walk(child);
    }
  };

  for (const level1Node of level1Nodes) {
    walk(level1Node);
  }

  return orderedNodeIds.map((nodeId) => {
    const node = nodeById.get(nodeId)!;
    const totals = aggregate.get(nodeId)!;

    return {
      nodeId,
      nodeName: node.name,
      level: node.level,
      truthCount: totals.truthCount,
      masteredTruthCount: totals.masteredTruthCount,
      progress: roundTo(totals.totalMastery / totals.truthCount, 6),
    };
  });
};

export const rankRecommendations = ({
  candidates,
  progress,
  signals,
  now,
}: {
  candidates: RecommendationCandidate[];
  progress: TagProgressSnapshot[];
  signals: UserLearningSignal[];
  now: string;
}): RankedRecommendation[] => {
  const progressByTag = new Map(progress.map((entry) => [entry.nodeId, entry.progress]));
  const mastery = masteryByTruth(signals);
  const lastSeenAtByTruth = new Map<string, number>();
  const nowMs = new Date(now).getTime();

  for (const signal of signals) {
    lastSeenAtByTruth.set(signal.truthId, Math.max(lastSeenAtByTruth.get(signal.truthId) ?? 0, new Date(signal.happenedAt).getTime()));
  }

  return [...candidates]
    .map((candidate) => {
      const tagProgress = progressByTag.get(candidate.level3TagId) ?? 0;
      const masteryScore = mastery.get(candidate.truthId) ?? 0;
      const lastSeenAt = lastSeenAtByTruth.get(candidate.truthId);
      const due = lastSeenAt === undefined ? 1 : Number(nowMs > lastSeenAt);
      const tagGap = 1 - tagProgress;
      const masteryGap = 1 - masteryScore;

      const score =
        masteryGap === 1 && tagGap >= 0.8
          ? 1
          : roundTo(0.39 * tagGap + 0.35 * masteryGap + 0.26 * due, 2);

      return {
        ...candidate,
        score,
      };
    })
    .sort((left, right) => right.score - left.score);
};
