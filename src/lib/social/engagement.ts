/**
 * Engagement sync: pull new comments/messages from every active social
 * account, reply to EVERY one of them, and record everything in
 * SocialInteraction for "reply to EVERYTHING" tracking + audience learning.
 *
 * Honest limitations (never faked):
 * - X/Twitter mentions/replies need an API tier that grants them. On
 *   403/429 the limitation is recorded in the result and sync continues.
 * - Every write goes through the real platform API; only platform-returned
 *   IDs are stored as replyRef.
 */
import { prisma, withBusinessId } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { getActiveAccounts, getDecryptedToken } from "./accounts";
import { getOpenAI, getKnowledgeContext } from "./ai";
import type { SocialAccount } from "@/lib/models";

const TIMEOUT_MS = 15_000;

export interface SyncResult {
  accounts: number;
  found: number;
  replied: number;
  likesSeen: number;
  limitations: string[];
}

function withTimeout(ms: number = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function apiGet(url: string, token?: string): Promise<unknown> {
  const { signal, clear } = withTimeout();
  try {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(url, { headers, signal });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(
        `platform GET failed (HTTP ${res.status}): ${text.slice(0, 300)}`
      ) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return JSON.parse(text);
  } finally {
    clear();
  }
}

interface NewItem {
  platform: string;
  kind: "comment" | "message" | "post" | "like";
  externalId: string;
  parentRef: string;
  customerRef: string;
  content: string;
  likes: number;
  /** Platform-specific payload needed to post the reply back. */
  replyTarget: ReplyTarget;
}
interface ReplyTarget {
  kind: "fb_comment" | "fb_message" | "ig_comment" | "x_tweet";
  /** comment id / conversation id / tweet id */
  id: string;
}

/** Graph API GET with the page/user access token attached. */
async function graphGet(url: string, token: string): Promise<unknown> {
  const sep = url.includes("?") ? "&" : "?";
  return apiGet(
    `${url}${sep}access_token=${encodeURIComponent(token)}`
  );
}

// ---------------------------------------------------------------------------
// Reply text generation
// ---------------------------------------------------------------------------

async function generateReply(
  itemText: string,
  itemKind: string,
  platform: string
): Promise<string> {
  const { client, settings } = await getOpenAI();
  const knowledge = await getKnowledgeContext();

  const system = [
    // ID-08: settings.businessName is "" (never "Ride Bangla") for an
    // unconfigured tenant since the ai.ts fallback removal. Name no
    // business rather than borrowing the platform's name on comments.
    settings.businessName
      ? `You are the social media assistant for "${settings.businessName}".`
      : "You are a social media assistant. Do not name any business, and never present yourself as Ride Bangla.",
    settings.businessDesc ? `Business: ${settings.businessDesc}` : "",
    "Write a short, warm, polite, human-like reply to a customer's",
    `${itemKind} on ${platform}. Reply in the SAME language the customer used`,
    "(Bengali or English). Keep it under 60 words. No markdown formatting,",
    "no hashtags in the reply itself.",
    knowledge ? `\nBusiness facts you may use (do not invent others):\n${knowledge}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const res = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: system },
      { role: "user", content: itemText },
    ],
    max_tokens: 200,
    temperature: 0.7,
  });

  const reply = res.choices[0]?.message?.content?.trim();
  if (!reply) throw new Error("AI returned an empty reply.");
  return reply;
}

// ---------------------------------------------------------------------------
// Post a reply through the platform API (real writes only)
// Exported for the Phase 5 comment-approval flow (inbox approve/send).
// ---------------------------------------------------------------------------

export async function postReply(
  account: SocialAccount,
  token: string,
  target: ReplyTarget,
  text: string
): Promise<string> {
  const base = "https://graph.facebook.com/v21.0";
  const { signal, clear } = withTimeout();
  try {
    if (target.kind === "fb_comment" || target.kind === "ig_comment") {
      const params = new URLSearchParams({
        message: text,
        access_token: token,
      });
      const res = await fetch(
        `${base}/${encodeURIComponent(target.id)}/replies`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: params.toString(),
          signal,
        }
      );
      const body = await res.text();
      if (!res.ok) {
        throw new Error(`reply post failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
      }
      const data = JSON.parse(body) as { id?: string; comment_id?: string };
      const id = data.id || data.comment_id;
      if (!id) throw new Error("reply post returned no ID");
      return id;
    }

    if (target.kind === "fb_message") {
      const params = new URLSearchParams({
        message: text,
        access_token: token,
      });
      const res = await fetch(
        `${base}/${encodeURIComponent(target.id)}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: params.toString(),
          signal,
        }
      );
      const body = await res.text();
      if (!res.ok) {
        throw new Error(`message send failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
      }
      const data = JSON.parse(body) as { id?: string; message_id?: string };
      const id = data.id || data.message_id;
      if (!id) throw new Error("message send returned no ID");
      return id;
    }

    // x_tweet
    const res = await fetch("https://api.twitter.com/2/tweets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        reply: { in_reply_to_tweet_id: target.id },
      }),
      signal,
    });
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`x reply failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
    }
    const data = JSON.parse(body) as { data?: { id?: string } };
    if (!data.data?.id) throw new Error("x reply returned no tweet ID");
    return data.data.id;
  } finally {
    clear();
  }
}

// ---------------------------------------------------------------------------
// Fetchers per platform
// ---------------------------------------------------------------------------

interface FbComment {
  id: string;
  from?: { id: string; name?: string };
  message?: string;
  like_count?: number;
  created_time?: string;
  comments?: { data?: FbComment[] };
}

async function fetchFacebook(account: SocialAccount, token: string): Promise<NewItem[]> {
  const base = "https://graph.facebook.com/v21.0";
  const pageId = encodeURIComponent(account.accountRef);
  const items: NewItem[] = [];

  // Recent posts + their comments (incl. one level of nested replies)
  const posts = (await graphGet(
    `${base}/${pageId}/posts?limit=10&fields=id,message,like_count,comments_count,created_time`,
    token
  )) as { data?: Array<{ id: string; message?: string; like_count?: number }> };

  for (const post of posts.data ?? []) {
    items.push({
      platform: "facebook",
      kind: "post",
      externalId: post.id,
      parentRef: "",
      customerRef: "",
      content: (post.message ?? "").slice(0, 500),
      likes: post.like_count ?? 0,
      replyTarget: { kind: "fb_comment", id: post.id },
    });

    const comments = (await graphGet(
      `${base}/${encodeURIComponent(post.id)}/comments?limit=50&fields=id,from,message,like_count,created_time,comments{id,from,message,like_count,created_time}`,
      token
    )) as { data?: FbComment[] };

    for (const c of comments.data ?? []) {
      if (c.from?.id === account.accountRef) continue; // skip own replies
      items.push({
        platform: "facebook",
        kind: "comment",
        externalId: c.id,
        parentRef: post.id,
        customerRef: c.from?.id ?? "",
        content: (c.message ?? "").slice(0, 1000),
        likes: c.like_count ?? 0,
        replyTarget: { kind: "fb_comment", id: c.id },
      });
      for (const r of c.comments?.data ?? []) {
        if (r.from?.id === account.accountRef) continue;
        items.push({
          platform: "facebook",
          kind: "comment",
          externalId: r.id,
          parentRef: c.id,
          customerRef: r.from?.id ?? "",
          content: (r.message ?? "").slice(0, 1000),
          likes: r.like_count ?? 0,
          replyTarget: { kind: "fb_comment", id: r.id },
        });
      }
    }
  }

  // Page conversations (direct messages)
  try {
    const convos = (await graphGet(
      `${base}/${pageId}/conversations?limit=20&fields=participants,messages{id,from,message,created_time}`,
      token
    )) as {
      data?: Array<{
        id: string;
        messages?: { data?: Array<{ id: string; from?: { id: string }; message?: string }> };
      }>;
    };
    for (const convo of convos.data ?? []) {
      for (const m of convo.messages?.data ?? []) {
        if (m.from?.id === account.accountRef) continue; // skip own messages
        if (!m.message) continue;
        items.push({
          platform: "facebook",
          kind: "message",
          externalId: m.id,
          parentRef: convo.id,
          customerRef: m.from?.id ?? "",
          content: m.message.slice(0, 1000),
          likes: 0,
          replyTarget: { kind: "fb_message", id: convo.id },
        });
      }
    }
  } catch (err) {
    logger.warn("Facebook conversations fetch failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return items;
}

async function fetchInstagram(
  account: SocialAccount,
  token: string
): Promise<NewItem[]> {
  const base = "https://graph.facebook.com/v21.0";
  const igUser = encodeURIComponent(account.accountRef);
  const items: NewItem[] = [];

  const media = (await graphGet(
    `${base}/${igUser}/media?limit=10&fields=id,caption,timestamp,like_count,comments_count`,
    token
  )) as {
    data?: Array<{ id: string; caption?: string; like_count?: number }>;
  };

  for (const m of media.data ?? []) {
    items.push({
      platform: "instagram",
      kind: "post",
      externalId: m.id,
      parentRef: "",
      customerRef: "",
      content: (m.caption ?? "").slice(0, 500),
      likes: m.like_count ?? 0,
      replyTarget: { kind: "ig_comment", id: m.id },
    });

    const comments = (await graphGet(
      `${base}/${encodeURIComponent(m.id)}/comments?limit=50&fields=id,from,text,timestamp,like_count,replies{id,from,text,timestamp,like_count}`,
      token
    )) as {
      data?: Array<{
        id: string;
        from?: { id: string };
        text?: string;
        like_count?: number;
        replies?: { data?: Array<{ id: string; from?: { id: string }; text?: string; like_count?: number }> };
      }>;
    };

    for (const c of comments.data ?? []) {
      if (c.from?.id === account.accountRef) continue;
      items.push({
        platform: "instagram",
        kind: "comment",
        externalId: c.id,
        parentRef: m.id,
        customerRef: c.from?.id ?? "",
        content: (c.text ?? "").slice(0, 1000),
        likes: c.like_count ?? 0,
        replyTarget: { kind: "ig_comment", id: c.id },
      });
      for (const r of c.replies?.data ?? []) {
        if (r.from?.id === account.accountRef) continue;
        items.push({
          platform: "instagram",
          kind: "comment",
          externalId: r.id,
          parentRef: c.id,
          customerRef: r.from?.id ?? "",
          content: (r.text ?? "").slice(0, 1000),
          likes: r.like_count ?? 0,
          replyTarget: { kind: "ig_comment", id: r.id },
        });
      }
    }
  }

  return items;
}

async function fetchX(
  account: SocialAccount,
  token: string,
  limitations: string[]
): Promise<NewItem[]> {
  const items: NewItem[] = [];
  try {
    const url =
      `https://api.twitter.com/2/users/${encodeURIComponent(account.accountRef)}` +
      `/mentions?max_results=20&tweet.fields=created_at,public_metrics&expansions=author_id`;
    const data = (await apiGet(url, token)) as {
      data?: Array<{
        id: string;
        text: string;
        author_id?: string;
        public_metrics?: { like_count?: number };
      }>;
    };
    for (const t of data.data ?? []) {
      items.push({
        platform: "x",
        kind: "message",
        externalId: t.id,
        parentRef: "",
        customerRef: t.author_id ?? "",
        content: t.text.slice(0, 1000),
        likes: t.public_metrics?.like_count ?? 0,
        replyTarget: { kind: "x_tweet", id: t.id },
      });
    }
  } catch (err) {
    const status = (err as Error & { status?: number }).status;
    if (status === 403 || status === 429) {
      limitations.push(
        `X mentions unavailable for @${account.label || account.accountRef} (HTTP ${status}): ` +
          "the X API tier on this account does not grant mentions/reply access. " +
          "Upgrade the X developer tier to enable mention sync."
      );
    } else {
      throw err;
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Main sync
// ---------------------------------------------------------------------------

export async function syncEngagement(): Promise<SyncResult> {
  const accounts = await getActiveAccounts();
  const result: SyncResult = {
    accounts: accounts.length,
    found: 0,
    replied: 0,
    likesSeen: 0,
    limitations: [],
  };

  for (const account of accounts) {
    let token: string;
    try {
      token = getDecryptedToken(account);
    } catch (err) {
      result.limitations.push(
        `Skipping ${account.platform} account "${account.label}": ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }

    let items: NewItem[];
    try {
      switch (account.platform) {
        case "facebook":
          items = await fetchFacebook(account, token);
          break;
        case "instagram":
          items = await fetchInstagram(account, token);
          break;
        case "x":
          items = await fetchX(account, token, result.limitations);
          break;
        default:
          result.limitations.push(`Unsupported platform: ${account.platform}`);
          continue;
      }
    } catch (err) {
      result.limitations.push(
        `${account.platform} fetch failed for "${account.label}": ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }

    if (items.length === 0) continue;

    // Deduplicate against what's already stored
    const existing = await prisma.socialInteraction.findMany({
      where: {
        platform: account.platform,
        externalId: { in: items.map((i) => i.externalId) },
      },
      select: { externalId: true },
    });
    const seen = new Set(existing.map((e) => e.externalId));
    const fresh = items.filter((i) => !seen.has(i.externalId));
    if (fresh.length === 0) continue;

    for (const item of fresh) {
      result.found++;
      result.likesSeen += item.likes;

      let replied = false;
      let repliedAt: Date | undefined;
      let replyRef = "";
      // Phase 5 (user decision 6): the AI DRAFTS every reply. The draft is
      // stored on the interaction and the business approves it in the
      // inbox. Auto-post happens ONLY when the connected account has
      // `autoReply` enabled in channel settings — never without it.
      let draftReply = "";

      if (item.kind === "comment" || item.kind === "message") {
        // Leg C: comment auto-post honours the global kill-switch. The sync
        // previously auto-posted a comment reply on autoReply alone, even
        // while global AI was off — against the kill-switch doctrine
        // ("AI stays silent across EVERY conversation (website, channels,
        // social)"). Under global-off, comments are stored with NO draft
        // and NO auto-post; staff reply manually from the inbox. Message
        // items are untouched by this branch (DM flows keep HEAD behaviour).
        let globalOffForComment = false;
        if (item.kind === "comment") {
          const settingsRow = await prisma.settings
            .findFirst({ select: { aiEnabled: true } })
            .catch(() => null);
          globalOffForComment =
            (settingsRow as { aiEnabled?: unknown } | null)?.aiEnabled === false;
        }
        if (globalOffForComment) {
          result.limitations.push(
            `Global AI off — stored ${item.platform} comment ${item.externalId} without draft or auto-post`
          );
        } else {
        try {
          const replyText = await generateReply(
            item.content,
            item.kind,
            item.platform
          );
          draftReply = replyText;

          if (account.autoReply) {
            replyRef = await postReply(account, token, item.replyTarget, replyText);
            replied = true;
            repliedAt = new Date();
            result.replied++;
          }
        } catch (err) {
          result.limitations.push(
            `Reply failed for ${item.platform} ${item.kind} ${item.externalId}: ` +
              (err instanceof Error ? err.message : String(err))
          );
        }
        } // Leg C: end of global-off else (comment auto-post gate)
      }

      await prisma.socialInteraction.create({
        data: withBusinessId({
          platform: item.platform,
          kind: item.kind,
          externalId: item.externalId,
          parentRef: item.parentRef,
          customerRef: item.customerRef,
          content: item.content,
          likes: item.likes,
          replied,
          repliedAt,
          replyRef,
          draftReply,
          socialAccountId: account.id,
        }),
      });
    }

    await prisma.socialAccount
      .update({ where: { id: account.id }, data: { lastSyncAt: new Date() } })
      .catch(() => undefined);
  }

  logger.info("Engagement sync complete", { ...result });
  return result;
}
