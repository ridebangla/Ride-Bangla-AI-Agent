import { Client, LocalAuth, Message } from "whatsapp-web.js";
import * as qrcode from "qrcode";
import { prisma, withBusinessId } from "@/lib/prisma";
import { createNewConversation } from "@/lib/ai/engine";
import { processChannelMessage } from "@/lib/channels/inbound";
import { logger } from "@/lib/logger";
import { resolveCustomer } from "@/lib/customer-resolver";
import { enterBusinessContext, resolveChannelBusiness } from "@/lib/tenant";

let whatsappClient: Client | null = null;
let currentQR: string | null = null;
let connectionStatus: "disconnected" | "qr_ready" | "connecting" | "connected" | "error" = "disconnected";
let statusMessage = "";

export function getWhatsAppStatus() {
  return {
    status: connectionStatus,
    qr: currentQR,
    message: statusMessage,
  };
}

export async function initWhatsApp(): Promise<void> {
  if (whatsappClient) {
    logger.info("[WhatsApp] Client already exists");
    return;
  }

  connectionStatus = "connecting";
  statusMessage = "Initializing WhatsApp client...";

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: ".wwebjs_auth" }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    },
  });

  client.on("qr", async (qr: string) => {
    logger.info("[WhatsApp] QR code received");
    currentQR = await qrcode.toDataURL(qr);
    connectionStatus = "qr_ready";
    statusMessage = "Scan the QR code with WhatsApp on your phone";
  });

  client.on("ready", async () => {
    const businessId = await resolveChannelBusiness();
    if (!businessId) throw new Error("[WhatsApp] cannot resolve business for channel");
    enterBusinessContext(businessId);
    logger.info("[WhatsApp] Client is ready");
    currentQR = null;
    connectionStatus = "connected";
    statusMessage = "Connected to WhatsApp";

    await prisma.channel.upsert({
      where: { businessId_type: { businessId, type: "whatsapp" } },
      update: { isActive: true, status: "connected" },
      create: withBusinessId({ type: "whatsapp", isActive: true, status: "connected" }),
    });
  });

  client.on("authenticated", () => {
    logger.info("[WhatsApp] Authenticated");
    connectionStatus = "connecting";
    statusMessage = "Authenticated, loading chats...";
  });

  client.on("auth_failure", (message: string) => {
    logger.error(`[WhatsApp] Auth failure: ${message}`);
    connectionStatus = "error";
    statusMessage = `Authentication failed: ${message}`;
  });

  client.on("disconnected", async (reason: string) => {
    const businessId = await resolveChannelBusiness();
    if (!businessId) throw new Error("[WhatsApp] cannot resolve business for channel");
    enterBusinessContext(businessId);
    logger.info(`[WhatsApp] Disconnected: ${reason}`);
    connectionStatus = "disconnected";
    statusMessage = `Disconnected: ${reason}`;
    whatsappClient = null;

    await prisma.channel.upsert({
      where: { businessId_type: { businessId, type: "whatsapp" } },
      update: { isActive: false, status: "disconnected" },
      create: withBusinessId({ type: "whatsapp", isActive: false, status: "disconnected" }),
    });
  });

  client.on("message", async (message: Message) => {
    try {
      // Tenant context: channel workers run outside HTTP requests, so the
      // business must be resolved explicitly (fail-closed, never guessed
      // across businesses).
      const businessId = await resolveChannelBusiness();
      enterBusinessContext(businessId);
      if (message.fromMe) return;

      const contact = await message.getContact();
      const customerName = contact.pushname || contact.name || "Unknown";
      const customerContact = message.from;

      // Resolve customer identity across channels
      const customerId = await resolveCustomer("whatsapp", customerContact, customerName);

      // Find or create conversation
      let conversation = await prisma.conversation.findFirst({
        where: {
          channel: "whatsapp",
          status: { in: ["active", "escalated"] },
          OR: [
            { customerId },
            { customerContact },
          ],
        },
      });

      if (!conversation) {
        conversation = await createNewConversation(
          "whatsapp",
          customerName,
          customerContact,
          customerId
        );
      }

      let messageContent = message.body;
      let media: { kind: "image" | "video" | "audio"; mimeType: string; bytes: Buffer } | undefined;

      // Handle media messages — real multimodal path: the attachment bytes go
      // to the brain's perception step (vision / Whisper), not just a label.
      if (message.hasMedia) {
        try {
          const downloaded = await message.downloadMedia();
          if (downloaded?.data) {
            const prefix = downloaded.mimetype.split("/")[0];
            const kind =
              prefix === "image" ? "image" : prefix === "video" ? "video" : prefix === "audio" ? "audio" : null;
            if (kind) {
              media = {
                kind,
                mimeType: downloaded.mimetype,
                bytes: Buffer.from(downloaded.data, "base64"),
              };
              messageContent = message.body || "";
            } else {
              messageContent = `[${prefix} attachment: ${downloaded.filename || "media"}] ${message.body || ""}`;
            }
          }
        } catch (mediaErr) {
          logger.warn("[WhatsApp] media download failed", {
            error: mediaErr instanceof Error ? mediaErr.message : String(mediaErr),
          });
        }
      }

      // Phase 5: shared inbound pipeline — subscription hard-stop (user
      // decision 16) first, then the engine (honors per-conversation +
      // global aiEnabled, user decision 17). On human takeover or an
      // inactive subscription the pipeline stored the message — send nothing.
      const chatResult = await processChannelMessage(
        conversation.id,
        businessId,
        messageContent,
        media ? { media } : undefined
      );

      // Send response back via WhatsApp
      if (!chatResult.silent) {
        await message.reply(chatResult.response);
      } else {
        logger.info("[WhatsApp] human takeover: stored message silently, no reply sent");
      }
    } catch (error) {
      logger.error("[WhatsApp] Failed to process message:", error);
    }
  });

  whatsappClient = client;
  await client.initialize();
}

export async function disconnectWhatsApp(): Promise<void> {
  if (whatsappClient) {
    await whatsappClient.destroy();
    whatsappClient = null;
    currentQR = null;
    connectionStatus = "disconnected";
    statusMessage = "Disconnected";
  }
}

export async function sendWhatsAppMessage(
  to: string,
  message: string
): Promise<boolean> {
  if (!whatsappClient || connectionStatus !== "connected") {
    return false;
  }

  const chatId = to.includes("@c.us") ? to : `${to}@c.us`;
  await whatsappClient.sendMessage(chatId, message);
  return true;
}

