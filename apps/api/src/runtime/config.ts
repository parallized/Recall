export type RuntimeConfig = {
  port: number;
  aiBaseUrl?: string;
  aiApiKey?: string;
  aiChatModel?: string;
  grokBaseUrl?: string;
  grokApiKey?: string;
  grokModel?: string;
  webSearchApiUrl?: string;
  webSearchApiKey?: string;
  databasePath: string;
  embeddingModel: string;
};

const isPlaceholderValue = (value: string) =>
  value.trim().length === 0 ||
  value === "replace_me" ||
  value.includes("your-web-search-adapter.example.com");

const readOptionalEnv = (name: string) => {
  const value = Bun.env[name];

  if (!value || isPlaceholderValue(value)) {
    return undefined;
  }

  return value;
};

export const loadRuntimeConfig = (): RuntimeConfig => ({
  port: Number(Bun.env.PORT ?? "4174"),
  aiBaseUrl: readOptionalEnv("AI_BASE_URL") ?? "https://ai.huan666.de/v1",
  aiApiKey: readOptionalEnv("AI_API_KEY"),
  aiChatModel: readOptionalEnv("AI_CHAT_MODEL") ?? "grok-4.1-fast",
  grokBaseUrl: readOptionalEnv("GROK_BASE_URL") ?? readOptionalEnv("AI_BASE_URL") ?? "https://ai.huan666.de/v1",
  grokApiKey: readOptionalEnv("GROK_API_KEY") ?? readOptionalEnv("AI_API_KEY"),
  grokModel: readOptionalEnv("GROK_MODEL") ?? "grok-4.20-beta",
  webSearchApiUrl: readOptionalEnv("WEB_SEARCH_API_URL"),
  webSearchApiKey: readOptionalEnv("WEB_SEARCH_API_KEY"),
  databasePath: Bun.env.DB_PATH ?? "./data/recall.sqlite",
  embeddingModel: Bun.env.EMBEDDING_MODEL ?? "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
});
