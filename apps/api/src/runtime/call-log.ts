import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const defaultLogsRoot = resolve(import.meta.dir, "..", "..", "logs");

const sanitizeSegment = (value: string) => {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return sanitized.length > 0 ? sanitized : "call";
};

const buildTimestamp = () => new Date().toISOString().replace(/[:.]/g, "-");

const buildOutputPayload = (input: {
  status: "success" | "error";
  rawOutput: string;
  parsedJson?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
}) => ({
  finishedAt: new Date().toISOString(),
  status: input.status,
  error: input.error ?? null,
  rawOutput: input.rawOutput,
  parsedJson: input.parsedJson ?? null,
  metadata: input.metadata ?? null,
});

export const withLogDirectory = (message: string, directory: string) =>
  message.includes(directory) ? message : `${message} See logs at ${directory}.`;

export const createCallLog = async (input: {
  rootDir?: string;
  label: string;
  inputPayload: Record<string, unknown>;
}) => {
  const directory = join(
    resolve(input.rootDir ?? defaultLogsRoot),
    `${buildTimestamp()}__${sanitizeSegment(input.label)}__${crypto.randomUUID().slice(0, 8)}`,
  );

  await mkdir(directory, {
    recursive: true,
  });

  await writeFile(
    join(directory, "input.json"),
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        ...input.inputPayload,
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    directory,
    async writeOutput(output: {
      status: "success" | "error";
      rawOutput: string;
      parsedJson?: unknown;
      error?: string;
      metadata?: Record<string, unknown>;
    }) {
      await writeFile(join(directory, "output.txt"), JSON.stringify(buildOutputPayload(output), null, 2), "utf8");
    },
  };
};
