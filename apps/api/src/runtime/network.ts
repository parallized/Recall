const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const isRetriableNetworkError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  return (
    normalized.includes("unknown certificate verification error") ||
    normalized.includes("certificate verification") ||
    normalized.includes("tls") ||
    normalized.includes("socket") ||
    normalized.includes("econnreset") ||
    normalized.includes("timed out") ||
    normalized.includes("timeout") ||
    normalized.includes("network") ||
    normalized.includes("fetch failed")
  );
};

export const retryAsync = async <T>(input: {
  attempts: number;
  initialDelayMs: number;
  operation: () => Promise<T>;
}) => {
  let lastError: unknown;

  for (let attempt = 0; attempt < input.attempts; attempt += 1) {
    try {
      return await input.operation();
    } catch (error) {
      lastError = error;

      if (attempt === input.attempts - 1 || !isRetriableNetworkError(error)) {
        throw error;
      }

      await sleep(input.initialDelayMs * (attempt + 1));
    }
  }

  throw lastError;
};
