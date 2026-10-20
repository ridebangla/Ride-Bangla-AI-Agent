/**
 * Semantic Search for Knowledge Base
 *
 * Uses OpenAI embeddings for vector similarity search.
 * Falls back to keyword matching when embeddings are unavailable.
 *
 * Embeddings are stored in the KnowledgeEntry metadata field as JSON.
 * For production with pgvector, store in a dedicated vector column.
 */

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { cacheGet, cacheSet } from "@/lib/cache";

interface SearchResult {
  id: string;
  title: string;
  content: string;
  category: string;
  score: number;
}

/**
 * Generate embedding for a text using OpenAI.
 */
async function generateEmbedding(text: string, apiKey: string): Promise<number[] | null> {
  try {
    const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
        input: text.substring(0, 8000),
      }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    return data.data?.[0]?.embedding || null;
  } catch (error) {
    logger.error("Failed to generate embedding:", error);
    return null;
  }
}

/**
 * Calculate cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

/**
 * Keyword-based search fallback.
 */
function keywordScore(query: string, text: string): number {
  const queryWords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const textLower = text.toLowerCase();
  let matches = 0;

  for (const word of queryWords) {
    if (textLower.includes(word)) matches++;
  }

  return queryWords.length > 0 ? matches / queryWords.length : 0;
}

/**
 * Search the knowledge base semantically.
 * Uses embeddings when available, falls back to keyword matching.
 */
export async function searchKnowledgeBase(
  query: string,
  limit = 5
): Promise<SearchResult[]> {
  const entries = await prisma.knowledgeEntry.findMany({
    where: { isActive: true },
    include: { category: { select: { name: true } } },
  });

  if (entries.length === 0) return [];

  // Try to get API key for embeddings
  const settings = await prisma.settings.findFirst({
    select: { aiApiKey: true },
  });

  let results: SearchResult[];

  if (settings?.aiApiKey) {
    // Try semantic search with embeddings
    const cacheKey = `embedding:${Buffer.from(query).toString("base64").substring(0, 50)}`;
    let queryEmbedding: number[] | null = null;

    const cached = await cacheGet(cacheKey);
    if (cached) {
      queryEmbedding = JSON.parse(cached);
    } else {
      queryEmbedding = await generateEmbedding(query, settings.aiApiKey);
      if (queryEmbedding) {
        await cacheSet(cacheKey, JSON.stringify(queryEmbedding), 3600);
      }
    }

    if (queryEmbedding) {
      // Score entries using embeddings (stored in metadata) + keyword fallback
      results = entries.map((entry) => {
        const metadata = entry.metadata as Record<string, unknown> | null;
        const entryEmbedding = metadata?.embedding as number[] | null;

        let score: number;
        if (entryEmbedding) {
          score = cosineSimilarity(queryEmbedding!, entryEmbedding);
        } else {
          // Fallback to keyword matching for entries without embeddings
          score = keywordScore(query, `${entry.title} ${entry.content}`);
        }

        return {
          id: entry.id,
          title: entry.title,
          content: entry.content,
          category: entry.category.name,
          score,
        };
      });
    } else {
      // Embedding generation failed, use keyword search
      results = keywordSearch(entries, query);
    }
  } else {
    // No API key, use keyword search
    results = keywordSearch(entries, query);
  }

  return results
    .filter((r) => r.score > 0.1)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function keywordSearch(
  entries: Array<{
    id: string;
    title: string;
    content: string;
    category: { name: string };
  }>,
  query: string
): SearchResult[] {
  return entries.map((entry) => ({
    id: entry.id,
    title: entry.title,
    content: entry.content,
    category: entry.category.name,
    score: keywordScore(query, `${entry.title} ${entry.content}`),
  }));
}

/**
 * Generate and store embedding for a knowledge entry.
 */
export async function indexKnowledgeEntry(
  entryId: string,
  apiKey: string
): Promise<boolean> {
  const entry = await prisma.knowledgeEntry.findUnique({
    where: { id: entryId },
  });

  if (!entry) return false;

  const text = `${entry.title}\n${entry.content}`;
  const embedding = await generateEmbedding(text, apiKey);

  if (!embedding) return false;

  const currentMetadata = (entry.metadata as Record<string, unknown>) || {};

  await prisma.knowledgeEntry.update({
    where: { id: entryId },
    data: {
      metadata: { ...currentMetadata, embedding },
    },
  });

  return true;
}
