/**
 * Help-Center knowledge migration (owner order 2026-10-20 22:07).
 *
 * The main website's Help Center (ridebangla.bd/help-center) now runs on THIS
 * platform's own agent for the "Ride Bangla" business via POST
 * /api/chat/widget — the knowledge that used to be a hardcoded SYSTEM_PROMPT
 * inside the main website's server function lives HERE, in the business's
 * own platform data (Settings.agentBehavior + KnowledgeEntry rows), managed
 * afterwards from Admin → AI Management like every other business.
 *
 * This script is the migration vehicle: it upserts the Ride Bangla
 * business's settings + knowledge base WITH update payloads (the original
 * seed used `update: {}`, which never repairs already-seeded data — the
 * live business still carried the pre-2026-10-20 fare table the agent was
 * allowed to quote, "book through the customer app", and Studio listed as
 * coming soon). Idempotent: safe to re-run.
 *
 * Run: npx tsx scripts/seed-help-center-knowledge.ts
 * Uses the RAW (unscoped) Firestore client — setup-time code, not request
 * code. Requires FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and
 * FIREBASE_PRIVATE_KEY (see OPERATIONS.md §1).
 */
import { getUnscopedPrisma, closeDb } from "../src/lib/firestore";

// NOTE: intentionally the RAW client (no tenant scoping) — setup-time code.
const prisma = getUnscopedPrisma();

const EXPECTED_SITE_KEY = "rbsite-00f37b79c72f4e678febbd82d43bb46c";

/**
 * The business's behaviour instructions: the platform's existing Ride Bangla
 * behaviour (Sir/Ma'am address, convince-and-retain, honesty) with the fare
 * rule corrected to the owner's 2026-10-20 rule (NEVER quote figures), plus
 * the Help Center block migrated from the main website's former hardcoded
 * prompt — including the support-ticket marker protocol the website's
 * server function parses to create the Firestore support ticket with the
 * visitor's name + contact and honest confirmation/failure wording.
 */
const AGENT_BEHAVIOR = [
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
  "- Fares: NEVER quote any fare figure or amount. There is NO public rate chart — every delivery/ride charge is calculated from the road distance and confirmed with the customer when they order. If asked the charge, explain exactly that and offer the phone/WhatsApp (+880 1309-587749) for the exact fare for their trip. NEVER invent a per-km rate or any other number.",
  "- Coverage: Faridpur district ONLY right now. Expansion to other districts is roadmap (coming soon) — never present it as live, never name a district as served, never promise a date. For launch announcements, direct visitors to the website Updates page (https://ridebangla.bd/updates) and our social media.",
  "- Roadmap items (the apps, Ride Bangla Pay, area expansion) are ALWAYS \"coming soon / শীঘ্রই আসছে\" — never live, never with a launch date. Studio, the AI Agent, Tools and the IT Team are LIVE today — never present them as coming soon.",
  "- If you do not know something, say the team will confirm — never guess. Never claim access to a visitor's account, order, payment, live location, private records or admin systems.",
  "- Extra charge may apply after 10 PM, in bad weather (heavy rain/storm), or extreme winter cold, for rider safety — mention only when relevant to a booking question.",
  "",
  "HELP CENTER (website chat) — FORMAT:",
  "- Keep answers SHORT: 1-3 sentences for simple questions, maximum 5 sentences. Never write long paragraphs or essays.",
  "- Formatting: plain text ONLY. No *, #, -, numbers for lists, bold, italic, or emojis unless the visitor uses them first. Clean and natural, like a real conversation.",
  "- You serve everyone, not just customers: customers, riders, partners, agents and general visitors. If a question is role-specific (rider earnings, partner onboarding), answer for that role. Ask \"Are you a customer, rider, partner or agent?\" only if it helps give a better answer.",
  "- Riders earn by completing deliveries/rides (Rider app coming soon). Partners (restaurants/shops) can join to receive orders — contact the team to onboard. Agents help with local operations — contact the IT team for agent inquiries.",
  "",
  "HELP CENTER — SUPPORT TICKETS (read carefully):",
  "When a visitor asks for human help, a support ticket, or to talk to a live agent, do NOT create a ticket immediately. First ask what their actual problem or issue is in 1 warm sentence. Listen to their answer, try to help them yourself using the knowledge base.",
  "Only create a ticket when ALL of these are true:",
  "1. You know what their specific problem is (they told you, not just \"I want an agent\")",
  "2. You tried to help but cannot resolve it yourself",
  "3. The issue genuinely needs human attention (account problems, order issues, payment/refund, safety concerns, complaints)",
  "4. You have asked for their name and a phone number or email address so the team can contact them back, and you include what they gave you in the marker (if they do not want to share, you may still create the ticket with those parts left blank)",
  "To create a ticket, end your response with this exact marker on its own line:",
  "[TICKET:brief issue summary in 5-10 words|NAME:visitor name or blank|CONTACT:phone or email or blank]",
  "Do NOT create tickets for simple questions you can answer from the knowledge base, general inquiries, greetings, when the visitor is satisfied with your answer, or when you don't yet know what their problem is.",
  "Do NOT write that a ticket has been created or that the team will contact them — the system adds the real confirmation itself once the ticket is actually saved. End your message with one warm neutral line, like \"I am passing this to our support team now.\", followed by the marker.",
  "URGENT issues (safety concern, ongoing delivery problem, emergency): do NOT just create a ticket — FIRST give direct live contact: call +880 1309-587749 or WhatsApp https://wa.me/8801309587749 immediately. Say this clearly and warmly.",
].join("\n");

