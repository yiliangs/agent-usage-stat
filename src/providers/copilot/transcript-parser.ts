import { basename } from "path";
import type { ParsedTranscript } from "../../types/transcript.js";
import type {
  CopilotEvent,
  CopilotSessionStart,
} from "./transcript-format.js";
import { readCopilotEvents } from "./transcript-reader.js";

export class TranscriptParser {
  async parseTranscript(
    path: string,
    fallbackId = "unknown-session",
  ): Promise<ParsedTranscript> {
    const events = await readCopilotEvents(path);
    const startEvent = events.find((event) => event.type === "session.start");
    const start = (startEvent?.data || {}) as CopilotSessionStart;
    const shutdown = [...events]
      .reverse()
      .find((event) => event.type === "session.shutdown");
    const users = events.filter((event) => event.type === "user.message");
    const assistants = events.filter((event) => event.type === "assistant.message");
    const firstPrompt = promptText(users[0]) || "No prompt available";
    const timestamps = events
      .map((event) => event.timestamp)
      .filter((value): value is string => !!value && !Number.isNaN(Date.parse(value)));
    const startTime = safeDate(start.startTime || startEvent?.timestamp || timestamps[0]);
    const endTime = safeDate(shutdown?.timestamp || timestamps[timestamps.length - 1], startTime);
    const cwd = start.context?.cwd;

    return {
      sessionSlug: slugify(firstPrompt, fallbackId),
      firstPrompt,
      startTime,
      endTime,
      userMessageCount: users.length,
      assistantMessageCount: assistants.length,
      totalMessages: users.length + assistants.length,
      projectName: cwd ? basename(cwd.replace(/[\\/]+$/, "")) : undefined,
      gitBranch: start.context?.branch,
      cwd,
    };
  }
}

function promptText(event: CopilotEvent | undefined): string {
  const content = valueAt(event?.data, "content");
  if (typeof content === "string") return truncate(content);
  if (!Array.isArray(content)) return "";
  return truncate(
    content
      .map((part) => valueAt(part, "text"))
      .filter((part): part is string => typeof part === "string")
      .join(" "),
  );
}

function valueAt(value: unknown, key: string): unknown {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function truncate(value: string): string {
  const normalized = value.trim();
  return normalized.length <= 100
    ? normalized
    : normalized.slice(0, 100).trim() + "...";
}

function slugify(prompt: string, fallbackId: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return slug || fallbackId.slice(0, 8) || "unknown-session";
}

function safeDate(value: string | undefined, fallback = new Date()): Date {
  const date = value ? new Date(value) : fallback;
  return Number.isNaN(date.getTime()) ? fallback : date;
}
