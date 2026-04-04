export const defaultPreferredOutputLanguage = "zh-CN";

const languageMetadata = {
  "zh-CN": {
    label: "Simplified Chinese",
    localizedSearchTerms: ["题库", "面试题", "问答", "练习题", "教程", "指南"],
  },
  "en-US": {
    label: "English",
    localizedSearchTerms: [],
  },
  "ja-JP": {
    label: "Japanese",
    localizedSearchTerms: ["問題集", "面接質問", "Q&A", "練習問題", "チュートリアル", "ガイド"],
  },
} as const;

type KnownLanguageCode = keyof typeof languageMetadata;

export const normalizePreferredOutputLanguage = (value?: string | null) => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : defaultPreferredOutputLanguage;
};

export const describePreferredOutputLanguage = (value?: string | null) => {
  const normalized = normalizePreferredOutputLanguage(value);
  return languageMetadata[normalized as KnownLanguageCode]?.label ?? normalized;
};

export const getPreferredSearchKeywords = (value?: string | null) => {
  const normalized = normalizePreferredOutputLanguage(value);
  return languageMetadata[normalized as KnownLanguageCode]?.localizedSearchTerms ?? [];
};

export const buildPreferredOutputInstruction = (value?: string | null) => {
  const normalized = normalizePreferredOutputLanguage(value);
  const languageLabel = describePreferredOutputLanguage(normalized);

  return [
    `All user-visible output must be written in ${languageLabel}.`,
    "This includes taxonomy names, taxonomy descriptions, question stems, summaries, answers, explanations, and user-facing tags.",
    "Keep evidence quotes in the source language when quoting the source verbatim.",
  ].join(" ");
};

export const buildPreferredSearchStrategyInstruction = (value?: string | null) => {
  const normalized = normalizePreferredOutputLanguage(value);
  const languageLabel = describePreferredOutputLanguage(normalized);

  return [
    "Prefer English-language search results first because they are usually denser and fresher.",
    `If strong English sources are insufficient, add high-quality results in ${languageLabel}.`,
    "Source pages may be in any language, but downstream study cards must still follow the preferred output language.",
  ].join(" ");
};
