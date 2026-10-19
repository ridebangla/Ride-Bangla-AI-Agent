import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";

// Mock OpenAI
const mockOpenAICreateFn = vi.fn();
vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: mockOpenAICreateFn,
        },
      };
      audio = {
        transcriptions: { create: vi.fn() },
      };
    },
  };
});

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

const CATALOG = [
  {
    id: "p-cake",
    name: "Chocolate Cake",
    description: "Rich chocolate sponge with ganache",
    price: 850,
    currency: "BDT",
    imageUrl: "https://example.com/cake.jpg",
    tags: "cake,birthday,dessert",
    isAvailable: true,
    category: { name: "Bakery" },
  },
  {
    id: "p-bread",
    name: "Sourdough Bread",
    description: "Crusty artisan loaf",
    price: 220,
    currency: "BDT",
    imageUrl: "",
    tags: "bread",
    isAvailable: true,
    category: { name: "Bakery" },
  },
];

const DEFAULT_SETTINGS = {
  id: "default",
  businessName: "Test Biz",
  businessDesc: "A test business",
  welcomeMessage: "Hello!",
  tone: "friendly",
  language: "auto",
  aiProvider: "openai",
  aiModel: "gpt-4",
  aiApiKey: "sk-test",
  maxTokens: 1000,
  temperature: 0.7,
};

const DEFAULT_CONVERSATION = {
  id: "conv-1",
  channel: "widget",
  customerName: "Visitor",
  customerContact: "v-1",
  status: "active",
  aiEnabled: true,
  messages: [],
};

describe("Phase 3: deterministic product matching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOpenAICreateFn.mockReset();
    mockPrisma.settings.findFirst.mockResolvedValue(DEFAULT_SETTINGS);
    mockPrisma.knowledgeEntry.findMany.mockResolvedValue([]);
    mockPrisma.conversation.findUnique.mockResolvedValue(DEFAULT_CONVERSATION);
    mockPrisma.message.create.mockResolvedValue({ id: "msg-new" });
    mockPrisma.conversation.update.mockResolvedValue({});
  });

  it("matches a product named in the customer message (name-weighted)", async () => {
    mockPrisma.product.findMany.mockResolvedValue(CATALOG);
    const { matchProductsInMessage } = await import("@/lib/catalog");
    const hits = await matchProductsInMessage("Do you have chocolate cake?");
    expect(hits.length).toBe(1);
    expect(hits[0].name).toBe("Chocolate Cake");
    expect(hits[0].price).toBe(850);
  });

  it("returns nothing for casual chatter with no product terms", async () => {
    mockPrisma.product.findMany.mockResolvedValue(CATALOG);
    const { matchProductsInMessage } = await import("@/lib/catalog");
    expect(await matchProductsInMessage("hello there friend")).toEqual([]);
    expect(await matchProductsInMessage("")).toEqual([]);
  });

  it("does not card on a weak description-only term", async () => {
    // "price" appears only in the description -> score 1 < 3 -> no card.
    mockPrisma.product.findMany.mockResolvedValue(CATALOG);
    const { matchProductsInMessage } = await import("@/lib/catalog");
    expect(await matchProductsInMessage("what is the price")).toEqual([]);
  });

  it("matches tags and is case-insensitive", async () => {
    mockPrisma.product.findMany.mockResolvedValue(CATALOG);
    const { matchProductsInMessage } = await import("@/lib/catalog");
    const hits = await matchProductsInMessage("BIRTHDAY dessert ideas?");
    expect(hits.length).toBe(1);
    expect(hits[0].id).toBe("p-cake");
  });
});

describe("Phase 3: product cards in the chat pipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOpenAICreateFn.mockReset();
    mockPrisma.settings.findFirst.mockResolvedValue(DEFAULT_SETTINGS);
    mockPrisma.knowledgeEntry.findMany.mockResolvedValue([]);
    mockPrisma.conversation.findUnique.mockResolvedValue(DEFAULT_CONVERSATION);
    mockPrisma.message.create.mockResolvedValue({ id: "msg-new" });
    mockPrisma.conversation.update.mockResolvedValue({});
    mockPrisma.product.findMany.mockResolvedValue(CATALOG);
    mockPrisma.productCategory.findMany.mockResolvedValue([]);
  });

  it("attaches deterministic cards without an AI key (graceful, never faked)", async () => {
    mockPrisma.settings.findFirst.mockResolvedValue({ ...DEFAULT_SETTINGS, aiApiKey: "" });
    const { chat } = await import("@/lib/ai/engine");
    const result = await chat("conv-1", "Do you have chocolate cake?");

    expect(result.silent).toBe(false);
    expect(result.response).toContain("AI brain isn't connected");
    expect(result.products.length).toBe(1);
    expect(result.products[0]).toMatchObject({
      id: "p-cake",
      name: "Chocolate Cake",
      price: 850,
      currency: "BDT",
      imageUrl: "https://example.com/cake.jpg",
    });
    // No LLM was touched.
    expect(mockOpenAICreateFn).not.toHaveBeenCalled();
  });

  it("collects show_products tool cards into the response payload", async () => {
    mockOpenAICreateFn
      .mockResolvedValueOnce({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "show_products",
                    arguments: JSON.stringify({ query: "cake", limit: 3 }),
                  },
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            finish_reason: "stop",
            message: { content: "Here are our cakes!" },
          },
        ],
      });

    const { chat } = await import("@/lib/ai/engine");
    const result = await chat("conv-1", "show me cakes");

    expect(result.response).toBe("Here are our cakes!");
    expect(result.products.length).toBeGreaterThan(0);
    expect(result.products[0].id).toBe("p-cake");
  });

  it("human takeover: stores the message and stays purely silent", async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({
      ...DEFAULT_CONVERSATION,
      aiEnabled: false,
    });

    const { chat } = await import("@/lib/ai/engine");
    const result = await chat("conv-1", "Is anyone there?");

    expect(result.silent).toBe(true);
    expect(result.response).toBe("");
    expect(result.products).toEqual([]);
    // Customer message stored...
    expect(mockPrisma.message.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          conversationId: "conv-1",
          role: "customer",
          content: "Is anyone there?",
        }),
      })
    );
    // ...but zero AI interjection: no LLM call, no assistant message.
    expect(mockOpenAICreateFn).not.toHaveBeenCalled();
  });
});

