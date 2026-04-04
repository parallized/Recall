export type OutputLanguage = "zh-CN" | "en-US" | "ja-JP";

export const DEFAULT_OUTPUT_LANGUAGE: OutputLanguage = "zh-CN";
export const OUTPUT_LANGUAGE_STORAGE_KEY = "recall.preferred-output-language";

export const OUTPUT_LANGUAGE_OPTIONS: Array<{
  value: OutputLanguage;
  label: string;
  description: string;
}> = [
  {
    value: "zh-CN",
    label: "简体中文",
    description: "推荐：搜索优先英文，知识卡片回写中文。",
  },
  {
    value: "en-US",
    label: "English",
    description: "Cards, tags, and explanations are written in English.",
  },
  {
    value: "ja-JP",
    label: "日本語",
    description: "Cards and visible knowledge are written in Japanese.",
  },
];

export const getOutputLanguageLabel = (value?: string | null) =>
  OUTPUT_LANGUAGE_OPTIONS.find((option) => option.value === value)?.label ?? value ?? "简体中文";

export const readStoredOutputLanguage = () => {
  if (typeof window === "undefined") {
    return DEFAULT_OUTPUT_LANGUAGE;
  }

  const storedValue = window.localStorage.getItem(OUTPUT_LANGUAGE_STORAGE_KEY);
  const matched = OUTPUT_LANGUAGE_OPTIONS.find((option) => option.value === storedValue);
  return matched?.value ?? DEFAULT_OUTPUT_LANGUAGE;
};
