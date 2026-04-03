import { pipeline } from "@xenova/transformers";

import type { EmbeddingService } from "./types";

type FeatureExtractor = Awaited<ReturnType<typeof pipeline>>;

export class LocalTransformersEmbeddingService implements EmbeddingService {
  private extractorPromise: Promise<FeatureExtractor> | undefined;

  constructor(private readonly model: string) {}

  async embed(input: { texts: string[] }): Promise<number[][]> {
    const extractor = await this.getExtractor();
    const embeddings: number[][] = [];

    for (const text of input.texts) {
      const tensor = (await (extractor as any)(text, {
        pooling: "mean",
        normalize: true,
      })) as {
        data: Float32Array | number[];
      };

      embeddings.push(Array.from(tensor.data));
    }

    return embeddings;
  }

  private getExtractor() {
    this.extractorPromise ??= pipeline("feature-extraction", this.model);
    return this.extractorPromise;
  }
}

export const cosineSimilarity = (left: number[], right: number[]) => {
  let dotProduct = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index += 1) {
    dotProduct += left[index]! * right[index]!;
    leftMagnitude += left[index]! * left[index]!;
    rightMagnitude += right[index]! * right[index]!;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
};