describe("Phase 3: show_products tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.product.findMany.mockResolvedValue(CATALOG);
  });

  it("returns matched catalog products as JSON", async () => {
    const { executeToolCall } = await import("@/lib/ai/tools");
    const raw = await executeToolCall("show_products", { query: "sourdough" });
    const parsed = JSON.parse(raw);
    expect(parsed.success).toBe(true);
    expect(parsed.shown_to_customer).toBe(true);
    expect(parsed.products[0]).toMatchObject({
      id: "p-bread",
      name: "Sourdough Bread",
      price: 220,
    });
  });

  it("reports no match honestly when nothing fits", async () => {
    const { executeToolCall } = await import("@/lib/ai/tools");
    const parsed = JSON.parse(
      await executeToolCall("show_products", { query: "spaceship" })
    );
    expect(parsed.success).toBe(true);
    expect(parsed.shown_to_customer).toBe(false);
    expect(parsed.products).toEqual([]);
  });
});

describe("Phase 3a: auto-categories (rule-based)", () => {
  it("groups by product-type keywords", async () => {
    const { planAutoCategories } = await import("@/lib/catalog");
    const groups = planAutoCategories([
      { id: "1", name: "Chocolate Cake", description: "", price: 850, tags: "birthday" },
      { id: "2", name: "Vanilla Sponge", description: "light cake", price: 700, tags: "" },
      { id: "3", name: "Sourdough Bread", description: "", price: 220, tags: "" },
    ]);
    const cakes = groups.find((g) => g.name === "Cakes");
    expect(cakes).toBeDefined();
    expect(cakes!.productIds.sort()).toEqual(["1", "2"]);
    // small catalog: singleton groups are kept (no clutter to clean up)
    const breads = groups.find((g) => g.name === "Breads & Bakery");
    expect(breads!.productIds).toEqual(["3"]);
  });

  it("clusters by shared tags and names the group after the tag", async () => {
    const { planAutoCategories } = await import("@/lib/catalog");
    const groups = planAutoCategories([
      { id: "1", name: "Mango Lassi", description: "", price: 120, tags: "summer, drinks" },
      { id: "2", name: "Lemon Mint", description: "", price: 100, tags: "summer, drinks" },
      { id: "3", name: "Cold Brew", description: "", price: 180, tags: "drinks" },
    ]);
    expect(groups.length).toBe(1);
    expect(groups[0].productIds.sort()).toEqual(["1", "2", "3"]);
    expect(groups[0].name).toMatch(/drinks/i);
  });

  it("puts priceless items into Services", async () => {
    const { planAutoCategories } = await import("@/lib/catalog");
    const groups = planAutoCategories([
      { id: "1", name: "Sofa Shampooing", description: "deep shampoo", price: null, tags: "" },
      { id: "2", name: "Plumbing Checkup", description: "", price: null, tags: "" },
    ]);
    const services = groups.find((g) => g.name === "Services");
    expect(services!.productIds.sort()).toEqual(["1", "2"]);
  });

  it("autoCategorizeProducts creates categories and assigns products (tenant-scoped)", async () => {
    const { autoCategorizeProducts } = await import("@/lib/catalog");
    mockPrisma.product.findMany.mockResolvedValue([
      { id: "p1", name: "Chocolate Cake", description: "", price: 850, tags: "", categoryId: null },
      { id: "p2", name: "Cheese Pizza", description: "", price: 550, tags: "", categoryId: null },
    ]);
    mockPrisma.productCategory.findMany.mockResolvedValue([]);
    mockPrisma.productCategory.create.mockImplementation(async (args: { data: { name: string } }) => ({
      id: `cat-${args.data.name}`,
      name: args.data.name,
    }));
    mockPrisma.product.updateMany.mockResolvedValue({ count: 1 });

    const result = await autoCategorizeProducts({ mode: "fill" });
    expect(result.created.length).toBe(2);
    expect(result.assigned).toBe(2);
    expect(mockPrisma.productCategory.create).toHaveBeenCalledTimes(2);
    expect(mockPrisma.product.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ categoryId: expect.any(String) }) })
    );
  });
});

