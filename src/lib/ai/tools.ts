import { ToolDefinition } from "./types";
import { prisma, withBusinessId } from "@/lib/prisma";
import nodemailer from "nodemailer";

export const agentTools: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "create_ticket",
      description:
        "Create a support ticket for an issue that needs human attention. Use this when the customer reports a problem that cannot be resolved through the knowledge base.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Brief title describing the issue",
          },
          description: {
            type: "string",
            description: "Detailed description of the issue",
          },
          priority: {
            type: "string",
            enum: ["low", "medium", "high", "urgent"],
            description: "Priority level of the ticket",
          },
          department: {
            type: "string",
            description: "Department name to assign the ticket to",
          },
        },
        required: ["title", "description", "priority"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "assign_to_person",
      description:
        "Assign a ticket or issue to a specific team member based on their expertise.",
      parameters: {
        type: "object",
        properties: {
          ticketId: {
            type: "string",
            description: "The ticket ID to assign",
          },
          expertise: {
            type: "string",
            description:
              "The expertise area needed to resolve this issue. The system will find the best matching team member.",
          },
        },
        required: ["ticketId", "expertise"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_internal_email",
      description:
        "Send an email to a team member about a customer issue that needs their attention.",
      parameters: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description: "Email address of the team member",
          },
          subject: {
            type: "string",
            description: "Email subject",
          },
          body: {
            type: "string",
            description: "Email body content",
          },
        },
        required: ["to", "subject", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_customer_history",
      description:
        "Retrieve the customer's previous conversation history across all channels to provide context-aware support.",
      parameters: {
        type: "object",
        properties: {
          customerContact: {
            type: "string",
            description:
              "Customer's contact info (phone number or email address)",
          },
          customerId: {
            type: "string",
            description:
              "Customer's unique ID for cross-channel history lookup. Use this when available for more complete history.",
          },
        },
        required: ["customerContact"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "schedule_followup",
      description:
        "Schedule a follow-up message to the customer after a specified time.",
      parameters: {
        type: "object",
        properties: {
          conversationId: {
            type: "string",
            description: "The conversation ID",
          },
          message: {
            type: "string",
            description: "The follow-up message to send",
          },
          delayHours: {
            type: "number",
            description: "Hours to wait before sending the follow-up",
          },
        },
        required: ["conversationId", "message", "delayHours"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "take_order",
      description:
        "Record a customer ORDER or BOOKING (ride, food delivery, courier/parcel, grocery, or a product purchase). Pass everything you collected in customFields (keyed by the business's order fields). If the tool replies with needsFields, ask the customer for exactly those details and call again — never record the order until all required fields are collected. The order is saved for the team to fulfill in the dashboard.",
      parameters: {
        type: "object",
        properties: {
          serviceType: {
            type: "string",
            description:
              "What is being ordered: e.g. 'ride', 'food_delivery', 'courier', 'grocery', or a product name from the catalog.",
          },
          pickup: {
            type: "string",
            description: "Pickup location/address (for rides, courier). Empty string if not applicable.",
          },
          dropoff: {
            type: "string",
            description: "Drop-off/delivery location/address. Empty string if not applicable.",
          },
          details: {
            type: "string",
            description:
              "All other order details: items, quantity, date/time, special instructions.",
          },
          customerName: {
            type: "string",
            description: "Customer's name, if known.",
          },
          customerPhone: {
            type: "string",
            description: "Customer's phone number, if known.",
          },
          items: {
            type: "array",
            description:
              "Items being ordered. Each item: { name (string), qty (number), price (number, optional), productId (string, optional) }.",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                qty: { type: "number" },
                price: { type: "number" },
                productId: { type: "string" },
              },
              required: ["name"],
            },
          },
          customFields: {
            type: "object",
            description:
              "The business's custom order fields as key/value pairs (e.g. { cake_flavor: 'Chocolate', delivery_date: '2026-10-25' }). Every REQUIRED field must be present before the order is recorded.",
            additionalProperties: true,
          },
          total: {
            type: "number",
            description: "Order total, if known. Computed from items when omitted.",
          },
        },
        required: ["serviceType", "details"],
      },
    },
  },

  {
    type: "function",
    function: {
      name: "search_catalog",
      description:
        "Search the business's product/service catalog for available items matching the customer's request. Use before quoting prices or confirming availability.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What the customer is looking for.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recommend_alternative",
      description:
        "When the customer asks for something NOT available, get graceful alternatives: available products/services closest to their request. Use this to redirect gracefully instead of just saying no.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What the customer originally asked for.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "trigger_webhook",
      description:
        "Trigger a configured webhook to notify an external system about an event.",
      parameters: {
        type: "object",
        properties: {
          webhookName: {
            type: "string",
            description: "Name of the webhook to trigger",
          },
          data: {
            type: "object",
            description: "Data payload to send with the webhook",
          },
        },
        required: ["webhookName"],
      },
    },
  },
];

export async function executeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  conversationId?: string
): Promise<string> {
  switch (toolName) {
    case "create_ticket":
      return await createTicket(args, conversationId);
    case "assign_to_person":
      return await assignToPerson(args);
    case "send_internal_email":
      return await sendInternalEmail(args);
    case "get_customer_history":
      return await getCustomerHistory(args);
    case "schedule_followup":
      return await scheduleFollowup(args, conversationId);
    case "take_order":
      return await takeOrder(args, conversationId);
    case "search_catalog":
      return await searchCatalogTool(args);
    case "recommend_alternative":
      return await recommendAlternativeTool(args);
    case "trigger_webhook":
      return await triggerWebhook(args);
    default:
      return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  }
}

