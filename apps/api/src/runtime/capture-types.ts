import type { SearchProviderKind, TruthDraft } from "@recall/domain";

import type { SearchHit, SourceDocument, TokenUsage } from "./types";

export type CaptureJobPhase = "idle" | "search" | "read" | "truths" | "taxonomy" | "classify" | "embed" | "persist";
export type CaptureJobStatus = "queued_search" | "searching" | "ready_to_read" | "processing" | "completed" | "failed";
export type CaptureSourceStatus = "pending_read" | "reading" | "pending_extract" | "extracting" | "completed" | "failed";
export type CaptureJobEventChannel = "status" | "error";
export type CapturePendingItemKind = "source" | "truth";
export type CapturePendingItemStatus =
  | "discovering_sources"
  | "waiting_to_read"
  | "reading_source"
  | "waiting_to_extract"
  | "extracting_questions"
  | "waiting_for_classify"
  | "waiting_for_finalize"
  | "planning_taxonomy"
  | "classifying_question"
  | "classified_waiting_for_embed"
  | "embedding_question"
  | "embedded_waiting_for_persist"
  | "persisting_question"
  | "blocked_after_failure"
  | "failed_read"
  | "failed_extract";

export type CaptureFailureKind = "sensitive_content" | "jina_reader" | "generic";

export type CaptureJob = {
  id: string;
  query: string;
  provider: SearchProviderKind;
  preferredOutputLanguage: string;
  status: CaptureJobStatus;
  phase: CaptureJobPhase;
  searchLimit: number;
  readConcurrency: number;
  aiConcurrency: number;
  discoveredSourceCount: number;
  pendingReadCount: number;
  readingCount: number;
  pendingExtractCount: number;
  extractingCount: number;
  completedSourceCount: number;
  failedSourceCount: number;
  truthDraftCount: number;
  truthCount: number;
  taxonomyCount: number;
  usage: TokenUsage;
  collectionId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type CaptureSource = {
  id: string;
  jobId: string;
  position: number;
  url: string;
  title: string;
  snippet: string;
  status: CaptureSourceStatus;
  contentCached: boolean;
  truthDraftCount: number;
  readAttemptCount: number;
  extractAttemptCount: number;
  lastReadAttemptAt: string | null;
  lastExtractAttemptAt: string | null;
  nextRetryAt: string | null;
  fetchedAt: string | null;
  extractedAt: string | null;
  error: string | null;
  failureKind?: CaptureFailureKind | null;
  failureLabel?: string | null;
  skipped?: boolean;
};

export type CaptureJobEvent = {
  id: number;
  jobId: string;
  createdAt: string;
  channel: CaptureJobEventChannel;
  label: string;
  text: string;
};

export type CapturePendingItem = {
  id: string;
  kind: CapturePendingItemKind;
  position: number;
  title: string;
  subtitle: string;
  status: CapturePendingItemStatus;
  sourceUrl: string | null;
  sourceTitle: string | null;
  error: string | null;
  failureKind?: CaptureFailureKind | null;
  failureLabel?: string | null;
  skipped?: boolean;
};

export type CaptureActiveOperation = {
  itemId: string | null;
  kind: CapturePendingItemKind | "job";
  status: CapturePendingItemStatus;
  title: string;
  subtitle: string;
  detail: string;
  progressCurrent: number | null;
  progressTotal: number | null;
  startedAt: string;
};

export type CaptureJobDetail = {
  job: CaptureJob;
  sources: CaptureSource[];
  events: CaptureJobEvent[];
  pendingItems: CapturePendingItem[];
  activeOperation: CaptureActiveOperation | null;
};

export type SourceCacheEntry = {
  url: string;
  title: string;
  snippet: string;
  content: string | null;
  fetchedAt: string | null;
  error: string | null;
};

export type CreateCaptureJobInput = {
  query: string;
  provider: SearchProviderKind;
  searchLimit: number;
  readConcurrency: number;
  preferredOutputLanguage?: string;
};

export type StartCaptureProcessingInput = {
  jobId: string;
  readConcurrency: number;
};

export type QueuedDocument = {
  source: CaptureSource;
  document: SourceDocument;
};

export type StoredTruthDraft = TruthDraft & {
  id: string;
  jobId: string;
};

export const emptyTokenUsage = (): TokenUsage => ({
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
});

export const toSourceDocument = (hit: SearchHit, cached: SourceCacheEntry): SourceDocument => ({
  ...hit,
  title: cached.title || hit.title,
  content: cached.content ?? "",
});
