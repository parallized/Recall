import { describe, expect, test } from "bun:test";

import {
  buildTagProgressSnapshot,
  deduplicateTruths,
  rankRecommendations,
  selectBestTagPath,
  type RecommendationCandidate,
  type TagAssignmentCandidate,
  type TagProgressSnapshot,
  type TaxonomyNode,
  type TruthDraft,
  type UserLearningSignal,
} from "../src/index";

const taxonomy: TaxonomyNode[] = [
  {
    id: "engineering",
    parentId: null,
    level: 1,
    name: "Software Engineering",
    description: "Programming, software architecture, delivery, and operations.",
  },
  {
    id: "frontend",
    parentId: "engineering",
    level: 2,
    name: "Frontend Engineering",
    description: "UI runtime, browser rendering, and client application design.",
  },
  {
    id: "react",
    parentId: "frontend",
    level: 3,
    name: "React",
    description: "Component architecture, rendering, hooks, and app state.",
  },
  {
    id: "backend",
    parentId: "engineering",
    level: 2,
    name: "Backend Engineering",
    description: "APIs, data access, infrastructure, and services.",
  },
  {
    id: "databases",
    parentId: "backend",
    level: 3,
    name: "Databases",
    description: "Transactions, indexes, schema design, and persistence.",
  },
];

describe("knowledge-core", () => {
  test("selects the strongest three-level taxonomy path", () => {
    const candidateScores: TagAssignmentCandidate[] = [
      { nodeId: "engineering", score: 0.95 },
      { nodeId: "frontend", score: 0.92 },
      { nodeId: "react", score: 0.97 },
      { nodeId: "backend", score: 0.41 },
      { nodeId: "databases", score: 0.33 },
    ];

    expect(selectBestTagPath(taxonomy, candidateScores)).toEqual({
      level1Id: "engineering",
      level2Id: "frontend",
      level3Id: "react",
      score: 0.946667,
    });
  });

  test("deduplicates truth drafts by semantic fingerprint and keeps stronger evidence", () => {
    const drafts: TruthDraft[] = [
      {
        sourceId: "s1",
        statement: "React state updates are asynchronous and batched during the same event.",
        summary: "State updates are batched.",
        evidenceQuote: "React batches multiple state updates inside one event loop turn.",
        confidence: 0.78,
      },
      {
        sourceId: "s2",
        statement: "React state updates are asynchronous & batched in a single event.",
        summary: "Same concept with stronger quote.",
        evidenceQuote: "Multiple setState calls within one event are batched together before commit.",
        confidence: 0.91,
      },
      {
        sourceId: "s3",
        statement: "SQLite uses a single-writer model with database-level locking semantics.",
        summary: "SQLite allows one writer at a time.",
        evidenceQuote: "SQLite coordinates writes via a single writer lock.",
        confidence: 0.88,
      },
    ];

    expect(deduplicateTruths(drafts)).toEqual([
      {
        sourceId: "s2",
        statement: "React state updates are asynchronous & batched in a single event.",
        summary: "Same concept with stronger quote.",
        evidenceQuote: "Multiple setState calls within one event are batched together before commit.",
        confidence: 0.91,
      },
      {
        sourceId: "s3",
        statement: "SQLite uses a single-writer model with database-level locking semantics.",
        summary: "SQLite allows one writer at a time.",
        evidenceQuote: "SQLite coordinates writes via a single writer lock.",
        confidence: 0.88,
      },
    ]);
  });

  test("builds tag progress from truth mastery signals", () => {
    const progress = buildTagProgressSnapshot({
      taxonomy,
      truths: [
        { id: "t1", statement: "React renders from state.", level3TagId: "react" },
        { id: "t2", statement: "Hooks must preserve call order.", level3TagId: "react" },
        { id: "t3", statement: "Indexes speed up WHERE lookups.", level3TagId: "databases" },
      ],
      signals: [
        { truthId: "t1", masteryDelta: 0.7, happenedAt: "2026-03-21T08:00:00.000Z" },
        { truthId: "t2", masteryDelta: 0.5, happenedAt: "2026-03-22T08:00:00.000Z" },
        { truthId: "t3", masteryDelta: 0.2, happenedAt: "2026-03-23T08:00:00.000Z" },
      ],
    });

    expect(progress).toEqual<TagProgressSnapshot[]>([
      {
        nodeId: "engineering",
        nodeName: "Software Engineering",
        level: 1,
        truthCount: 3,
        masteredTruthCount: 0,
        progress: 0.466667,
      },
      {
        nodeId: "frontend",
        nodeName: "Frontend Engineering",
        level: 2,
        truthCount: 2,
        masteredTruthCount: 0,
        progress: 0.6,
      },
      {
        nodeId: "react",
        nodeName: "React",
        level: 3,
        truthCount: 2,
        masteredTruthCount: 0,
        progress: 0.6,
      },
      {
        nodeId: "backend",
        nodeName: "Backend Engineering",
        level: 2,
        truthCount: 1,
        masteredTruthCount: 0,
        progress: 0.2,
      },
      {
        nodeId: "databases",
        nodeName: "Databases",
        level: 3,
        truthCount: 1,
        masteredTruthCount: 0,
        progress: 0.2,
      },
    ]);
  });

  test("ranks recommendations toward low-progress tags with overdue review bias", () => {
    const progress: TagProgressSnapshot[] = [
      {
        nodeId: "react",
        nodeName: "React",
        level: 3,
        truthCount: 2,
        masteredTruthCount: 0,
        progress: 0.6,
      },
      {
        nodeId: "databases",
        nodeName: "Databases",
        level: 3,
        truthCount: 1,
        masteredTruthCount: 0,
        progress: 0.2,
      },
    ];

    const learningSignals: UserLearningSignal[] = [
      { truthId: "t1", masteryDelta: 0.7, happenedAt: "2026-03-31T08:00:00.000Z" },
      { truthId: "t2", masteryDelta: 0.2, happenedAt: "2026-03-20T08:00:00.000Z" },
      { truthId: "t3", masteryDelta: 0.0, happenedAt: "2026-03-05T08:00:00.000Z" },
    ];

    const candidates: RecommendationCandidate[] = [
      {
        truthId: "t1",
        statement: "React renders from state.",
        level3TagId: "react",
      },
      {
        truthId: "t2",
        statement: "Hooks must preserve call order.",
        level3TagId: "react",
      },
      {
        truthId: "t3",
        statement: "Indexes speed up WHERE lookups.",
        level3TagId: "databases",
      },
    ];

    expect(
      rankRecommendations({
        candidates,
        progress,
        signals: learningSignals,
        now: "2026-04-01T08:00:00.000Z",
      }),
    ).toEqual([
      {
        truthId: "t3",
        statement: "Indexes speed up WHERE lookups.",
        level3TagId: "databases",
        score: 1,
      },
      {
        truthId: "t2",
        statement: "Hooks must preserve call order.",
        level3TagId: "react",
        score: 0.7,
      },
      {
        truthId: "t1",
        statement: "React renders from state.",
        level3TagId: "react",
        score: 0.52,
      },
    ]);
  });
});
