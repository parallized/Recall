import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { TruthDraft } from "@recall/domain";

import type {
  CaptureJob,
  CaptureJobDetail,
  CaptureJobEvent,
  CaptureJobEventChannel,
  CaptureJobPhase,
  CaptureJobStatus,
  CaptureSource,
  CaptureSourceStatus,
  CreateCaptureJobInput,
  SourceCacheEntry,
  StoredTruthDraft,
} from "../runtime/capture-types";
import { emptyTokenUsage } from "../runtime/capture-types";
import type { SearchHit, TokenUsage } from "../runtime/types";

type CaptureJobRow = {
  id: string;
  query: string;
  provider: string;
  preferred_output_language: string | null;
  status: string;
  phase: string;
  search_limit: number;
  read_concurrency: number;
  ai_concurrency: number;
  discovered_source_count: number;
  pending_read_count: number;
  reading_count: number;
  pending_extract_count: number;
  extracting_count: number;
  completed_source_count: number;
  failed_source_count: number;
  truth_draft_count: number;
  truth_count: number;
  taxonomy_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  collection_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  deleted_at: string | null;
};

type CaptureSourceRow = {
  id: string;
  job_id: string;
  position: number;
  url: string;
  title: string;
  snippet: string;
  status: string;
  content_cached: number;
  truth_draft_count: number;
  read_attempt_count: number;
  extract_attempt_count: number;
  last_read_attempt_at: string | null;
  last_extract_attempt_at: string | null;
  next_retry_at: string | null;
  fetched_at: string | null;
  extracted_at: string | null;
  error: string | null;
};

type CaptureJobEventRow = {
  id: number;
  job_id: string;
  created_at: string;
  channel: string;
  label: string;
  text: string;
};

type SourceCacheRow = {
  url: string;
  title: string;
  snippet: string;
  content: string | null;
  fetched_at: string | null;
  error: string | null;
};

type TruthDraftRow = {
  id: string;
  job_id: string;
  source_url: string;
  statement: string;
  summary: string;
  question_type: string | null;
  options_json: string | null;
  answer: string | null;
  explanation: string | null;
  evidence_quote: string;
  confidence: number;
};

type JobMetricRow = {
  discoveredSourceCount: number | null;
  pendingReadCount: number | null;
  readingCount: number | null;
  pendingExtractCount: number | null;
  extractingCount: number | null;
  completedSourceCount: number | null;
  failedSourceCount: number | null;
};

const nowIso = () => new Date().toISOString();

const mapJobRow = (row: CaptureJobRow): CaptureJob => ({
  id: row.id,
  query: row.query,
  provider: row.provider as CaptureJob["provider"],
  preferredOutputLanguage: row.preferred_output_language ?? "zh-CN",
  status: row.status as CaptureJobStatus,
  phase: row.phase as CaptureJobPhase,
  searchLimit: row.search_limit,
  readConcurrency: row.read_concurrency,
  aiConcurrency: row.ai_concurrency,
  discoveredSourceCount: row.discovered_source_count,
  pendingReadCount: row.pending_read_count,
  readingCount: row.reading_count,
  pendingExtractCount: row.pending_extract_count,
  extractingCount: row.extracting_count,
  completedSourceCount: row.completed_source_count,
  failedSourceCount: row.failed_source_count,
  truthDraftCount: row.truth_draft_count,
  truthCount: row.truth_count,
  taxonomyCount: row.taxonomy_count,
  usage: {
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
  },
  collectionId: row.collection_id,
  lastError: row.last_error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
});

const mapSourceRow = (row: CaptureSourceRow): CaptureSource => ({
  id: row.id,
  jobId: row.job_id,
  position: row.position,
  url: row.url,
  title: row.title,
  snippet: row.snippet,
  status: row.status as CaptureSourceStatus,
  contentCached: row.content_cached === 1,
  truthDraftCount: row.truth_draft_count,
  readAttemptCount: row.read_attempt_count,
  extractAttemptCount: row.extract_attempt_count,
  lastReadAttemptAt: row.last_read_attempt_at,
  lastExtractAttemptAt: row.last_extract_attempt_at,
  nextRetryAt: row.next_retry_at,
  fetchedAt: row.fetched_at,
  extractedAt: row.extracted_at,
  error: row.error,
});

const mapEventRow = (row: CaptureJobEventRow): CaptureJobEvent => ({
  id: row.id,
  jobId: row.job_id,
  createdAt: row.created_at,
  channel: row.channel as CaptureJobEventChannel,
  label: row.label,
  text: row.text,
});