const BUSINESS_DESC =
  "Ride Bangla is a Bangladesh multi-service platform offering ride sharing (bike/car), food delivery, courier/parcel delivery, and marketplace (food, grocery, medicine from licensed pharmacies with prescription verification). Currently serving Faridpur district only; expanding gradually to other districts.";

const CATEGORIES = [
  { id: "cat-services", name: "Services", description: "Ride Bangla services", icon: "package", color: "#22C55E", sortOrder: 0 },
  { id: "cat-coverage", name: "Coverage", description: "Service areas", icon: "map-pin", color: "#3B82F6", sortOrder: 1 },
  { id: "cat-fares", name: "Fares", description: "Distance-based pricing — never quote figures", icon: "tag", color: "#F59E0B", sortOrder: 2 },
  { id: "cat-contact", name: "Contact", description: "How to reach the team", icon: "phone", color: "#4A7C9B", sortOrder: 3 },
  { id: "cat-roadmap", name: "Roadmap", description: "Coming soon — never present as live", icon: "rocket", color: "#8B5CF6", sortOrder: 4 },
  { id: "cat-about", name: "About", description: "Company facts", icon: "building", color: "#0EA5E9", sortOrder: 5 },
  { id: "cat-platforms", name: "Platforms", description: "AI Agent, Studio, Tools, IT Team, Pay", icon: "layout-grid", color: "#14B8A6", sortOrder: 6 },
];

