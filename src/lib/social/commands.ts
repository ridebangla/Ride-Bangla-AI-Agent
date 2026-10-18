/**
 * Admin command queue: takes the oldest queued AgentCommand, runs it through
 * OpenAI with a small set of REAL local tools, executes the requested
 * actions, and marks the command done (with a result summary) or failed
 * (with the error). One command per run, max 5 tool iterations.
 *
 * Must run inside an ambient business context (the cron route enters it).
 */
import { prisma, withBusinessId } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { isSupportedPlatform, getActiveAccounts, getDecryptedToken } from "./accounts";
import { generatePostContent, generatePostImage } from "./content";
import { publishPost } from "./publisher";
import { syncEngagement } from "./engagement";
import { getAudienceBrief, analyzeAudience } from "./audience";
import { getOpenAI } from "./ai";

// ---------------------------------------------------------------------------
// Real local tool implementations
// ---------------------------------------------------------------------------

async function toolCreateScheduledPost(args: {
  platform: string;
  postType?: string;
  topic: string;
  scheduledAt: string;
  textContent?: string;
  imagePrompt?: string;
}): Promise<string> {
  if (!isSupportedPlatform(args.platform)) {
    throw new Error(`Unsupported platform: ${args.platform}`);
  }
  if (!args.topic?.trim()) throw new Error("topic is required");
  const when = new Date(args.scheduledAt);
  if (isNaN(when.getTime())) throw new Error("scheduledAt is not a valid date");
  if (when <= new Date()) throw new Error("scheduledAt must be in the future");

  const post = await prisma.scheduledPost.create({
    data: withBusinessId({
      platform: args.platform,
      postType: args.postType || "promo",
      topic: args.topic.trim(),
      scheduledAt: when,
      textContent: args.textContent?.trim() || "",
      imagePrompt: args.imagePrompt?.trim() || "",
      createdBy: "agent",
    }),
  });
  return `Scheduled ${args.platform} ${args.postType || "promo"} post "${args.topic}" for ${when.toISOString()} (id ${post.id}).`;
}

async function toolListScheduledPosts(args: { status?: string }): Promise<string> {
  const where: Record<string, unknown> = {};
  if (args.status) where.status = args.status;
  const posts = await prisma.scheduledPost.findMany({
    where,
    orderBy: { scheduledAt: "asc" },
    take: 20,
    select: {
      id: true, platform: true, postType: true, topic: true,
      scheduledAt: true, status: true, resultRef: true,
    },
  });
  if (posts.length === 0) return "No scheduled posts found.";
  return posts
    .map(
      (p) =>
        `- [${p.status}] ${p.platform}/${p.postType} "${p.topic}" at ${p.scheduledAt.toISOString()} (id ${p.id}${p.resultRef ? `, ref ${p.resultRef}` : ""})`
    )
    .join("\n");
}

async function toolPublishNow(args: {
  platform: string;
  topic: string;
  textContent?: string;
  imagePrompt?: string;
  postType?: string;
}): Promise<string> {
  if (!isSupportedPlatform(args.platform)) {
    throw new Error(`Unsupported platform: ${args.platform}`);
  }
  const accounts = await getActiveAccounts();
  const account = accounts.find((a) => a.platform === args.platform);
  if (!account) {
    throw new Error(
      `No active ${args.platform} account connected. Connect one first.`
    );
  }
  const token = getDecryptedToken(account);
  const content = await generatePostContent({
    platform: args.platform,
    topic: args.topic || "latest update",
    postType: args.postType || "promo",
    textOverride: args.textContent,
    imagePromptOverride: args.imagePrompt,
  });

  // TEXT + PICTURE: generate the picture unless this is text-only.
  let imageBytes: Buffer | undefined;
  let imageMime: string | undefined;
  const wantImage =
    Boolean(args.imagePrompt) || (args.postType || "promo") === "promo";
  if (wantImage && !args.textContent) {
    const img = await generatePostImage(content.imagePrompt);
    imageBytes = img.bytes;
    imageMime = img.mimeType;
  }

  const result = await publishPost({
    platform: args.platform,
    accountRef: account.accountRef,
    token,
    text: content.text,
    imageBytes,
    imageMime,
  });
  return `Published to ${args.platform} (post id ${result.externalId}).`;
}

async function toolSyncEngagement(): Promise<string> {
  const r = await syncEngagement();
  const notes =
    r.limitations.length > 0
      ? ` Limitations: ${r.limitations.join(" | ")}`
      : "";
  return (
    `Synced ${r.accounts} account(s): ${r.found} new interaction(s), ` +
    `${r.replied} replie(s).${notes}`
  );
}

