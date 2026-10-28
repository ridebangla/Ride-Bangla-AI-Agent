/**
 * test-chat.ts — Tenant test-chat sandbox: chat with your OWN agent in
 * clearly-labelled TEST mode before enabling it live, then one-click
 * live through the EXISTING Settings PUT. STAGED ONLY.
 *
 * WHAT THIS IS — AND IS NOT
 * --------------------------
 * A test-chat is a TESTING tool, not a teaching or onboarding path.
 * Test turns never teach the agent anything: they write no knowledge
 * entry, never change website/details data, and never become a
 * customer conversation. Website/details remain the primary source;
 * chat input stays supplementary everywhere else, and here it is not
 * even supplementary — it is test input only, stored in test-only
 * rows and discarded from every live surface.
 *
 * ISOLATION, BY CONSTRUCTION (not by UI filtering alone)
 * -----------------------------------------------------
 * 1. SEPARATE COLLECTIONS. Test sessions live in `testChatSessions`
 *    and test turns in `testChatMessages`. Real conversations live in
 *    `conversations` / `messages`. The inbox, conversation list,
 *    analytics, and usage code query those real collections; they
 *    cannot see a test row because they never query a test
 *    collection. A UI filter failing cannot leak a test chat into
 *    a customer surface, because there is no shared query to filter.
 * 2. SEPARATE ROLES. A tester turn is stored as role "tester", never
 *    "customer" and never "user" in a customer thread. An assistant
 *    test reply is stored as role "assistant" ONLY inside a
 *    testChatMessages row that also carries isTest: true and
 *    channel "test-chat" (a dashboard label, not a real channel).
 * 3. TEST FLAG ON EVERY RECORD. Every session row, every message
 *    row, and every API response carries isTest: true, and every
 *    response also carries notSent: true. A test reply may never
 *    be mistaken for a message sent to a customer.
 * 4. NO SIDE-EFFECT PATH IS REACHABLE. The test turn route (see
 *    src/app/api/test-chat/[id]/messages/route.ts) does NOT call
 *    the live chat pipeline, offers NO tools to the provider, calls
 *    NO channel-send function, creates NO order, ticket, follow-up,
 *    or customer record, and calls NO usage-metering function. It
 *    reuses only the live prompt builder (buildSystemPrompt), the
 *    deterministic greeting path, the tenant's live knowledge base,
 *    and the tenant's live behaviour text — the same reuse shape
 *    the Agent Desk preview route already uses for a single test
 *    reply. The difference from that preview: a test-chat keeps
 *    multi-turn history inside one test session, so the owner can
 *    hold a conversation with the agent before going live.
 * 5. GO-LIVE CONVERTS NOTHING. Going live writes exactly one thing
 *    through the existing Settings PUT: { aiEnabled: true }. It
 *    never converts a test session into a conversation, never
 *    copies test history into a customer thread, and never changes
 *    a test row's status. Test history stays test history forever.
 *
 * WHY THE TURN ROUTE DOES NOT CALL THE LIVE chat() PIPELINE
 * ---------------------------------------------------------
 * The live pipeline (src/lib/ai/engine.ts, chat()) persists a
 * customer message, offers the order tool, meters the turn, and
 * returns a reply for delivery to a visitor. Calling it from a
 * test route would create exactly the contamination this leg must
 * prevent: a real conversation row, a possible order, and a metered
 * turn. So the test route deliberately does NOT call chat(). It
 * follows the preview pattern instead: build the system prompt
 * with the live builder, run one tool-less provider completion
 * (or the deterministic greeting reply), store the reply as a
 * test row only. Fidelity limits are stated, not hidden: a test
 * turn shows wording, never a completed order, a tool-chosen
 * product card, or a follow-up — with no tools offered, a model
 * that claimed otherwise would be inventing a side effect, so
 * every test completion carries a TEST suffix saying so.
 *
 * RELATIONSHIP TO THE EXISTING SWITCHES (stated, not assumed)
 * ------------------------------------------------------------
 * - GLOBAL SWITCH (settings.aiEnabled, missing = ON at HEAD).
 *   Customer paths keep obeying it exactly as before; this leg
 *   touches no customer path. The test route is the ONE bounded
 *   exception: a staff test turn still answers while the global
 *   switch is OFF, because testing an agent that is OFF is the
 *   whole point of testing before going live. The exception is
 *   bounded to staff test turns only — it cannot answer a
 *   customer, because the test route has no channel, no visitor,
 *   and no delivery step.
 * - PER-CHAT PAUSE (conversations.aiEnabled = false, takeover).
 *   Not applicable by construction: a test session is not a
 *   conversation row, has no aiEnabled pause field, and cannot be
 *   taken over or resumed. Pausing a customer chat changes no
 *   test session; closing a test session changes no customer chat.
 * - CHANNEL TOGGLES (prior staged channel-toggle batch). Not
 *   applicable by exclusion: a test-chat has no channel, so no
 *   channel toggle can enable or block it, and no toggle state
 *   can cause a test reply to be sent anywhere. A test reply is
 *   never sent on any channel in any toggle state.
 * - REPLY-APPROVAL MODE (prior staged approval batch). Test turns
 *   are NOT held for approval and create NO reply draft: the
 *   tester IS the reviewer, watching the reply appear in the test
 *   pane. Approval mode still governs real customer turns
 *   exactly as staged there; test turns never enter that flow.
 * - AGENT DESK (prior staged batch). Agent Desk previews a DRAFT
 *   rule with a single test message. Test-chat tests the LIVE
 *   agent (live behaviour text + live knowledge) over many turns.
 *   The two are complementary, not duplicates: preview a draft
 *   rule there, hold a conversation with the live agent here.
 *
 * GO-LIVE HONESTY (read before changing the page)
 * -----------------------------------------------
 * At HEAD there is NO distinct "draft vs live" agent state: the
 * engine reads settings.aiEnabled !== false, so a tenant that
 * never touched the switch is already live by default. "Go live"
 * in this leg therefore means exactly one existing-path write:
 * PUT /api/settings { aiEnabled: true } (admin-only, via the
 * existing settings:update permission — no new permission is
 * invented for going live). The pre-live holding state is the
 * tenant's own discipline with the existing switch: keep
 * aiEnabled: false while testing, then click Go live. A true
 * platform gate ("agent stays off until the owner has tested")
 * would require changing the missing = ON default — a behaviour
 * change that is NOT staged here and is an owner decision in the
 * leg report. Until that decision, the page says plainly whether
 * the switch is explicitly on, explicitly off, or never set
 * (default ON), and never pretends a test session itself is a
 * live gate.
 *
 * This module is pure (no imports) so it can be unit-tested
 * standalone. All Firestore/HTTP work lives in the routes.
 */