const mapSourceCacheRow = (row: SourceCacheRow): SourceCacheEntry => ({
  url: row.url,
  title: row.title,
  snippet: row.snippet,
  content: row.content,
  fetchedAt: row.fetched_at,
  error: row.error,
});

const mapTruthDraftRow = (row: TruthDraftRow): StoredTruthDraft => ({
  id: row.id,
  jobId: row.job_id,
  sourceId: row.source_url,
  statement: row.statement,
  summary: row.summary,
  questionType: row.question_type as StoredTruthDraft["questionType"],
  options: row.options_json ? JSON.parse(row.options_json) : undefined,
  answer: row.answer ?? undefined,
  explanation: row.explanation ?? undefined,
  evidenceQuote: row.evidence_quote,
  confidence: row.confidence,
});

export interface CaptureJobRepository {
  createJob(input: CreateCaptureJobInput): CaptureJob;
  listJobs(): CaptureJob[];
  getJob(jobId: string): CaptureJob | null;
  getJobDetail(jobId: string, eventLimit?: number): CaptureJobDetail | null;
  listResumableJobs(): CaptureJob[];
  deleteJob(jobId: string): boolean;
  updateJob(
    jobId: string,
    patch: {
      status?: CaptureJobStatus;
      phase?: CaptureJobPhase;
      readConcurrency?: number;
      aiConcurrency?: number;
      truthCount?: number;
      taxonomyCount?: number;
      collectionId?: string | null;
      lastError?: string | null;
      startedAt?: string | null;
      finishedAt?: string | null;
    },
  ): CaptureJob;
  appendEvent(jobId: string, input: { channel: CaptureJobEventChannel; label: string; text: string }): void;
  addUsage(jobId: string, usage: TokenUsage): CaptureJob;
  replaceSources(jobId: string, hits: SearchHit[]): CaptureSource[];
  listSources(jobId: string): CaptureSource[];
  updateSource(
    sourceId: string,
    patch: {
      position?: number;
      status?: CaptureSourceStatus;
      contentCached?: boolean;
      truthDraftCount?: number;
      readAttemptCount?: number;
      extractAttemptCount?: number;
      lastReadAttemptAt?: string | null;
      lastExtractAttemptAt?: string | null;
      nextRetryAt?: string | null;
      fetchedAt?: string | null;
      extractedAt?: string | null;
      error?: string | null;
    },
  ): CaptureSource;
  getSourceCache(url: string): SourceCacheEntry | null;
  upsertSourceCache(entry: SourceCacheEntry): SourceCacheEntry;
  replaceSourceTruthDrafts(jobId: string, sourceUrl: string, drafts: TruthDraft[]): void;
  listTruthDrafts(jobId: string): StoredTruthDraft[];
  refreshJobMetrics(jobId: string): CaptureJob;
}