async function toolAudienceSummary(args: { platform?: string }): Promise<string> {
  if (args.platform) {
    const brief = await getAudienceBrief(args.platform);
    return brief || `No audience data for ${args.platform} yet. Run sync + analyze first.`;
  }
  await analyzeAudience();
  const profiles = await prisma.audienceProfile.findMany();
  if (profiles.length === 0) return "No audience profiles yet.";
  return profiles
    .map((p) => `${p.platform}: ${JSON.stringify(p.data).slice(0, 400)}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Tool schemas exposed to the model
// ---------------------------------------------------------------------------

const TOOL_DEFS = [
  {
    type: "function" as const,
    function: {
      name: "create_scheduled_post",
      description: "Schedule a social post for a future time.",
      parameters: {
        type: "object",
        properties: {
          platform: { type: "string", enum: ["facebook", "instagram", "x"] },
          postType: { type: "string", enum: ["promo", "announcement", "engagement", "tip"] },
          topic: { type: "string" },
          scheduledAt: { type: "string", description: "Future ISO datetime" },
          textContent: { type: "string", description: "Optional exact text override" },
          imagePrompt: { type: "string", description: "Optional image prompt override" },
        },
        required: ["platform", "topic", "scheduledAt"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_scheduled_posts",
      description: "List scheduled posts, optionally filtered by status.",
      parameters: {
        type: "object",
        properties: { status: { type: "string" } },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "publish_now",
      description: "Generate and immediately publish a post to a platform.",
      parameters: {
        type: "object",
        properties: {
          platform: { type: "string", enum: ["facebook", "instagram", "x"] },
          topic: { type: "string" },
          postType: { type: "string", enum: ["promo", "announcement", "engagement", "tip"] },
          textContent: { type: "string", description: "Optional exact text override" },
          imagePrompt: { type: "string", description: "Optional image prompt override" },
        },
        required: ["platform", "topic"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "sync_engagement",
      description: "Pull new comments/messages from all connected accounts and reply to each.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "audience_summary",
      description: "Get audience insights, optionally for one platform.",
      parameters: {
        type: "object",
        properties: { platform: { type: "string" } },
      },
    },
  },
];

const TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  create_scheduled_post: (a) =>
    toolCreateScheduledPost(a as unknown as Parameters<typeof toolCreateScheduledPost>[0]),
  list_scheduled_posts: (a) =>
    toolListScheduledPosts(a as unknown as Parameters<typeof toolListScheduledPosts>[0]),
  publish_now: (a) =>
    toolPublishNow(a as unknown as Parameters<typeof toolPublishNow>[0]),
  sync_engagement: () => toolSyncEngagement(),
  audience_summary: (a) =>
    toolAudienceSummary(a as unknown as Parameters<typeof toolAudienceSummary>[0]),
};

// ---------------------------------------------------------------------------
// Queue processor
// ---------------------------------------------------------------------------

export interface CommandResult {
  processed: boolean;
  commandId?: string;
  status?: "done" | "failed";
  result?: string;
}

export async function processCommandQueue(): Promise<CommandResult> {
  const command = await prisma.agentCommand.findFirst({
    where: { status: "queued" },
    orderBy: { createdAt: "asc" },
  });

  if (!command) {
    return { processed: false };
  }

  await prisma.agentCommand.update({
    where: { id: command.id },
    data: { status: "running" },
  });

  try {
    const summary = await runAgent(command.command);
    await prisma.agentCommand.update({
      where: { id: command.id },
      data: { status: "done", result: summary.slice(0, 4000) },
    });
    logger.info("Agent command done", { commandId: command.id });
    return { processed: true, commandId: command.id, status: "done", result: summary };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.agentCommand.update({
      where: { id: command.id },
      data: { status: "failed", result: message.slice(0, 2000) },
    });
    logger.error("Agent command failed", { commandId: command.id, error: message });
    return { processed: true, commandId: command.id, status: "failed", result: message };
  }
}

async function runAgent(commandText: string): Promise<string> {
  const { client, settings } = await getOpenAI();

  type Msg = { role: "system" | "user" | "assistant" | "tool"; content: string; tool_calls?: unknown; tool_call_id?: string; name?: string };
  const messages: Msg[] = [
    {
      role: "system",
      content: [
        `You are the social-automation agent for "${settings.businessName}".`,
        "Execute the admin's command using the provided tools.",
        "You may call tools up to 5 times total. When finished, reply with a",
        "short plain-text summary of what was done (no markdown).",
        "Scheduling is user-configured: never invent recurring schedules,",
        "only the explicit datetimes given. Do not generate video content.",
      ].join("\n"),
    },
    { role: "user", content: commandText },
  ];

  for (let i = 0; i < 5; i++) {
    const res = await client.chat.completions.create({
      model: settings.model,
      messages: messages as never,
      tools: TOOL_DEFS as never,
      tool_choice: "auto",
      max_tokens: 1000,
    });

    const choice = res.choices[0]?.message;
    if (!choice) throw new Error("AI returned no response.");

    const toolCalls = (choice as unknown as {
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    }).tool_calls;

    messages.push({
      role: "assistant",
      content: choice.content ?? "",
      tool_calls: toolCalls,
    } as Msg);

    if (!toolCalls || toolCalls.length === 0) {
      return (choice.content ?? "Command executed.").trim() || "Command executed.";
    }

    for (const call of toolCalls) {
      const handler = TOOL_HANDLERS[call.function.name];
      let toolResult: string;
      try {
        if (!handler) throw new Error(`Unknown tool: ${call.function.name}`);
        const args = JSON.parse(call.function.arguments || "{}");
        toolResult = await handler(args);
      } catch (err) {
        toolResult = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: toolResult,
      });
    }
  }

  return "Command executed (reached tool-call limit).";
}
