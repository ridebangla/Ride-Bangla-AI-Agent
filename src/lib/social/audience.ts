/**
 * Audience intelligence: aggregates SocialInteraction rows per platform into
 * an AudienceProfile, and exposes a short text brief for prompt injection.
 */
import { prisma, withBusinessId } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import type { InputJsonValue } from "@/lib/models";

const STOPWORDS = new Set(
  [
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "is", "are", "was", "were", "be", "been", "this", "that",
    "these", "those", "it", "its", "i", "you", "he", "she", "we", "they",
    "my", "your", "his", "her", "our", "their", "me", "him", "us", "them",
    "what", "when", "where", "who", "how", "why", "which", "not", "no",
    "yes", "do", "does", "did", "can", "will", "just", "very", "so",
    "এবং", "ও", "কি", "কী", "না", "হয়", "হবে", "আছে", "করে", "করুন",
    "থেকে", "এর", "এই", "সেই", "আমি", "আপনি", "তুমি", "আপনার", "আমার",
  ].map((w) => w.toLowerCase())
);

export interface AudienceData {
  stats: {
    totalInteractions: number;
    comments: number;
    messages: number;
    posts: number;
    replyRate: number;
    totalLikes: number;
  };
  topTopics: Array<{ topic: string; score: number }>;
  bestHours: number[];
  sampleQuestions: string[];
  updatedAt: string;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

function hourHistogram(dates: Date[]): number[] {
  const buckets = new Array(24).fill(0) as number[];
  for (const d of dates) buckets[d.getHours()]++;
  return buckets
    .map((count, hour) => ({ hour, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .filter((h) => h.count > 0)
    .map((h) => h.hour);
}

/** Recompute the audience profile for every platform with interaction data. */
export async function analyzeAudience(): Promise<Record<string, AudienceData>> {
  const platforms = await prisma.socialInteraction.findMany({
    distinct: ["platform"],
    select: { platform: true },
  });

  const out: Record<string, AudienceData> = {};

  for (const { platform } of platforms) {
    const rows = await prisma.socialInteraction.findMany({
      where: { platform },
      orderBy: { createdAt: "desc" },
      take: 2000,
    });
    if (rows.length === 0) continue;

    const stats = {
      totalInteractions: rows.length,
      comments: rows.filter((r) => r.kind === "comment").length,
      messages: rows.filter((r) => r.kind === "message").length,
      posts: rows.filter((r) => r.kind === "post").length,
      replyRate:
        rows.filter((r) => r.replied).length / Math.max(rows.length, 1),
      totalLikes: rows.reduce((s, r) => s + r.likes, 0),
    };

    // Top posts by engagement (likes + comments) — proxy via rows with counts
    const wordFreq = new Map<string, number>();
    const questions: string[] = [];
    const commentTexts: string[] = [];

    for (const r of rows) {
      if (!r.content) continue;
      if (r.kind === "comment" || r.kind === "message") {
        commentTexts.push(r.content);
        for (const w of tokenize(r.content)) {
          wordFreq.set(w, (wordFreq.get(w) ?? 0) + 1);
        }
        if (r.content.trim().endsWith("?") && questions.length < 10) {
          questions.push(r.content.slice(0, 140));
        }
      }
    }

    const topTopics = [...wordFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([topic, score]) => ({ topic, score }));

    const bestHours = hourHistogram(rows.map((r) => r.createdAt));

    const data: AudienceData = {
      stats,
      topTopics,
      bestHours,
      sampleQuestions: questions,
      updatedAt: new Date().toISOString(),
    };

    const jsonData = data as unknown as InputJsonValue;
    const existingProfile = await prisma.audienceProfile.findFirst({
      where: { platform },
    });
    if (existingProfile) {
      await prisma.audienceProfile.update({
        where: { id: existingProfile.id },
        data: { data: jsonData },
      });
    } else {
      await prisma.audienceProfile.create({
        data: withBusinessId({ platform, data: jsonData }),
      });
    }

    out[platform] = data;
    logger.info("Audience profile updated", { platform, interactions: rows.length });
  }

  return out;
}

/**
 * Short human-readable brief of a platform's audience, injected into content
 * prompts so generated posts match what the audience responds to.
 */
export async function getAudienceBrief(platform: string): Promise<string> {
  const profile = await prisma.audienceProfile.findFirst({
    where: { platform },
  });
  if (!profile) return "";

  const data = profile.data as Partial<AudienceData>;
  const parts: string[] = [];
  if (data.topTopics && data.topTopics.length > 0) {
    parts.push(
      `Audience on ${platform} talks most about: ${data.topTopics
        .slice(0, 8)
        .map((t) => t.topic)
        .join(", ")}.`
    );
  }
  if (data.bestHours && data.bestHours.length > 0) {
    parts.push(
      `Best engagement hours: ${data.bestHours
        .map((h) => `${h}:00`)
        .join(", ")}.`
    );
  }
  if (data.sampleQuestions && data.sampleQuestions.length > 0) {
    parts.push(`Common questions: "${data.sampleQuestions[0]}"`);
  }
  return parts.join(" ");
}