export type TestChatSessionStatus = "open" | "closed";

export type TestChatMessageRole = "tester" | "assistant";

export interface TestChatSession {
  id: string;
  businessId: string;
  /** Always true. Every stored test record carries this flag. */
  isTest: true;
  status: TestChatSessionStatus;
  /** Tester-chosen label ("" = untitled). Display only. */
  title: string;
  /** Auth userId of the tester ("api-key:<id>" for key auth). */
  createdBy: string;
  createdByName: string;
  /**
   * settings.aiEnabled at session creation, normalised the way the
   * engine normalises it (missing = ON). Display context only: it
   * records whether the agent was already live when testing began.
   * It is never used as a gate and never written back to settings.
   */
  startedWhileLive: boolean;
  /** Count of stored turns (tester + assistant rows) in this session. */
  messageCount: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  closedAt: Date | string | null;
}

export interface TestChatMessage {
  id: string;
  businessId: string;
  sessionId: string;
  /** Always true. Every stored test record carries this flag. */
  isTest: true;
  role: TestChatMessageRole;
  content: string;
  /**
   * Dashboard label only. "test-chat" is not a real channel and no
   * channel code ever reads it: it exists so a stored row can never
   * be mistaken for a widget / messenger / whatsapp / other
   * channel message.
   */
  channel: "test-chat";
  /** Provider model for assistant rows; "" for tester rows. */
  model: string;
  createdAt: Date | string;
}

