import { t } from "elysia";

export const collectionIdSchema = t.String();
export const truthIdSchema = t.String();

export const taxonomyNodeSchema = t.Object({
  id: t.String(),
  parentId: t.Nullable(t.String()),
  level: t.Number(),
  name: t.String(),
  description: t.String(),
});

export const collectionResultSchemaExtended = t.Object({
  collectionId: t.String(),
  query: t.String(),
  provider: t.String(),
  truthCount: t.Number(),
  sourceCount: t.Number(),
});

export const learningSignalSchema = t.Object({
  truthId: t.String(),
  masteryDelta: t.Number({ minimum: 0, maximum: 1 }),
  happenedAt: t.String(),
});