async function createTicket(
  args: Record<string, unknown>,
  conversationId?: string
): Promise<string> {
  const department = args.department
    ? await prisma.department.findFirst({
        where: {
          name: { contains: args.department as string, mode: "insensitive" },
        },
      })
    : null;

  const ticket = await prisma.ticket.create({
    data: withBusinessId({
      title: args.title as string,
      description: args.description as string,
      priority: (args.priority as string) || "medium",
      conversationId: conversationId || null,
      departmentId: department?.id || null,
    }),
  });

  return JSON.stringify({
    success: true,
    ticketId: ticket.id,
    message: `Ticket created: ${ticket.title} (Priority: ${ticket.priority})`,
  });
}

async function assignToPerson(args: Record<string, unknown>): Promise<string> {
  const expertise = args.expertise as string;
  const ticketId = args.ticketId as string;

  const member = await prisma.teamMember.findFirst({
    where: {
      expertise: { contains: expertise, mode: "insensitive" },
      isAvailable: true,
    },
    include: { department: true },
  });

  if (!member) {
    return JSON.stringify({
      success: false,
      message: `No available team member found with expertise in: ${expertise}`,
    });
  }

  await prisma.ticket.update({
    where: { id: ticketId },
    data: { assignedToId: member.id, status: "in_progress" },
  });

  return JSON.stringify({
    success: true,
    assignedTo: member.name,
    department: member.department.name,
    message: `Ticket assigned to ${member.name} (${member.department.name})`,
  });
}

async function sendInternalEmail(
  args: Record<string, unknown>
): Promise<string> {
  const settings = await prisma.settings.findFirst();
  if (!settings?.smtpHost) {
    return JSON.stringify({
      success: false,
      message: "Email not configured. Please set up SMTP in settings.",
    });
  }

  const transporter = nodemailer.createTransport({
    host: settings.smtpHost,
    port: settings.smtpPort,
    secure: settings.smtpPort === 465,
    auth: {
      user: settings.smtpUser,
      pass: settings.smtpPass,
    },
  });

  await transporter.sendMail({
    from: settings.smtpFrom || settings.smtpUser,
    to: args.to as string,
    subject: args.subject as string,
    text: args.body as string,
  });

  return JSON.stringify({
    success: true,
    message: `Email sent to ${args.to}`,
  });
}

