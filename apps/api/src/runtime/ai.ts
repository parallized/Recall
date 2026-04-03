import type { ChatJsonGateway } from "./types";

const stripJsonFence = (content: string) =>
  content
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

const normalizeBaseUrl = (value: string) => value.replace(/\/+$/, "");

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

export class OpenAiCompatibleJsonGateway implements ChatJsonGateway {
  constructor(
    private readonly options: {
      baseUrl: string;
      apiKey: string;
      model: string;
    },
  ) {}

  async generateJson<T>(input: {
    schemaName: string;
    system: string;
    user: string;
  }): Promise<T> {
    const response = await fetch(`${normalizeBaseUrl(this.options.baseUrl)}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.options.model,
        stream: true,
        temperature: 0.2,
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
      }),
    });

    if (!response.ok) {
      throw new Error(`Chat completion failed with status ${response.status}.`);
    }

    if (!response.body) {
      throw new Error("Chat completion did not return a response body.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";

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
            };
          }>;
        };
        const delta = payload.choices?.[0]?.delta?.content;

        if (!delta) {
          continue;
        }

        console.log(`[ai:${input.schemaName}] ${delta}`);
        content += delta;
      }
    }

    if (content.trim().length === 0) {
      throw new Error("Chat completion did not return streamed content.");
    }

    try {
      return JSON.parse(stripJsonFence(content)) as T;
    } catch {
      throw new Error("Chat completion returned invalid JSON.");
    }
  }
}

export class MissingChatJsonGateway implements ChatJsonGateway {
  constructor(private readonly message: string) {}

  async generateJson<T>(): Promise<T> {
    throw new Error(this.message);
  }
}
