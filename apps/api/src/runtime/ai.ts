import { createCallLog, withLogDirectory } from "./call-log";
import { retryAsync } from "./network";
import type { ChatJsonGateway, TokenUsage } from "./types";

const stripJsonFence = (content: string) =>
  content
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

const normalizeBaseUrl = (value: string) => value.replace(/\/+$/, "");
const THINK_OPEN_TAG = "<think>";
const THINK_CLOSE_TAG = "</think>";

const parseSseData = (buffer: string) => {
  const events = buffer.split(/\r?\n\r?\n/);
  const remainder = events.pop() ?? "";

  return {
    remainder,
    events: events
      .map((event) =>
        event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n"),
      )
      .filter((event) => event.length > 0),
  };
};

const stripThinkBlocks = (content: string) => content.replace(/<think>[\s\S]*?<\/think>/g, "");

const extractJsonCandidate = (content: string) => {
  const cleaned = stripJsonFence(stripThinkBlocks(content)).trim();
  const start = cleaned.search(/[{\[]/);
  const end = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));

  if (start === -1 || end === -1 || end < start) {
    return cleaned;
  }

  return cleaned.slice(start, end + 1);
};

const sharedBoundaryLength = (text: string, marker: string) => {
  for (let length = Math.min(text.length, marker.length - 1); length > 0; length -= 1) {
    if (text.endsWith(marker.slice(0, length))) {
      return length;
    }
  }

  return 0;
};

type ThoughtParseState = {
  channel: "content" | "reasoning";
  buffer: string;
};

const consumeTaggedDelta = (state: ThoughtParseState, chunk: string) => {
  let channel = state.channel;
  let text = state.buffer + chunk;
  const emissions: Array<{ channel: "content" | "reasoning"; text: string }> = [];

  while (text.length > 0) {
    const marker = channel === "content" ? THINK_OPEN_TAG : THINK_CLOSE_TAG;
    const markerIndex = text.indexOf(marker);

    if (markerIndex === -1) {
      const overlap = sharedBoundaryLength(text, marker);
      const emission = text.slice(0, text.length - overlap);

      if (emission.length > 0) {
        emissions.push({ channel, text: emission });
      }

      return {
        state: {
          channel,
          buffer: text.slice(text.length - overlap),
        },
        emissions,
      };
    }

    const emission = text.slice(0, markerIndex);

    if (emission.length > 0) {
      emissions.push({ channel, text: emission });
    }

    text = text.slice(markerIndex + marker.length);
    channel = channel === "content" ? "reasoning" : "content";
  }

  return {
    state: {
      channel,
      buffer: "",
    },
    emissions,
  };
};

const flushTaggedState = (state: ThoughtParseState) =>
  state.buffer.length > 0 ? [{ channel: state.channel, text: state.buffer }] : [];

const normalizeUsage = (usage?: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}): TokenUsage => ({
  promptTokens: usage?.prompt_tokens ?? 0,
  completionTokens: usage?.completion_tokens ?? 0,
  totalTokens: usage?.total_tokens ?? 0,
});

const describeHttpFailure = (status: number, rawOutput: string) => {
  try {
    const payload = JSON.parse(rawOutput) as {
      error?: {
        message?: string;
        code?: string;
      };
    };
    const code = payload.error?.code?.trim();
    const message = payload.error?.message?.trim();

    if (code && message && !message.toLowerCase().includes(code.toLowerCase())) {
      return `Chat completion failed with status ${status} (${code}: ${message}).`;
    }

    if (message) {
      return `Chat completion failed with status ${status} (${message}).`;
    }

    if (code) {
      return `Chat completion failed with status ${status} (${code}).`;
    }
  } catch {
    // Fall back to the generic message when the upstream body is not JSON.
  }

  return `Chat completion failed with status ${status}.`;
};

export class OpenAiCompatibleJsonGateway implements ChatJsonGateway {
  constructor(
    private readonly options: {
      baseUrl: string;
      apiKey: string;
      model: string;
      logsRoot?: string;
    },
  ) {}

