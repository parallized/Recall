import type { SearchProviderKind, TaxonomyNode, TruthDraft } from "@recall/domain";

export type SearchHit = {
  title: string;
  url: string;
  snippet: string;
};

export type SourceDocument = SearchHit & {
  content: string;
};

export type SearchProvider = {
  kind: SearchProviderKind;
  search(input: { query: string; limit: number }): Promise<SearchHit[]>;
};

export type ChatJsonGateway = {
  generateJson<T>(input: {
    schemaName: string;
    system: string;
    user: string;
  }): Promise<T>;
};

export type EmbeddingService = {
  embed(input: { texts: string[] }): Promise<number[][]>;
};

export type SourceContentReader = {
  read(hit: SearchHit): Promise<SourceDocument>;
};

export type TaxonomyPlanner = {
  plan(input: { query: string; existingNodes: TaxonomyNode[] }): Promise<TaxonomyNode[]>;
};

export type TruthExtractor = {
  extract(input: { query: string; documents: SourceDocument[] }): Promise<TruthDraft[]>;
};
