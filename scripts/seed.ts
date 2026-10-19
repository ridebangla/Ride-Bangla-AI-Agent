/**
 * Seed script: creates the default business ("Ride Bangla"), the Super Admin
 * account, per-business settings, channels, business hours, departments,
 * team members, knowledge base, tags, canned responses and SLA rules.
 *
 * Run: npx tsx scripts/seed.ts
 *
 * Uses the RAW (unscoped) Firestore client — setup-time code, not request
 * code. Requires FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and
 * FIREBASE_PRIVATE_KEY (see OPERATIONS.md §1).
 */
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { getUnscopedPrisma, closeDb } from "../src/lib/firestore";

// NOTE: the seed intentionally uses the RAW client (no tenant scoping) —
// it is setup-time code, not request code.
const prisma = getUnscopedPrisma();

function siteKey() {
  return "rbsite-" + randomUUID().replace(/-/g, "");
}

async function main() {
  // The default business. The user starts with Ride Bangla's own use.
  const business = await prisma.business.upsert({
    where: { slug: "ride-bangla" },
    update: {},
    create: {
      name: "Ride Bangla",
      slug: "ride-bangla",
      siteKey: siteKey(),
      isActive: true,
    },
  });
  const bid = business.id;

  // First admin = Super Admin (businessId null => sees every business).
  // Change the password immediately after first login.
  const hashedPassword = await bcrypt.hash("admin123", 12);
  await prisma.admin.upsert({
    where: { username: "admin" },
    update: {},
    create: {
      username: "admin",
      password: hashedPassword,
      name: "Administrator",
      role: "super_admin",
      businessId: null,
    },
  });

  // Per-business settings
  // The agent's behavior for Ride Bangla: polite Sir/Ma'am addressing,
  // convince-and-retain (never a dead end), and strict honesty rules
  // (only quotable fares, Faridpur-only coverage, roadmap = coming soon).
  const RIDE_BANGLA_AGENT_BEHAVIOR = [
    "CUSTOMER ADDRESS — MANDATORY:",
    "- Address EVERY customer as স্যার (Sir) / ম্যাডাম (Ma'am) in every reply. Never use casual or familiar forms.",
    "- Be মার্জিত: polite, warm, respectful and human — like the company's best customer representative.",
    "- Match the customer's language: Bengali (বাংলা) → natural polished Bengali; English → natural English. Never mix languages in one reply unless the customer does.",
    "",
    "CONVINCE & RETAIN — NEVER A DEAD END:",
    "- Never end with \"নেই / পারবো না / can't help\". If the exact request cannot be fulfilled, ALWAYS: (1) acknowledge warmly, (2) offer the closest available alternative service, or present the relevant roadmap item as \"শীঘ্রই আসছে\" (coming soon), (3) offer to note their interest and phone number so the team can notify them at launch.",
    "- Your goal: the customer always leaves with interest and a clear next step — never empty-handed.",
    "",
    "HONESTY — NEVER HALLUCINATE:",
    "- Fares you may quote: delivery/courier 0–5 km = ৳50, 5–7 km = ৳70. For distances ABOVE 7 km, say the team calculates the fare manually for each order — NEVER invent a per-km rate or any other number.",
    "- Coverage: Faridpur district ONLY right now. Shariatpur and nationwide expansion are roadmap (coming soon) — never present them as live.",
    "- Roadmap items (Studio, expansions, new modules) are ALWAYS \"coming soon / শীঘ্রই আসছে\" — never live, never with a launch date.",
    "- If you do not know something, say the team will confirm — never guess.",
  ].join("\n");

  await prisma.settings.upsert({
    where: { businessId: bid },
    update: {},
    create: {
      businessId: bid,
      businessName: "Ride Bangla",
      businessDesc:
        "Ride Bangla is a Bangladesh multi-service platform offering ride sharing (bike/car), food delivery, courier/parcel delivery, and marketplace (food, grocery, medicine from licensed pharmacies with prescription verification). Currently serving Faridpur district only; expanding to Shariatpur and nationwide.",
      welcomeMessage:
        "Hello! Welcome to Ride Bangla support. How can I help you today? / আসসালামু আলাইকুম! Ride Bangla সাপোর্টে স্বাগতম। আমি কীভাবে সাহায্য করতে পারি?",
      tone: "friendly",
      language: "auto",
      agentBehavior: RIDE_BANGLA_AGENT_BEHAVIOR,
    },
  });

  // Default channels (business-scoped)
  for (const type of ["whatsapp", "email", "phone", "telegram"]) {
    await prisma.channel.upsert({
      where: { businessId_type: { businessId: bid, type } },
      update: {},
      create: { businessId: bid, type, isActive: false, status: "disconnected" },
    });
  }

  // Business hours
  await prisma.businessHours.upsert({
    where: { businessId: bid },
    update: {},
    create: { businessId: bid, timezone: "Asia/Dhaka" },
  });

  // Departments
  const techDept = await prisma.department.upsert({
    where: { id: "dept-tech" },
    update: {},
    create: {
      id: "dept-tech",
      businessId: bid,
      name: "Technical Support",
      description: "Handles technical issues, bugs, and product troubleshooting",
      email: "tech@example.com",
    },
  });

  const salesDept = await prisma.department.upsert({
    where: { id: "dept-sales" },
    update: {},
    create: {
      id: "dept-sales",
      name: "Sales",
      businessId: bid,
      description: "Handles pricing, quotes, and purchase inquiries",
      email: "sales@example.com",
    },
  });

  const billingDept = await prisma.department.upsert({
    where: { id: "dept-billing" },
    update: {},
    create: {
      id: "dept-billing",
      name: "Billing",
      businessId: bid,
      description: "Handles invoices, payments, and refunds",
      email: "billing@example.com",
    },
  });

  // Team members
  const members = [
    { id: "member-1", name: "John Smith", email: "john@example.com", role: "Lead", expertise: "software, debugging, API issues", departmentId: techDept.id },
    { id: "member-2", name: "Sarah Johnson", email: "sarah@example.com", role: "Member", expertise: "networking, infrastructure, deployment", departmentId: techDept.id },
    { id: "member-3", name: "Mike Davis", email: "mike@example.com", role: "Lead", expertise: "pricing, enterprise deals, partnerships", departmentId: salesDept.id },
    { id: "member-4", name: "Emily Brown", email: "emily@example.com", role: "Lead", expertise: "invoices, refunds, payment processing", departmentId: billingDept.id },
  ];

  for (const m of members) {
    await prisma.teamMember.upsert({
      where: { id: m.id },
      update: {},
      create: { ...m, businessId: bid },
    });
  }

  // Knowledge base (real, verified facts only)
  const categories = [
    { id: "cat-services", name: "Services", description: "Ride Bangla services", icon: "package", color: "#22C55E", sortOrder: 0 },
    { id: "cat-coverage", name: "Coverage", description: "Service areas", icon: "map-pin", color: "#3B82F6", sortOrder: 1 },
    { id: "cat-fares", name: "Fares", description: "Pricing and fare table", icon: "tag", color: "#F59E0B", sortOrder: 2 },
    { id: "cat-contact", name: "Contact", description: "How to reach the team", icon: "phone", color: "#4A7C9B", sortOrder: 3 },
    { id: "cat-roadmap", name: "Roadmap", description: "Coming soon — never present as live", icon: "rocket", color: "#8B5CF6", sortOrder: 4 },
    { id: "cat-about", name: "About", description: "Company facts", icon: "building", color: "#0EA5E9", sortOrder: 5 },
  ];

  for (const c of categories) {
    await prisma.category.upsert({ where: { id: c.id }, update: {}, create: { ...c, businessId: bid } });
  }

  const entries = [
    {
      id: "entry-services",
      categoryId: "cat-services",
      title: "Our Services",
      content:
        "Ride Bangla Limited — Faridpur's multi-service platform. CURRENT services (all live now, Faridpur district only): (1) Food delivery — order from local restaurants; (2) Ride sharing — bike rides and car rentals (all transport follows Bangladesh road and BRTA rules); (3) Courier/parcel delivery — send parcels and documents; (4) Marketplace — food, grocery, and medicine from licensed pharmacies (a valid prescription is verified for every medicine order). Everything is booked through the Ride Bangla customer app. / রাইড বাংলা লিমিটেড — ফরিদপুরের মাল্টি-সার্ভিস প্ল্যাটফর্ম। বর্তমান সার্ভিস (শুধু ফরিদপুর জেলায়): (১) ফুড ডেলিভারি; (২) রাইড শেয়ারিং — বাইক ও কার; (৩) কুরিয়ার/পার্সেল ডেলিভারি; (৪) মার্কেটপ্লেস — খাবার, গ্রোসারি ও লাইসেন্সপ্রাপ্ত ফার্মেসির ঔষধ (প্রেসক্রিপশন যাচাই বাধ্যতামূলক)।",
      priority: 10,
    },
    {
      id: "entry-coverage",
      categoryId: "cat-coverage",
      title: "Service Coverage",
      content:
        "HONEST coverage: Ride Bangla currently serves FARIDPUR DISTRICT ONLY (launch area). If a customer is outside Faridpur (for example Dhaka or anywhere else), say so honestly and warmly — never claim we serve there — and offer to note their area and phone number so the team can notify them when we launch there.",
      priority: 9,
    },
    {
      id: "entry-fares",
      categoryId: "cat-fares",
      title: "Fares — what the agent may quote",
      content:
        "Delivery/courier fare the AGENT MAY QUOTE: 0–5 km = ৳50, 5–7 km = ৳70. ABOVE 7 km: the team calculates the fare manually for each order — the agent must NEVER invent a per-km rate or any other number. COURIER rule: the CUSTOMER declares the product's value — Ride Bangla NEVER sets the product's price; the company only charges the carrying (delivery) fare. MARKETPLACE rule: the PARTNER sets the product price; the customer pays product price + delivery fare. The fare is always confirmed with the customer before payment.",
      priority: 9,
    },
    {
      id: "entry-roadmap",
      categoryId: "cat-roadmap",
      title: "Coming soon (roadmap — NEVER live)",
      content:
        "COMING SOON — always presented as \"শীঘ্রই আসছে / coming soon\", NEVER as live, NEVER with a launch date: (1) Area expansion — Shariatpur next, then nationwide across Bangladesh gradually; (2) Ride Bangla Studio — AI video + picture ad creation for businesses (product ads, company ads); (3) More AI platform modules over time. When a customer asks about any of these: present it warmly as coming soon, offer to note their interest and phone number so the team notifies them at launch.",
      priority: 8,
    },
    {
      id: "entry-contact",
      categoryId: "cat-contact",
      title: "Contact Information",
      content:
        "URGENT or SAFETY issues: call the hotline +880 1309-587749 FIRST (call or WhatsApp) — before anything else. General inquiries: IT Team +880 1825-234644. Website: https://ridebangla.bd. / জরুরি বা নিরাপত্তা বিষয়ে: প্রথমেই হটলাইন +880 1309-587749-এ কল করুন।",
      priority: 8,
    },
    {
      id: "entry-about",
      categoryId: "cat-about",
      title: "About Ride Bangla",
      content:
        "Ride Bangla Limited is a Faridpur-based multi-service company: food delivery, ride sharing, courier/parcel delivery, and marketplace (food, grocery, medicine). All transport operations follow Bangladesh road and BRTA rules.",
      priority: 7,
    },
    {
      id: "entry-language",
      categoryId: "cat-contact",
      title: "Language Support",
      content:
        "We support both Bengali (বাংলা) and English. Ask in whichever language you prefer — the agent will reply in the same language.",
      priority: 7,
    },
  ];

  for (const e of entries) {
    await prisma.knowledgeEntry.upsert({ where: { id: e.id }, update: {}, create: { ...e, businessId: bid } });
  }

  // Tags
  const tags = [
    { id: "tag-1", name: "Urgent", color: "#EF4444" },
    { id: "tag-2", name: "VIP", color: "#F59E0B" },
    { id: "tag-3", name: "Follow-up", color: "#3B82F6" },
    { id: "tag-4", name: "Resolved", color: "#22C55E" },
    { id: "tag-5", name: "Bug", color: "#8B5CF6" },
  ];

  for (const t of tags) {
    await prisma.tag.upsert({
      where: { businessId_name: { businessId: bid, name: t.name } },
      update: {},
      create: { ...t, businessId: bid },
    });
  }

  // Canned responses
  const cannedResponses = [
    { id: "cr-1", title: "Greeting", content: "Hello! Thank you for contacting Ride Bangla. How can I help you today? / আসসালামু আলাইকুম! Ride Bangla-তে যোগাযোগ করার জন্য ধন্যবাদ। আমি কীভাবে সাহায্য করতে পারি?", category: "General", shortcut: "/greeting" },
    { id: "cr-2", title: "Closing", content: "Thank you for contacting Ride Bangla! Is there anything else I can help you with? / ধন্যবাদ! আর কিছু জানতে চান?", category: "General", shortcut: "/closing" },
    { id: "cr-3", title: "Coverage Check", content: "We currently serve Faridpur district and are expanding nationwide. Which area are you in? / আমরা বর্তমানে ফরিদপুর জেলায় সার্ভিস দিচ্ছি এবং সারা দেশে সম্প্রসারণ করছি। আপনি কোন এলাকায়?", category: "Support", shortcut: "/coverage" },
    { id: "cr-4", title: "Escalation", content: "I'll connect you with our team who can better assist you. For urgent help, call +880 1309-587749. / আমি আপনাকে আমাদের টিমের সাথে যুক্ত করছি। জরুরি সাহায্যের জন্য কল করুন +880 1309-587749।", category: "Support", shortcut: "/escalate" },
  ];

  for (const cr of cannedResponses) {
    await prisma.cannedResponse.upsert({ where: { id: cr.id }, update: {}, create: { ...cr, businessId: bid } });
  }

  // SLA rules
  const slaRules = [
    { id: "sla-1", name: "Standard Response", description: "Default response time for all channels", firstResponseMins: 30, resolutionMins: 480 },
    { id: "sla-2", name: "Urgent Priority", description: "Fast response for urgent issues", priority: "urgent", firstResponseMins: 5, resolutionMins: 60 },
  ];

  for (const sla of slaRules) {
    await prisma.sLARule.upsert({ where: { id: sla.id }, update: {}, create: { ...sla, businessId: bid } });
  }

  console.log("Seed data created successfully!");
  console.log("Business: Ride Bangla (slug: ride-bangla)");
  console.log("Widget site key:", business.siteKey, "(put in the chat widget's data-site-key)");
  console.log("Super Admin: username=admin, password=admin123  -- CHANGE IT after first login.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await closeDb();
  });