/** Hard cap on one test message (mirrors the Agent Desk preview cap). */
export const MAX_TEST_MESSAGE_CHARS = 1000;
/** Hard cap on a session title. */
export const MAX_SESSION_TITLE_CHARS = 100;
/** History turns replayed into the prompt (mirrors the engine cap). */
export const TEST_HISTORY_TURNS = 12;
/** List page size for GET /api/test-chat. */
export const TEST_SESSION_LIST_LIMIT = 50;
/** Open sessions allowed per business at once (staged proposal). */
export const MAX_OPEN_SESSIONS_PER_BUSINESS = 5;
/** Stored turns allowed per session (staged proposal). */
export const MAX_TURNS_PER_SESSION = 100;

/**
 * The suffix appended to every test completion's system prompt.
 * It states the test facts the model must respect: no tools exist
 * in this turn, so no order/booking/ticket/notification may be
 * claimed as created, and nothing in this chat is sent to a
 * customer. Proposal wording (owner approval covers all copy).
 */
export const TEST_COMPLETION_SUFFIX = [
  "This is a TEST chat for the business owner. Answer exactly as you would to a customer.",
  "No tools are available in this test chat: do not claim to have created an order, booking, ticket, or notification, and do not claim this message was sent to a customer.",
].join(" ");

/** A row is a test record exactly when it carries isTest === true. */
export function isTestRecord(row: unknown): boolean {
  return (
    !!row &&
    typeof row === "object" &&
    (row as { isTest?: unknown }).isTest === true
  );
}

/**
 * Real-conversation counting, by exclusion: drop every test-flagged
 * row, keep everything else. Counting functions in this platform
 * query the real collections, so in practice they never see a test
 * row at all; this helper is the belt-and-braces filter for any
 * future code that merges lists, and the harness pins it.
 */
export function excludeTestRecords<T>(rows: readonly T[]): T[] {
  return rows.filter((row) => !isTestRecord(row));
}

/** Count of real (non-test) rows in a list. */
export function countRealRecords<T>(rows: readonly T[]): number {
  return excludeTestRecords(rows).length;
}

/** Count of test rows in a list. */
export function countTestRecords<T>(rows: readonly T[]): number {
  return rows.filter((row) => isTestRecord(row)).length;
}

/**
 * Pure tenant guard: a test row belongs to the caller's business
 * or not. Routes also filter by businessId in the query itself;
 * this guard is the second check for a row already loaded.
 */
export function isSameBusiness(
  rowBusinessId: string,
  authBusinessId: string | null
): boolean {
  return !!authBusinessId && rowBusinessId === authBusinessId;
}

export function validateTestMessage(testMessage: unknown): boolean {
  return (
    typeof testMessage === "string" &&
    testMessage.trim().length > 0 &&
    testMessage.length <= MAX_TEST_MESSAGE_CHARS
  );
}

export function validateSessionTitle(title: unknown): boolean {
  return (
    title === undefined ||
    title === null ||
    (typeof title === "string" && title.length <= MAX_SESSION_TITLE_CHARS)
  );
}

/** A new session may start only while fewer than the cap are open. */
export function canStartSession(openSessionCount: number): boolean {
  return openSessionCount < MAX_OPEN_SESSIONS_PER_BUSINESS;
}

/** A turn may be added only while the session is open and under cap. */
export function canAddTurn(
  session: { status: TestChatSessionStatus; messageCount: number } | null
): boolean {
  return (
    !!session &&
    session.status === "open" &&
    session.messageCount < MAX_TURNS_PER_SESSION
  );
}

/**
 * Engine-normalised live flag: settings.aiEnabled !== false.
 * Missing (never set) = ON, exactly as getAIConfig() reads it.
 * Returns also whether the value was explicitly set, so the page
 * can say honestly "never set (default ON)" instead of "on".
 */