  async generateJson<T>(input: {
    schemaName: string;
    system: string;
    user: string;
    reporter?: import("./types").ProgressReporter;
  }): Promise<T> {
    const requestBody = {
      model: this.options.model,
      stream: true,
      temperature: 0,
      response_format: {
        type: "json_object",
      },
      stream_options: {
        include_usage: true,
      },
      messages: [
        {
          role: "system",
          content: `${input.system}\n\nYou must return raw JSON for the schema "${input.schemaName}".`,
        },
        {
          role: "user",
          content: input.user,
        },
      ],
    };
    const log = await createCallLog({
      rootDir: this.options.logsRoot,
      label: input.schemaName,
      inputPayload: {
        type: "chat-json",
        schemaName: input.schemaName,
        model: this.options.model,
        baseUrl: normalizeBaseUrl(this.options.baseUrl),
        request: requestBody,
      },
    });
    let rawOutput = "";
    let parsedJson: T | undefined;
    let usage: TokenUsage | undefined;
    let failureMessage: string | undefined;

    try {
      const response = await retryAsync({
        attempts: 3,
        initialDelayMs: 400,
        operation: () =>
          fetch(`${normalizeBaseUrl(this.options.baseUrl)}/chat/completions`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.options.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(requestBody),
          }),
      });

      if (!response.ok) {
        rawOutput = await response.text();
        throw new Error(describeHttpFailure(response.status, rawOutput));
      }

      if (!response.body) {
        throw new Error("Chat completion did not return a response body.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      let thoughtState: ThoughtParseState = {
        channel: "content",
        buffer: "",
      };

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseData(buffer);
        buffer = parsed.remainder;

        for (const event of parsed.events) {
          if (event === "[DONE]") {
            continue;
          }

          const payload = JSON.parse(event) as {
            choices?: Array<{
              delta?: {
                content?: string;
                reasoning?: string;
                reasoning_content?: string;
              };
            }>;
            error?: {
              message?: string;
              type?: string;
              code?: string;
            };
            usage?: {
              prompt_tokens?: number;
              completion_tokens?: number;
              total_tokens?: number;
            };
          };

          if (payload.error) {
            rawOutput = rawOutput.length > 0 ? `${rawOutput}\n${event}` : event;
            throw new Error(
              payload.error.message
                ? `Chat completion stream returned error${payload.error.code ? ` (${payload.error.code})` : ""}: ${payload.error.message}`
                : "Chat completion stream returned an unknown error.",
            );
          }

          if (payload.usage) {
            usage = normalizeUsage(payload.usage);
            await input.reporter?.({
              type: "usage",
              scope: "ai",
              schemaName: input.schemaName,
              usage,
            });
          }

          const delta = payload.choices?.[0]?.delta;

          if (!delta) {
            continue;
          }

          const reasoning = delta.reasoning_content ?? delta.reasoning;

          if (reasoning) {
            rawOutput += `<think>${reasoning}</think>`;
            console.log(`[ai:${input.schemaName}:reasoning] ${reasoning}`);
            await input.reporter?.({
              type: "model",
              schemaName: input.schemaName,
              channel: "reasoning",
              text: reasoning,
            });
          }

          if (!delta.content) {
            continue;
          }

          rawOutput += delta.content;
          const consumed = consumeTaggedDelta(thoughtState, delta.content);
          thoughtState = consumed.state;

          for (const emission of consumed.emissions) {
            console.log(`[ai:${input.schemaName}:${emission.channel}] ${emission.text}`);
            await input.reporter?.({
              type: "model",
              schemaName: input.schemaName,
              channel: emission.channel,
              text: emission.text,
            });

            if (emission.channel === "content") {
              content += emission.text;
            }
          }
        }
      }

      for (const emission of flushTaggedState(thoughtState)) {
        console.log(`[ai:${input.schemaName}:${emission.channel}] ${emission.text}`);
        await input.reporter?.({
          type: "model",
          schemaName: input.schemaName,
          channel: emission.channel,
          text: emission.text,
        });

        if (emission.channel === "content") {
          content += emission.text;
        }
      }

      if (content.trim().length === 0) {
        throw new Error("Chat completion did not return streamed content.");
      }

      try {
        parsedJson = JSON.parse(extractJsonCandidate(content)) as T;
        return parsedJson;
      } catch {
        throw new Error("Chat completion returned invalid JSON.");
      }
    } catch (error) {
      failureMessage = withLogDirectory(error instanceof Error ? error.message : String(error), log.directory);
      throw new Error(failureMessage);
    } finally {
      await log.writeOutput({
        status: failureMessage ? "error" : "success",
        rawOutput,
        parsedJson,
        error: failureMessage,
        metadata: usage ? { usage } : undefined,
      });
    }
  }
}

export class MissingChatJsonGateway implements ChatJsonGateway {
  constructor(private readonly message: string) {}

  async generateJson<T>(): Promise<T> {
    throw new Error(this.message);
  }
}