async function getCustomerHistory(
  args: Record<string, unknown>
): Promise<string> {
  // Cross-channel lookup: prefer customerId for unified history
  const where = args.customerId
    ? { customerId: args.customerId as string }
    : { customerContact: args.customerContact as string };

  const conversations = await prisma.conversation.findMany({
    where,
    include: {
      messages: {
        take: 5,
        orderBy: { createdAt: "desc" },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  if (conversations.length === 0) {
    return JSON.stringify({
      success: true,
      history: [],
      message: "No previous conversations found for this customer.",
    });
  }

  const history = conversations.map((conv: { channel: string; status: string; createdAt: Date; summary: string; messages: Array<{ role: string; content: string }> }) => ({
    channel: conv.channel,
    status: conv.status,
    date: conv.createdAt,
    summary: conv.summary,
    messageCount: conv.messages.length,
    lastMessages: conv.messages.map((m: { role: string; content: string }) => ({
      role: m.role,
      content: m.content.substring(0, 200),
    })),
  }));

  return JSON.stringify({ success: true, history });
}

async function scheduleFollowup(
  args: Record<string, unknown>,
  conversationId?: string
): Promise<string> {
  const delayHours = Number(args.delayHours);
  if (!Number.isFinite(delayHours) || delayHours <= 0 || delayHours > 24 * 30) {
    return JSON.stringify({
      success: false,
      message: "delayHours must be between 0 and 720 (30 days).",
    });
  }
  const message = String(args.message ?? "").trim();
  if (!message) {
    return JSON.stringify({ success: false, message: "message is required." });
  }
  const convId = (args.conversationId as string) || conversationId;
  if (!convId) {
    return JSON.stringify({ success: false, message: "conversationId is required." });
  }

  const dueAt = new Date(Date.now() + delayHours * 3600_000);
  const followUp = await prisma.followUp.create({
    data: withBusinessId({
      conversationId: convId,
      message,
      dueAt,
      status: "pending",
    }),
  });

  // A cron job (POST /api/followups/process) picks due follow-ups up and
  // delivers them through the conversation's channel.
  return JSON.stringify({
    success: true,
    followUpId: followUp.id,
    message: `Follow-up scheduled in ${delayHours} hours: "${message}"`,
    scheduledFor: dueAt.toISOString(),
  });
}

/**
 * Order-taking path: the customer confirmed an order/booking. Persisted as a
 * Ticket (type order) with structured metadata so the dashboard shows it as
 * an actionable order the team can fulfill — never a fake confirmation.
 */
async function takeOrder(
  args: Record<string, unknown>,
  conversationId?: string
): Promise<string> {
  const { getBusinessId, getUnscopedPrisma } = await import("../prisma");
  const {
    getOrderFields,
    getMissingOrderFields,
    normalizeItems,
    createOrder,
  } = await import("../orders");

  // Fail-closed: no tenant context => no order.
  const businessId = getBusinessId();
  if (!businessId) {
    return JSON.stringify({
      success: false,
      message: "No business context for this order.",
    });
  }

  const serviceType = String(args.serviceType ?? "").trim();
  const details = String(args.details ?? "").trim();
  if (!serviceType || !details) {
    return JSON.stringify({
      success: false,
      message: "serviceType and details are required to record an order.",
    });
  }

  // Merge legacy top-level args into the custom-field map so older prompts
  // and simple calls keep working: each fills its matching field key when
  // the AI did not pass it explicitly in customFields.
  const customFields: Record<string, unknown> =
    args.customFields && typeof args.customFields === "object"
      ? { ...(args.customFields as Record<string, unknown>) }
      : {};
  const legacyMap: Record<string, string> = {
    customerName: "customer_name",
    customerPhone: "phone",
    pickup: "pickup",
    dropoff: "delivery_address",
    details: "notes",
  };
  for (const [argKey, fieldKey] of Object.entries(legacyMap)) {
    const v = args[argKey];
    if (
      v !== undefined &&
      v !== null &&
      String(v).trim() !== "" &&
      customFields[fieldKey] === undefined
    ) {
      customFields[fieldKey] = v;
    }
  }

  // Phase 2 slot check: every REQUIRED orderField the business defined must
  // be collected before the order is created. When something is missing we
  // return the exact list so the AI can ask the customer conversationally
  // and call take_order again — no deep slot-filling machinery needed yet.
  let orderFields;
  try {
    orderFields = await getOrderFields(businessId);
  } catch {
    orderFields = [];
  }
  const missing = getMissingOrderFields(orderFields, customFields);
  if (missing.length > 0) {
    return JSON.stringify({
      success: false,
      needsFields: missing,
      message:
        "Before recording the order, please collect the following details from the customer: " +
        missing
          .map(
            (f) =>
              `${f.label}${
                f.type === "select" && f.options
                  ? ` (choose one: ${f.options.join(", ")})`
                  : ""
              }`
          )
          .join("; ") +
        ". Then call take_order again with everything in customFields.",
    });
  }

  const items = normalizeItems(args.items);
  const rawTotal = args.total;
  const parsedTotal =
    rawTotal === null || rawTotal === undefined || rawTotal === ""
      ? null
      : Number(rawTotal);
  const total =
    parsedTotal !== null && Number.isFinite(parsedTotal) && parsedTotal >= 0
      ? parsedTotal
      : null;

  // Link the order to the conversation's customer when known. Never link
  // across tenants: the conversation must belong to this business.
  let customerId: string | null = null;
  if (conversationId) {
    try {
      const conv = (await getUnscopedPrisma().conversation.findUnique({
        where: { id: conversationId },
        select: { customerId: true, businessId: true },
      })) as { customerId?: string | null; businessId?: string } | null;
      if (conv && conv.businessId === businessId) {
        customerId = conv.customerId ?? null;
      }
    } catch {
      customerId = null;
    }
  }

  // The Phase 2 order doc — the source of truth in the tenant's `orders`
  // collection.
  const order = await createOrder({
    conversationId: conversationId ?? null,
    customerId,
    items,
    customFields,
    total,
    summary: `${serviceType}: ${details}`.slice(0, 300),
  });

  // Keep the ticket as the team's fulfillment queue (existing dashboard
  // surface), now linked to the order doc via metadata.orderId.
  const ticket = await prisma.ticket.create({
    data: withBusinessId({
      title: `Order: ${serviceType}`,
      description: [
        `Service: ${serviceType}`,
        args.pickup ? `Pickup: ${args.pickup}` : null,
        args.dropoff ? `Drop-off: ${args.dropoff}` : null,
        `Details: ${details}`,
        args.customerName ? `Customer: ${args.customerName}` : null,
        args.customerPhone ? `Phone: ${args.customerPhone}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
      priority: "high",
      status: "open",
      conversationId: conversationId || null,
      metadata: {
        kind: "order",
        orderId: order.id,
        serviceType,
        pickup: args.pickup ?? "",
        dropoff: args.dropoff ?? "",
        details,
        customerName: args.customerName ?? "",
        customerPhone: args.customerPhone ?? "",
        customFields,
        items,
        total,
        orderedAt: new Date().toISOString(),
      },
    }),
  });

  return JSON.stringify({
    success: true,
    orderId: order.id,
    ticketId: ticket.id,
    message:
      `Order recorded (${serviceType}). The team has been notified and will ` +
      `confirm shortly. Order reference: ${order.id.slice(0, 8)}.`,
  });
}

async function searchCatalogTool(args: Record<string, unknown>): Promise<string> {
  const { searchCatalog } = await import("../catalog");
  const results = await searchCatalog(String(args.query ?? ""), 5);
  return JSON.stringify({ success: true, results });
}

async function recommendAlternativeTool(args: Record<string, unknown>): Promise<string> {
  const { recommendAlternatives } = await import("../catalog");
  const { alternatives, reason } = await recommendAlternatives(String(args.query ?? ""), 3);
  return JSON.stringify({ success: true, reason, alternatives });
}

async function triggerWebhook(args: Record<string, unknown>): Promise<string> {
  const webhook = await prisma.webhook.findFirst({
    where: {
      name: { contains: args.webhookName as string, mode: "insensitive" },
      isActive: true,
    },
  });

  if (!webhook) {
    return JSON.stringify({
      success: false,
      message: `No active webhook found with name: ${args.webhookName}`,
    });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  let response: Response;
  try {
    response = await fetch(webhook.url, {
      method: webhook.method,
      headers: {
        "Content-Type": "application/json",
        ...(webhook.headers as Record<string, string>),
      },
      body: JSON.stringify(args.data || {}),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    const message = error instanceof Error && error.name === "AbortError"
      ? "Webhook request timed out after 10 seconds"
      : `Webhook request failed: ${error instanceof Error ? error.message : "Unknown error"}`;
    return JSON.stringify({ success: false, message });
  }
  clearTimeout(timeoutId);

  return JSON.stringify({
    success: response.ok,
    status: response.status,
    message: response.ok
      ? `Webhook "${webhook.name}" triggered successfully`
      : `Webhook failed with status ${response.status}`,
  });
}
