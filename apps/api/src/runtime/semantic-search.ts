import { cosineSimilarity } from "./embedder";
import type { EmbeddingService } from "./types";

type TruthVector = {
  id: string;
  statement: string;
  level3TagId: string;
  embedding: number[];
};

export type SemanticSearchStore = {
  listTruthVectors(): TruthVector[];
};

export class SemanticTruthSearchService {
  constructor(
    private readonly options: {
      embedder: EmbeddingService;
      store: SemanticSearchStore;
    },
  ) {}

  async search(query: string) {
    const [queryEmbedding] = await this.options.embedder.embed({
      texts: [query],
    });

    return this.options.store
      .listTruthVectors()
      .map((truth) => ({
        id: truth.id,
        statement: truth.statement,
        level3TagId: truth.level3TagId,
        score: Number(cosineSimilarity(queryEmbedding!, truth.embedding).toFixed(4)),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, 12);
  }
}