export const createSqliteCaptureJobRepository = (databasePath: string): CaptureJobRepository => {
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const db = new Database(databasePath, { create: true });
  const ensureColumn = (table: string, column: string, definition: string) => {
    const columns = db
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .map((entry) => entry.name);

    if (!columns.includes(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  };

  db.exec(`
    CREATE TABLE IF NOT EXISTS capture_jobs (
      id TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      provider TEXT NOT NULL,
      preferred_output_language TEXT DEFAULT 'zh-CN',
      status TEXT NOT NULL,
      phase TEXT NOT NULL,
      search_limit INTEGER NOT NULL,
      read_concurrency INTEGER NOT NULL,
      ai_concurrency INTEGER NOT NULL,
      discovered_source_count INTEGER NOT NULL DEFAULT 0,
      pending_read_count INTEGER NOT NULL DEFAULT 0,
      reading_count INTEGER NOT NULL DEFAULT 0,
      pending_extract_count INTEGER NOT NULL DEFAULT 0,
      extracting_count INTEGER NOT NULL DEFAULT 0,
      completed_source_count INTEGER NOT NULL DEFAULT 0,
      failed_source_count INTEGER NOT NULL DEFAULT 0,
      truth_draft_count INTEGER NOT NULL DEFAULT 0,
      truth_count INTEGER NOT NULL DEFAULT 0,
      taxonomy_count INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      collection_id TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS capture_job_sources (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      snippet TEXT NOT NULL,
      status TEXT NOT NULL,
      content_cached INTEGER NOT NULL DEFAULT 0,
      truth_draft_count INTEGER NOT NULL DEFAULT 0,
      read_attempt_count INTEGER NOT NULL DEFAULT 0,
      extract_attempt_count INTEGER NOT NULL DEFAULT 0,
      last_read_attempt_at TEXT,
      last_extract_attempt_at TEXT,
      next_retry_at TEXT,
      fetched_at TEXT,
      extracted_at TEXT,
      error TEXT,
      UNIQUE(job_id, url)
    );
    CREATE TABLE IF NOT EXISTS capture_job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      channel TEXT NOT NULL,
      label TEXT NOT NULL,
      text TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS capture_job_truth_drafts (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      source_url TEXT NOT NULL,
      statement TEXT NOT NULL,
      summary TEXT NOT NULL,
      question_type TEXT,
      options_json TEXT,
      answer TEXT,
      explanation TEXT,
      evidence_quote TEXT NOT NULL,
      confidence REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_cache (
      url TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      snippet TEXT NOT NULL,
      content TEXT,
      fetched_at TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_capture_job_sources_job_id ON capture_job_sources (job_id);
    CREATE INDEX IF NOT EXISTS idx_capture_job_events_job_id ON capture_job_events (job_id);
    CREATE INDEX IF NOT EXISTS idx_capture_job_truth_drafts_job_id ON capture_job_truth_drafts (job_id);
  `);
  ensureColumn("capture_job_truth_drafts", "question_type", "TEXT");
  ensureColumn("capture_job_truth_drafts", "options_json", "TEXT");
  ensureColumn("capture_job_truth_drafts", "answer", "TEXT");
  ensureColumn("capture_job_truth_drafts", "explanation", "TEXT");
  ensureColumn("capture_job_sources", "read_attempt_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("capture_job_sources", "extract_attempt_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("capture_job_sources", "last_read_attempt_at", "TEXT");
  ensureColumn("capture_job_sources", "last_extract_attempt_at", "TEXT");
  ensureColumn("capture_job_sources", "next_retry_at", "TEXT");
  ensureColumn("capture_jobs", "preferred_output_language", "TEXT DEFAULT 'zh-CN'");
  ensureColumn("capture_jobs", "deleted_at", "TEXT");

  const insertJob = db.query(`
    INSERT INTO capture_jobs (
      id, query, provider, preferred_output_language, status, phase, search_limit, read_concurrency, ai_concurrency,
      prompt_tokens, completion_tokens, total_tokens, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectJob = db.query<CaptureJobRow, [string]>(`SELECT * FROM capture_jobs WHERE id = ? AND deleted_at IS NULL`);
  const selectStoredJob = db.query<CaptureJobRow, [string]>(`SELECT * FROM capture_jobs WHERE id = ?`);
  const listJobsQuery = db.query<CaptureJobRow, []>(
    `SELECT * FROM capture_jobs WHERE deleted_at IS NULL ORDER BY created_at DESC`,
  );
  const resumableJobsQuery = db.query<CaptureJobRow, []>(
    `SELECT * FROM capture_jobs WHERE deleted_at IS NULL AND status IN ('queued_search', 'searching', 'processing') ORDER BY created_at ASC`,
  );
  const softDeleteJob = db.query(`
    UPDATE capture_jobs
    SET deleted_at = ?, updated_at = ?, finished_at = COALESCE(finished_at, ?)
    WHERE id = ? AND deleted_at IS NULL
  `);
  const insertEvent = db.query(`
    INSERT INTO capture_job_events (job_id, created_at, channel, label, text) VALUES (?, ?, ?, ?, ?)
  `);
  const listEventsQuery = db.query<CaptureJobEventRow, [string, number]>(
    `SELECT * FROM capture_job_events WHERE job_id = ? ORDER BY id DESC LIMIT ?`,
  );
  const deleteJobSources = db.query(`DELETE FROM capture_job_sources WHERE job_id = ?`);
  const insertJobSource = db.query(`
    INSERT INTO capture_job_sources (
      id, job_id, position, url, title, snippet, status, content_cached, truth_draft_count,
      read_attempt_count, extract_attempt_count, last_read_attempt_at, last_extract_attempt_at, next_retry_at,
      fetched_at, extracted_at, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const listSourcesQuery = db.query<CaptureSourceRow, [string]>(
    `SELECT * FROM capture_job_sources WHERE job_id = ? ORDER BY position ASC`,
  );
  const selectCacheQuery = db.query<SourceCacheRow, [string]>(`SELECT * FROM source_cache WHERE url = ?`);
  const upsertCacheQuery = db.query(`
    INSERT INTO source_cache (url, title, snippet, content, fetched_at, error)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET
      title = excluded.title,
      snippet = excluded.snippet,
      content = excluded.content,
      fetched_at = excluded.fetched_at,
      error = excluded.error
  `);
  const deleteSourceTruthDrafts = db.query(`
    DELETE FROM capture_job_truth_drafts WHERE job_id = ? AND source_url = ?
  `);
  const insertSourceTruthDraft = db.query(`
    INSERT INTO capture_job_truth_drafts (
      id, job_id, source_url, statement, summary, question_type, options_json, answer, explanation, evidence_quote, confidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const listTruthDraftsQuery = db.query<TruthDraftRow, [string]>(
    `SELECT * FROM capture_job_truth_drafts WHERE job_id = ? ORDER BY rowid ASC`,
  );
  const sourceMetricsQuery = db.query<JobMetricRow, [string]>(`
    SELECT
      COUNT(*) AS discoveredSourceCount,
      SUM(CASE WHEN status = 'pending_read' THEN 1 ELSE 0 END) AS pendingReadCount,
      SUM(CASE WHEN status = 'reading' THEN 1 ELSE 0 END) AS readingCount,
      SUM(CASE WHEN status = 'pending_extract' THEN 1 ELSE 0 END) AS pendingExtractCount,
      SUM(CASE WHEN status = 'extracting' THEN 1 ELSE 0 END) AS extractingCount,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completedSourceCount,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedSourceCount
    FROM capture_job_sources
    WHERE job_id = ?
  `);
  const truthDraftCountQuery = db.query<{ count: number }, [string]>(
    `SELECT COUNT(*) AS count FROM capture_job_truth_drafts WHERE job_id = ?`,
  );

  const getJobOrThrow = (jobId: string) => {
    const row = selectStoredJob.get(jobId);

    if (!row) {
      throw new Error(`Capture job not found: ${jobId}`);
    }

    return mapJobRow(row);
  };

  const updateJobColumns = (jobId: string, patch: Record<string, unknown>) => {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);

    if (entries.length === 0) {
      return getJobOrThrow(jobId);
    }

    const setters = entries.map(([key]) => `${key} = ?`).join(", ");
    const statement = db.query(`UPDATE capture_jobs SET ${setters} WHERE id = ?`) as any;
    const values = entries.map(([, value]) => value);
    statement.run(...values, jobId);
    return getJobOrThrow(jobId);
  };

  const refreshJobMetrics = (jobId: string) => {
    const metrics = sourceMetricsQuery.get(jobId) ?? {
      discoveredSourceCount: 0,
      pendingReadCount: 0,
      readingCount: 0,
      pendingExtractCount: 0,
      extractingCount: 0,
      completedSourceCount: 0,
      failedSourceCount: 0,
    };
    const draftCount = truthDraftCountQuery.get(jobId)?.count ?? 0;

    return updateJobColumns(jobId, {
      discovered_source_count: metrics.discoveredSourceCount ?? 0,
      pending_read_count: metrics.pendingReadCount ?? 0,
      reading_count: metrics.readingCount ?? 0,
      pending_extract_count: metrics.pendingExtractCount ?? 0,
      extracting_count: metrics.extractingCount ?? 0,
      completed_source_count: metrics.completedSourceCount ?? 0,
      failed_source_count: metrics.failedSourceCount ?? 0,
      truth_draft_count: draftCount,
      updated_at: nowIso(),
    });
  };

  return {
    createJob(input) {
      const id = crypto.randomUUID();
      const createdAt = nowIso();
      const usage = emptyTokenUsage();

      insertJob.run(
        id,
        input.query,
        input.provider,
        input.preferredOutputLanguage ?? "zh-CN",
        "queued_search",
        "search",
        input.searchLimit,
        input.readConcurrency,
        input.aiConcurrency ?? 1,
        usage.promptTokens,
        usage.completionTokens,
        usage.totalTokens,
        createdAt,
        createdAt,
      );

      return getJobOrThrow(id);
    },
    listJobs() {
      return listJobsQuery.all().map(mapJobRow);
    },
    getJob(jobId) {
      const row = selectJob.get(jobId);
      return row ? mapJobRow(row) : null;
    },
    getJobDetail(jobId, eventLimit = 200) {
      const job = this.getJob(jobId);

      if (!job) {
        return null;
      }

      return {
        job,
        sources: this.listSources(jobId),
        events: listEventsQuery.all(jobId, eventLimit).reverse().map(mapEventRow),
        pendingItems: [],
        activeOperation: null,
      };
    },
    listResumableJobs() {
      return resumableJobsQuery.all().map(mapJobRow);
    },
    deleteJob(jobId) {
      const deletedAt = nowIso();
      const result = softDeleteJob.run(deletedAt, deletedAt, deletedAt, jobId) as { changes?: number };
      return (result.changes ?? 0) > 0;
    },
    updateJob(jobId, patch) {
      return updateJobColumns(jobId, {
        status: patch.status,
        phase: patch.phase,
        read_concurrency: patch.readConcurrency,
        ai_concurrency: patch.aiConcurrency,
        truth_count: patch.truthCount,
        taxonomy_count: patch.taxonomyCount,
        collection_id: patch.collectionId,
        last_error: patch.lastError,
        started_at: patch.startedAt,
        finished_at: patch.finishedAt,
        updated_at: nowIso(),
      });
    },
    appendEvent(jobId, input) {
      insertEvent.run(jobId, nowIso(), input.channel, input.label, input.text);
    },
    addUsage(jobId, usage) {
      db.query(`
        UPDATE capture_jobs
        SET
          prompt_tokens = prompt_tokens + ?,
          completion_tokens = completion_tokens + ?,
          total_tokens = total_tokens + ?,
          updated_at = ?
        WHERE id = ?
      `).run(usage.promptTokens, usage.completionTokens, usage.totalTokens, nowIso(), jobId);

      return getJobOrThrow(jobId);
    },
    replaceSources(jobId, hits) {
      db.transaction(() => {
        deleteJobSources.run(jobId);

        hits.forEach((hit, index) => {
          const cache = selectCacheQuery.get(hit.url);
          insertJobSource.run(
            crypto.randomUUID(),
            jobId,
            index,
            hit.url,
            hit.title,
            hit.snippet,
            "pending_read",
            cache?.content ? 1 : 0,
            0,
            0,
            0,
            null,
            null,
            null,
            cache?.fetched_at ?? null,
            null,
            null,
          );
          upsertCacheQuery.run(
            hit.url,
            hit.title,
            hit.snippet,
            cache?.content ?? null,
            cache?.fetched_at ?? null,
            cache?.error ?? null,
          );
        });
      })();

      refreshJobMetrics(jobId);
      return this.listSources(jobId);
    },
    listSources(jobId) {
      return listSourcesQuery.all(jobId).map(mapSourceRow);
    },
    updateSource(sourceId, patch) {
      const entries = Object.entries({
        position: patch.position,
        status: patch.status,
        content_cached: patch.contentCached === undefined ? undefined : Number(patch.contentCached),
        truth_draft_count: patch.truthDraftCount,
        read_attempt_count: patch.readAttemptCount,
        extract_attempt_count: patch.extractAttemptCount,
        last_read_attempt_at: patch.lastReadAttemptAt,
        last_extract_attempt_at: patch.lastExtractAttemptAt,
        next_retry_at: patch.nextRetryAt,
        fetched_at: patch.fetchedAt,
        extracted_at: patch.extractedAt,
        error: patch.error,
      }).filter(([, value]) => value !== undefined);

      if (entries.length > 0) {
        const setters = entries.map(([key]) => `${key} = ?`).join(", ");
        const statement = db.query(`UPDATE capture_job_sources SET ${setters} WHERE id = ?`) as any;
        const values = entries.map(([, value]) => value);
        statement.run(...values, sourceId);
      }

      const row = db.query<CaptureSourceRow, [string]>(`SELECT * FROM capture_job_sources WHERE id = ?`).get(sourceId);

      if (!row) {
        throw new Error(`Capture source not found: ${sourceId}`);
      }

      refreshJobMetrics(row.job_id);
      return mapSourceRow(row);
    },
    getSourceCache(url) {
      const row = selectCacheQuery.get(url);
      return row ? mapSourceCacheRow(row) : null;
    },
    upsertSourceCache(entry) {
      upsertCacheQuery.run(entry.url, entry.title, entry.snippet, entry.content, entry.fetchedAt, entry.error);
      const row = selectCacheQuery.get(entry.url);

      if (!row) {
        throw new Error(`Source cache not found after upsert: ${entry.url}`);
      }

      return mapSourceCacheRow(row);
    },
    replaceSourceTruthDrafts(jobId, sourceUrl, drafts) {
      db.transaction(() => {
        deleteSourceTruthDrafts.run(jobId, sourceUrl);

        drafts.forEach((draft) => {
          insertSourceTruthDraft.run(
            crypto.randomUUID(),
            jobId,
            sourceUrl,
            draft.statement,
            draft.summary,
            draft.questionType ?? null,
            draft.options ? JSON.stringify(draft.options) : null,
            draft.answer ?? null,
            draft.explanation ?? null,
            draft.evidenceQuote,
            draft.confidence,
          );
        });
      })();

      refreshJobMetrics(jobId);
    },
    listTruthDrafts(jobId) {
      return listTruthDraftsQuery.all(jobId).map(mapTruthDraftRow);
    },
    refreshJobMetrics,
  };
};