const ENTRIES = [
  {
    id: "entry-services",
    categoryId: "cat-services",
    title: "Our Services",
    content:
      "Ride Bangla Limited — Faridpur's multi-service platform. CURRENT services (all live now, Faridpur district only): (1) Food delivery — order from local restaurants; (2) Ride sharing — bike rides and car rentals (all transport follows Bangladesh road and BRTA rules); (3) Courier/parcel delivery — send parcels and documents; (4) Marketplace — food, grocery, and medicine from licensed pharmacies (a valid prescription is verified for every medicine order). Order by phone or WhatsApp (+880 1309-587749) or through the Customer website (customer.ridebangla.bd) — the Ride Bangla apps are coming soon, not launched yet. / রাইড বাংলা লিমিটেড — ফরিদপুরের মাল্টি-সার্ভিস প্ল্যাটফর্ম। বর্তমান সার্ভিস (শুধু ফরিদপুর জেলায়): (১) ফুড ডেলিভারি; (২) রাইড শেয়ারিং — বাইক ও কার; (৩) কুরিয়ার/পার্সেল ডেলিভারি; (৪) মার্কেটপ্লেস — খাবার, গ্রোসারি ও লাইসেন্সপ্রাপ্ত ফার্মেসির ঔষধ (প্রেসক্রিপশন যাচাই বাধ্যতামূলক)।",
    priority: 10,
  },
  {
    id: "entry-coverage",
    categoryId: "cat-coverage",
    title: "Service Coverage",
    content:
      "HONEST coverage: Ride Bangla currently serves FARIDPUR DISTRICT ONLY (launch area). If a customer is outside Faridpur (for example Dhaka or anywhere else), say so honestly and warmly — never claim we serve there — and offer to note their area and phone number so the team can notify them when we launch there. New district launches are announced on the website Updates page (https://ridebangla.bd/updates), the Google Business Profile and our social media — never guess or promise a launch date.",
    priority: 9,
  },
  {
    id: "entry-fares",
    categoryId: "cat-fares",
    title: "Fares — distance-based, never quote figures",
    content:
      "FARES — NEVER QUOTE FIGURES: there is NO public rate chart and Ride Bangla does not publish fixed fare amounts. Every delivery/ride charge is calculated from the delivery (road) distance and confirmed with the customer when they order. If a customer asks what the charge will be, explain that it is distance-based and confirmed at booking, and give the phone/WhatsApp (+880 1309-587749) for the exact fare for their trip. NEVER invent a per-km rate or any taka amount. COURIER rule: the CUSTOMER declares what they are sending and its value — Ride Bangla NEVER sets the product's price; the company only charges the carrying (delivery) fare. MARKETPLACE rule: the PARTNER sets the product price; the customer pays product price + delivery fare.",
    priority: 9,
  },
  {
    id: "entry-roadmap",
    categoryId: "cat-roadmap",
    title: "Live platforms vs coming soon",
    content:
      "LIVE TODAY (never present as coming soon): Ride Bangla AI Agent (ai.ridebangla.bd), Ride Bangla Studio (studio.ridebangla.bd), Ride Bangla Tools (tools.ridebangla.bd) and the Ride Bangla IT Team (it.ridebangla.bd) — see their own knowledge entries. COMING SOON — always presented as \"শীঘ্রই আসছে / coming soon\", NEVER as live, NEVER with a launch date: (1) the Ride Bangla apps (customer, rider, partner, agent — not launched yet, no date announced); (2) Ride Bangla Pay (digital wallet — not launched yet); (3) area expansion beyond Faridpur, gradually, announced on the website Updates page. When a customer asks about a coming-soon item: present it warmly as coming soon, offer to note their interest and phone number so the team notifies them at launch.",
    priority: 8,
  },
  {
    id: "entry-contact",
    categoryId: "cat-contact",
    title: "Contact Information",
    content:
      "URGENT or SAFETY issues: call the hotline +880 1309-587749 FIRST (call or WhatsApp) — before anything else. Main phone: +880 1309-587749 (call to order). WhatsApp: https://wa.me/8801309587749. Email: info@ridebangla.bd (general) and support@ridebangla.bd (support) — share these whenever a visitor asks how to contact us in writing. IT Team: +880 1825-234644. Website: https://ridebangla.bd. Hours: 24/7. / জরুরি বা নিরাপত্তা বিষয়ে: প্রথমেই হটলাইন +880 1309-587749-এ কল করুন।",
    priority: 8,
  },
  {
    id: "entry-about",
    categoryId: "cat-about",
    title: "About Ride Bangla",
    content:
      "Ride Bangla Limited is a Faridpur-based multi-service company: food delivery, ride sharing, courier/parcel delivery, and marketplace (food, grocery, medicine). All transport operations follow Bangladesh road and BRTA rules. Google Business Profile: \"Ride Bangla Limited\" — rated 5.0 out of 5 stars from Google reviews (all 5-star). Address: Faridpur 7803 (plus code JV2C+GR Faridpur). Open 24 hours. Areas served: Faridpur District. Profile link: https://share.google/t70JxUCRYzz55QXCh — if asked about Google reviews or rating, share this info and the link.",
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
  {
    id: "entry-ordering",
    categoryId: "cat-services",
    title: "How to order",
    content:
      "To order a ride, food, groceries, medicine or a courier pickup: call +880 1309-587749, message us on WhatsApp (https://wa.me/8801309587749), or use the Customer website https://customer.ridebangla.bd. The Customer APPS are coming soon — not launched yet. Food and marketplace prices: the partner restaurant or shop sets the product price; the customer pays the product price plus the delivery fare. Medicine: medicines are supplied through licensed pharmacies; prescription-only medicine needs a valid prescription from a registered doctor — the team may ask to see the prescription before confirming the order.",
    priority: 9,
  },
  {
    id: "entry-ai-agent",
    categoryId: "cat-platforms",
    title: "Ride Bangla AI Agent (live)",
    content:
      "Ride Bangla AI Agent (https://ai.ridebangla.bd) is LIVE: our AI customer-service platform for businesses — an AI agent that answers a business's customers on its website and social channels, helps them choose products, takes orders and replies 24/7. Pricing: Starter $19/month, Growth $49/month, Pro $99/month. Every business starts with a 30-day free trial, no credit card needed. Yearly billing gives 2 months free.",
    priority: 8,
  },
  {
    id: "entry-studio",
    categoryId: "cat-platforms",
    title: "Ride Bangla Studio (live)",
    content:
      "Ride Bangla Studio (https://studio.ridebangla.bd) is LIVE: our AI creative studio for making product promo videos and pictures, with 5 generation modes — text to video, text to image, photo to photo, photo to video, and text plus photo to video. The Free plan gives 2 videos (up to 10 seconds) and 2 pictures every day, no card needed; paid plans raise the daily limits.",
    priority: 8,
  },
  {
    id: "entry-tools",
    categoryId: "cat-platforms",
    title: "Ride Bangla Tools (live)",
    content:
      "Ride Bangla Tools (https://tools.ridebangla.bd) is LIVE: 54 free online tools — PDF, image, QR, calculators, text tools and more. Completely free, no signup or account needed.",
    priority: 8,
  },
  {
    id: "entry-it-team",
    categoryId: "cat-platforms",
    title: "Ride Bangla IT Team (live)",
    content:
      "Ride Bangla IT Team (https://it.ridebangla.bd) is LIVE: our technology team builds websites and apps for businesses — web and app development, UI/UX design, graphic design, hosting and domain, digital marketing and IT support. For a project quote, call the IT Team at +880 1825-234644.",
    priority: 8,
  },
  {
    id: "entry-pay",
    categoryId: "cat-platforms",
    title: "Ride Bangla Pay (coming soon)",
    content:
      "Ride Bangla Pay is our upcoming digital wallet and payment service. It is NOT launched yet — never present it as live and never give a launch date. It will be announced on the website Updates page when it becomes available.",
    priority: 7,
  },
  {
    id: "entry-social",
    categoryId: "cat-contact",
    title: "Social media",
    content:
      "Follow Ride Bangla: Facebook https://facebook.com/ridebangla — Instagram https://www.instagram.com/ride.bangla_ — YouTube https://www.youtube.com/@ridebangla-0 (Shorts & videos also on the website Updates page) — TikTok https://www.tiktok.com/@ridebangla0. Share these when a visitor asks, or to suggest following for launch updates.",
    priority: 6,
  },
];

async function main() {
  const business = await prisma.business.findUnique({
    where: { slug: "ride-bangla" },
  });
  if (!business) {
    throw new Error(
      'Business with slug "ride-bangla" not found — run scripts/seed.ts first.'
    );
  }
  const bid = business.id as string;
  if (business.siteKey !== EXPECTED_SITE_KEY) {
    console.warn(
      `[warn] Ride Bangla business siteKey is "${business.siteKey}", expected "${EXPECTED_SITE_KEY}" (the main website's Help Center uses the expected key). Continuing with the business found by slug — verify the website uses THIS business's key.`
    );
  }
  console.log(`Migrating Help Center knowledge for business ${bid} (slug: ride-bangla)`);

  // Settings: corrected description + full behaviour (WITH update payload —
  // this is the point of the migration: repair already-seeded data).
  await prisma.settings.upsert({
    where: { businessId: bid },
    update: { businessDesc: BUSINESS_DESC, agentBehavior: AGENT_BEHAVIOR },
    create: {
      businessId: bid,
      businessName: "Ride Bangla",
      businessDesc: BUSINESS_DESC,
      welcomeMessage:
        "Hello! Welcome to Ride Bangla support. How can I help you today? / আসসালামু আলাইকুম! Ride Bangla সাপোর্টে স্বাগতম। আমি কীভাবে সাহায্য করতে পারি?",
      tone: "friendly",
      language: "auto",
      agentBehavior: AGENT_BEHAVIOR,
    },
  });
  console.log("✓ settings (businessDesc + agentBehavior) upserted");

  for (const c of CATEGORIES) {
    await prisma.category.upsert({
      where: { id: c.id },
      update: { name: c.name, description: c.description, icon: c.icon, color: c.color, sortOrder: c.sortOrder },
      create: { ...c, businessId: bid },
    });
  }
  console.log(`✓ ${CATEGORIES.length} knowledge categories upserted`);

  for (const e of ENTRIES) {
    await prisma.knowledgeEntry.upsert({
      where: { id: e.id },
      update: { categoryId: e.categoryId, title: e.title, content: e.content, priority: e.priority, isActive: true },
      create: { ...e, businessId: bid, isActive: true },
    });
  }
  console.log(`✓ ${ENTRIES.length} knowledge entries upserted (with updates)`);
  console.log("Help Center knowledge migration complete.");
}

main()
  .catch((err) => {
    console.error("Help Center knowledge migration FAILED:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
