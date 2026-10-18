/**
 * Shared lazy OpenAI client + business context helpers for social automation.
 *
 * The OpenAI SDK is imported lazily and only when an AI API key is configured
 * in business settings. If the key is missing, callers get a clear
 * "AI not configured" error instead of a crash.
 */
import { prisma } from "@/lib/prisma";

export interface AiSettings {
  apiKey: string;
  model: string;
  businessName: string;
  businessDesc: string;
}

/** Read AI settings from the ambient business context. */
export async function getAiSettings(): Promise<AiSettings> {
  const settings = await prisma.settings.findFirst();
  if (!settings || !settings.aiApiKey) {
    throw new Error(
      "AI not configured. Add an OpenAI API key in Settings > AI Configuration."
    );
  }
  return {
    apiKey: settings.aiApiKey,
    model: settings.aiModel || "gpt-4o-mini",
    businessName: settings.businessName || "Ride Bangla",
    businessDesc: settings.businessDesc || "",
  };
}

/** Knowledge-base entries as compact context text for prompts. */
export async function getKnowledgeContext(maxEntries = 12): Promise<string> {
  const entries = await prisma.knowledgeEntry.findMany({
    where: { isActive: true },
    orderBy: { priority: "desc" },
    take: maxEntries,
    select: { title: true, content: true },
  });
  if (entries.length === 0) return "";
  return entries
    .map((e) => `- ${e.title}: ${e.content}`)
    .join("\n")
    .slice(0, 6000);
}

export type OpenAIClient = import("openai").default;

/** Lazily construct the OpenAI client (import is deferred until needed). */
export async function getOpenAI(): Promise<{
  client: OpenAIClient;
  settings: AiSettings;
}> {
  const settings = await getAiSettings();
  const { default: OpenAI } = await import("openai");
  return { client: new OpenAI({ apiKey: settings.apiKey }), settings };
}