export function normaliseLiveFlag(settingsAiEnabled: unknown): {
  live: boolean;
  explicit: boolean;
} {
  if (typeof settingsAiEnabled !== "boolean") {
    return { live: true, explicit: false };
  }
  return { live: settingsAiEnabled, explicit: true };
}

/**
 * The ONLY payload the Go live control ever sends, and it sends it
 * through the EXISTING Settings PUT — never through a second
 * settings writer, never through a test-chat route. The existing
 * settings schema already accepts aiEnabled (optional boolean),
 * and the existing route already restricts PUT to settings:update
 * (admin). No new permission, no new field, no parallel system.
 */
export function goLivePayload(): { aiEnabled: true } {
  return { aiEnabled: true };
}

/**
 * History lines for the prompt's customerHistory slot, oldest
 * first, capped at the engine's history cap. Tester lines are
 * labelled "Tester" (never "Customer") so the model — and any
 * reader of a stored prompt — cannot mistake a test turn for a
 * real customer turn. Assistant lines are labelled "Assistant
 * (TEST)".
 */
export function buildTestHistory(
  messages: readonly { role: TestChatMessageRole; content: string }[]
): string[] {
  const tail = messages.slice(-TEST_HISTORY_TURNS);
  return tail.map((m) =>
    m.role === "tester" ? `Tester: ${m.content}` : `Assistant (TEST): ${m.content}`
  );
}

/**
 * Declarative side-effect contract for a test turn. The harness
 * asserts that the turn route's source contains none of the
 * imports that could realise any "true" here; this object exists
 * so the contract is stated in one place, in code, not only in
 * prose. A test turn creates test rows only.
 */
export const TEST_TURN_SIDE_EFFECTS = {
  createsConversation: false,
  createsCustomerMessage: false,
  createsOrder: false,
  createsTicket: false,
  createsFollowUp: false,
  createsKnowledgeEntry: false,
  sendsChannelMessage: false,
  metersUsage: false,
  writesLiveSettings: false,
} as const;

/**
 * Public shape of a session row for API responses: the actor id is
 * never exposed (name only, mirroring the Agent Desk public shape),
 * and isTest travels with the row on every response.
 */
export function publicSession(s: TestChatSession): {
  id: string;
  isTest: true;
  status: TestChatSessionStatus;
  title: string;
  createdByName: string;
  startedWhileLive: boolean;
  messageCount: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  closedAt: Date | string | null;
} {
  return {
    id: s.id,
    isTest: true,
    status: s.status,
    title: s.title,
    createdByName: s.createdByName,
    startedWhileLive: s.startedWhileLive,
    messageCount: s.messageCount,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    closedAt: s.closedAt,
  };
}

/** Public shape of a test message row: isTest + channel on every row. */
export function publicMessage(m: TestChatMessage): {
  id: string;
  sessionId: string;
  isTest: true;
  role: TestChatMessageRole;
  channel: "test-chat";
  content: string;
  model: string;
  createdAt: Date | string;
} {
  return {
    id: m.id,
    sessionId: m.sessionId,
    isTest: true,
    role: m.role,
    channel: "test-chat",
    content: m.content,
    model: m.model,
    createdAt: m.createdAt,
  };
}

/**
 * Test-mode envelope: every test-chat API response carries this.
 * isTest + notSent are unconditional — no test response may ever
 * be mistaken for a message sent to a customer, and no test
 * response may ever be counted as a real conversation.
 */
export function toTestEnvelope(args: {
  session: TestChatSession;
  messages: TestChatMessage[];
}): {
  isTest: true;
  notSent: true;
  testMode: true;
  session: ReturnType<typeof publicSession>;
  messages: ReturnType<typeof publicMessage>[];
} {
  return {
    isTest: true,
    notSent: true,
    testMode: true,
    session: publicSession(args.session),
    messages: args.messages.map(publicMessage),
  };
}
