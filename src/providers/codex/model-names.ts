import { normalizeModelId } from "./pricing.js";

export function displayModelName(model: string): string {
  const normalized = normalizeModelId(model);
  if (normalized === "gpt-5.6-sol") return "GPT-5.6 Sol";
  if (normalized === "gpt-5.6-terra") return "GPT-5.6 Terra";
  if (normalized === "gpt-5.6-luna") return "GPT-5.6 Luna";
  if (normalized === "gpt-5.3-codex") return "GPT-5.3 Codex";
  if (normalized === "gpt-5-mini") return "GPT-5 Mini";
  return normalized
    .split("-")
    .map((part) => part.toUpperCase() === "GPT" ? "GPT" : part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
