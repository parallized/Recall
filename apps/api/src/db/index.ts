import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  buildTagProgressSnapshot,
  rankRecommendations,
  type CollectionResult,
  type CollectedTruth,
  type RankedRecommendation,
  type TagProgressSnapshot,
  type TaxonomyNode,
  type UserLearningSignal,
} from "@recall/domain";

export interface KnowledgeStore {
  listTruths(): CollectedTruth[];
  listTagProgress(): TagProgressSnapshot[];
  listRecommendations(now: string): RankedRecommendation[];
  listTruthVectors(): Array<{ id: string; statement: string; level3TagId: string; embedding: number[] }>;
  getTaxonomy(): TaxonomyNode[];
  saveCollection(result: CollectionResult): CollectionResult;
  recordSignal(signal: UserLearningSignal): void;
  upsertTaxonomy(nodes: TaxonomyNode[]): void;
}

export const createSqlitePersistence = (databasePath: string): KnowledgeStore => {
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const db = new Database(databasePath, { create: true });
  
  // Clean initialization
  db.exec(`
    CREATE TABLE IF NOT EXISTS taxonomy_nodes (id TEXT PRIMARY KEY, parent_id TEXT, level INTEGER, name TEXT, description TEXT);
    CREATE TABLE IF NOT EXISTS collections (id TEXT PRIMARY KEY, query TEXT, provider TEXT, truth_count INTEGER, source_count INTEGER);
    CREATE TABLE IF NOT EXISTS truths (id TEXT PRIMARY KEY, statement TEXT, summary TEXT, evidence_quote TEXT, confidence REAL, source_url TEXT, level1_tag_id TEXT, level2_tag_id TEXT, level3_tag_id TEXT, embedding_json TEXT, collection_id TEXT);
    CREATE TABLE IF NOT EXISTS learning_signals (id INTEGER PRIMARY KEY AUTOINCREMENT, truth_id TEXT, mastery_delta REAL, happened_at TEXT);
  `);

  const readTruths = (): CollectedTruth[] =>
    db.query<CollectedTruth, []>(`SELECT id, statement, summary, evidence_quote AS evidenceQuote, confidence, source_url AS sourceUrl, level1_tag_id AS level1TagId, level2_tag_id AS level2TagId, level3_tag_id AS level3TagId FROM truths`).all();

  const readTaxonomy = (): TaxonomyNode[] =>
    db.query<TaxonomyNode, []>(`SELECT id, parent_id AS parentId, level, name, description FROM taxonomy_nodes`).all();

  const readSignals = (): UserLearningSignal[] =>
    db.query<UserLearningSignal, []>(`SELECT truth_id AS truthId, mastery_delta AS masteryDelta, happened_at AS happenedAt FROM learning_signals`).all();

  return {
    listTruths: readTruths,
    listTagProgress: () => buildTagProgressSnapshot({ taxonomy: readTaxonomy(), truths: readTruths(), signals: readSignals() }),
    listRecommendations: (now) => rankRecommendations({ 
      candidates: readTruths().map(t => ({ truthId: t.id, statement: t.statement, level3TagId: t.level3TagId })), 
      progress: buildTagProgressSnapshot({ 
        taxonomy: readTaxonomy(), 
        truths: readTruths(), 
        signals: readSignals() 
      }), 
      signals: readSignals(), 
      now 
    }),
    listTruthVectors: () => db.query<{id:string, statement:string, level3TagId:string, embeddingJson:string},[]>(`SELECT id, statement, level3_tag_id AS level3TagId, embedding_json AS embeddingJson FROM truths WHERE embedding_json IS NOT NULL`).all().map(t => ({...t, embedding: JSON.parse(t.embeddingJson)})),
    getTaxonomy: readTaxonomy,
    recordSignal: (s) => db.query(`INSERT INTO learning_signals (truth_id, mastery_delta, happened_at) VALUES (?, ?, ?)`).run(s.truthId, s.masteryDelta, s.happenedAt),
    upsertTaxonomy: (nodes) => {
      const q = db.query(`INSERT OR REPLACE INTO taxonomy_nodes (id, parent_id, level, name, description) VALUES (?, ?, ?, ?, ?)`);
      nodes.forEach(n => q.run(n.id, n.parentId, n.level, n.name, n.description));
    },
    saveCollection: (res) => {
      // Modularized save logic
      const upsertNode = db.query(`INSERT OR REPLACE INTO taxonomy_nodes (id, parent_id, level, name, description) VALUES (?, ?, ?, ?, ?)`);
      res.taxonomy.forEach(n => upsertNode.run(n.id, n.parentId, n.level, n.name, n.description));
      
      db.query(`INSERT OR REPLACE INTO collections (id, query, provider, truth_count, source_count) VALUES (?, ?, ?, ?, ?)`).run(res.collectionId, res.query, res.provider, res.truthCount, res.sourceCount);
      
      const upsertTruth = db.query(`INSERT OR REPLACE INTO truths (id, statement, summary, evidence_quote, confidence, source_url, level1_tag_id, level2_tag_id, level3_tag_id, embedding_json, collection_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      res.truths.forEach(t => upsertTruth.run(t.id, t.statement, t.summary, t.evidenceQuote, t.confidence, t.sourceUrl, t.level1TagId, t.level2TagId, t.level3TagId, t.embedding ? JSON.stringify(t.embedding) : null, res.collectionId));
      
      return res;
    }
  };
};
