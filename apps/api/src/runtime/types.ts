import type { SearchProviderKind, TaxonomyNode, TruthDraft } from "@recall/domain";

export type SearchHit = {
  title: string;
  url: string;
  snippet: string;
};

export type SourceDocument = SearchHit & {
  content: string;
};

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type CollectionProgressEvent =
  | {
      type: "phase";
      phase: "search" | "read" | "taxonomy" | "truths" | "classify" | "embed" | "persist";
      status: "start" | "complete";
      message: string;
      count?: number;
      provider?: SearchProviderKind;
    }
  | {
      type: "model";
      schemaName: string;
      channel: "reasoning" | "content";
      text: string;
    }
  | {
      type: "usage";
      scope: "search" | "ai";
      schemaName?: string;
      usage: TokenUsage;
      totals?: TokenUsage;
    };

export type ProgressReporter = (event: CollectionProgressEvent) => void | Promise<void>;

export type SearchProvider = {
  kind: SearchProviderKind;
  search(input: { query: string; limit: number; reporter?: ProgressReporter }): Promise<SearchHit[]>;
};

export type ChatJsonGateway = {
  generateJson<T>(input: {
    schemaName: string;
    system: string;
    user: string;
    reporter?: ProgressReporter;
  }): Promise<T>;
};

export type EmbeddingService = {
  embed(input: { texts: string[] }): Promise<number[][]>;
};

export type SourceContentReader = {
  read(hit: SearchHit): Promise<SourceDocument>;
};

export type TaxonomyPlanner = {
  plan(input: { query: string; existingNodes: TaxonomyNode[]; reporter?: ProgressReporter }): Promise<TaxonomyNode[]>;
};

export type TruthExtractor = {
  extract(input: { query: string; documents: SourceDocument[]; reporter?: ProgressReporter }): Promise<TruthDraft[]>;
};