describe("Phase 3b: budget-aware alternatives", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOpenAICreateFn.mockReset();
  });

  // NOTE: names/tags deliberately avoid the word "cake" so budget/category
  // fallback tests don't accidentally trigger direct name matches.
  const PRICED = [
    { id: "a", name: "Berry Delight", description: "", price: 400, currency: "BDT", imageUrl: "", tags: "dessert", isAvailable: true, category: { name: "Cakes" } },
    { id: "b", name: "Choco Truffle", description: "", price: 800, currency: "BDT", imageUrl: "", tags: "dessert", isAvailable: true, category: { name: "Cakes" } },
    { id: "c", name: "Royal Feast", description: "", price: 2000, currency: "BDT", imageUrl: "", tags: "dessert", isAvailable: true, category: { name: "Cakes" } },
  ];

  it("extractBudget parses explicit budgets", async () => {
    const { extractBudget } = await import("@/lib/catalog");
    expect(extractBudget("something under 500")).toBe(500);
    expect(extractBudget("below ৳1,000 please")).toBe(1000);
    expect(extractBudget("around $20")).toBe(20);
    expect(extractBudget("500 taka max")).toBe(500);
    expect(extractBudget("do you have cakes?")).toBeNull();
  });

  it("findAlternatives: budget band within 30%", async () => {
    const { findAlternatives } = await import("@/lib/catalog");
    mockPrisma.product.findMany.mockResolvedValue(PRICED);
    const { products, reason } = await findAlternatives("anniversary gift under 500");
    expect(reason).toBe("budget_band");
    // 400 is within 350-650; 800 and 2000 are not
    expect(products.map((p) => p.id)).toEqual(["a"]);
  });

  it("findAlternatives: falls back to category items, then anything", async () => {
    const { findAlternatives } = await import("@/lib/catalog");
    mockPrisma.product.findMany.mockResolvedValue(PRICED);
    mockPrisma.productCategory.findMany.mockResolvedValue([
      { id: "cat1", name: "Cakes", description: "", products: PRICED.slice(0, 2) },
    ]);
    const r1 = await findAlternatives("I want cake");
    expect(r1.reason).toBe("category_fallback");
    expect(r1.products.length).toBeGreaterThan(0);

    mockPrisma.productCategory.findMany.mockResolvedValue([]);
    const r2 = await findAlternatives("spaceship");
    expect(r2.reason).toBe("catalog_fallback");
    expect(r2.products.length).toBeGreaterThan(0);
  });

  it("matchCategoryProducts: intent maps to a category's products", async () => {
    const { matchCategoryProducts } = await import("@/lib/catalog");
    mockPrisma.productCategory.findMany.mockResolvedValue([
      {
        id: "cat1",
        name: "Cakes",
        description: "fresh baked cakes",
        products: [PRICED[0], PRICED[1]],
      },
    ]);
    const hits = await matchCategoryProducts("I want cake for the party");
    expect(hits.length).toBe(2);
    expect(hits[0].categoryName).toBe("Cakes");
  });

  it("engine retain path: no match + inquiry -> alternatives + retain line (no key)", async () => {
    const { chat } = await import("@/lib/ai/engine");
    mockPrisma.settings.findFirst.mockResolvedValue({ ...DEFAULT_SETTINGS, aiApiKey: "" });
    mockPrisma.knowledgeEntry.findMany.mockResolvedValue([]);
    mockPrisma.conversation.findUnique.mockResolvedValue(DEFAULT_CONVERSATION);
    mockPrisma.message.create.mockResolvedValue({ id: "msg-new" });
    mockPrisma.conversation.update.mockResolvedValue({});
    mockPrisma.product.findMany.mockResolvedValue(PRICED);
    mockPrisma.productCategory.findMany.mockResolvedValue([]);

    const result = await chat("conv-1", "রেড ভেলভেট পেস্ট্রি আছে?");
    expect(result.silent).toBe(false);
    // retain phrasing present, alternatives attached as cards
    expect(result.response).toContain("এই মুহূর্তে এভেলেবেল নেই");
    expect(result.products.length).toBeGreaterThan(0);
    expect(mockOpenAICreateFn).not.toHaveBeenCalled();
  });

  it("retainLineFor picks English when no Bengali present", async () => {
    const { retainLineFor, looksLikeProductInquiry } = await import("@/lib/catalog");
    expect(retainLineFor("do you have cake?")).toContain("isn't available right now");
    expect(looksLikeProductInquiry("I want to buy a cake")).toBe(true);
    expect(looksLikeProductInquiry("hello")).toBe(false);
  });
});
