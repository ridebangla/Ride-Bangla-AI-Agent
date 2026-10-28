import { describe, it, expect } from "vitest";
import {
  assertNoAgentConfirmTool,
  appendAuditTrail,
  CANCELLATION_RULE,
  customerStatusWord,
  guardAgentEdit,
  guardAgentStatusChange,
  isLocked,
  planHumanStatusChange,
  teamStatusLabel,
} from "@/lib/order-lock";

/**
 * LEG B (AiPraktor-booking batch, STAGED ONLY): human-confirm-only +
 * LOCKED guard. Pure module — no database, no network, no live data.
 * HEAD agent tool names below were verified from HEAD 706df0fd
 * (src/lib/ai/tools.ts, 11 tools) during this leg's audit.
 */
const HEAD_TOOL_NAMES = [
  "create_ticket",
  "assign_to_person",
  "send_internal_email",
  "get_customer_history",
  "schedule_followup",
  "take_order",
  "search_catalog",
  "recommend_alternative",
  "show_products",
  "trigger_webhook",
  "browse_website",
];

describe("human-confirm-only: agent tool inventory", () => {
  it("HEAD's 11 agent tools contain no confirm/approve/status/cancel tool", () => {
    expect(assertNoAgentConfirmTool(HEAD_TOOL_NAMES)).toEqual([]);
  });
  it("flags a hypothetical confirm/approve/status/cancel tool name", () => {
    expect(
      assertNoAgentConfirmTool([
        ...HEAD_TOOL_NAMES,
        "confirm_order",
        "approve_booking",
        "cancel_order",
      ])
    ).toEqual(["confirm_order", "approve_booking", "cancel_order"]);
  });
  it("agent/customer/system actors may never write status", () => {
    expect(guardAgentStatusChange("agent")).toEqual({
      allowed: false,
      reason: "agent_may_not_confirm",
    });
    expect(guardAgentStatusChange("customer").allowed).toBe(false);
    expect(guardAgentStatusChange("system").allowed).toBe(false);
    expect(guardAgentStatusChange("human").allowed).toBe(true);
  });
});

describe("LOCKED guard (guardAgentEdit)", () => {
  it("pending is editable", () => {
    expect(guardAgentEdit({ id: "o1", status: "pending" })).toEqual({
      allowed: true,
      locked: false,
      reason: "ok",
    });
  });
  it("confirmed is locked with the shared order_locked code", () => {
    expect(guardAgentEdit({ id: "o1", status: "confirmed" })).toEqual({
      allowed: false,
      locked: true,
      reason: "order_locked",
    });
    expect(isLocked({ id: "o1", status: "confirmed" })).toBe(true);
    expect(isLocked({ id: "o1", status: "pending" })).toBe(false);
  });
  it("cancelled is refused (different reason, not the lock)", () => {
    expect(guardAgentEdit({ id: "o1", status: "cancelled" })).toEqual({
      allowed: false,
      locked: false,
      reason: "order_cancelled",
    });
  });
  it("unknown status fails closed", () => {
    expect(guardAgentEdit({ id: "o1", status: "shipped" }).allowed).toBe(false);
  });
  it("a booking record locks by the same rule (generic shape)", () => {
    expect(guardAgentEdit({ id: "b1", status: "confirmed" }).reason).toBe(
      "order_locked"
    );
    expect(guardAgentEdit({ id: "b1", status: "pending" }).allowed).toBe(true);
  });
});

describe("human status plan + audit trail", () => {
  const human = {
    actorType: "human" as const,
    actorId: "admin-1",
    nowIso: "2026-10-25T12:00:00.000Z",
  };
  it("pending → confirmed locks and audits in one plan", () => {
    const plan = planHumanStatusChange({
      record: { id: "o1", status: "pending" },
      toStatus: "confirmed",
      ...human,
    });
    expect(plan.allowed).toBe(true);
    if (!plan.allowed) return;
    expect(plan.action).toBe("confirm");
    expect(plan.setLockedAt).toBe("2026-10-25T12:00:00.000Z");
    expect(plan.isPostConfirmationChange).toBe(true);
    expect(plan.auditEntry).toMatchObject({
      actorType: "human",
      actorId: "admin-1",
      fromStatus: "pending",
      toStatus: "confirmed",
      fieldsChanged: ["status"],
    });
  });
  it("confirmed → pending (human reopen) clears the lock but stays audited", () => {
    const plan = planHumanStatusChange({
      record: { id: "o1", status: "confirmed", lockedAt: "2026-10-25T11:00:00.000Z" },
      toStatus: "pending",
      ...human,
    });
    expect(plan.allowed).toBe(true);
    if (!plan.allowed) return;
    expect(plan.action).toBe("reopen_to_pending");
    expect(plan.setLockedAt).toBe(null);
    expect(plan.auditEntry.reasonMissing).toBe(true); // no reason supplied
  });
  it("confirmed → cancelled keeps lock history and audits", () => {
    const plan = planHumanStatusChange({
      record: { id: "o1", status: "confirmed" },
      toStatus: "cancelled",
      ...human,
      reason: "Customer asked by phone",
    });
    expect(plan.allowed).toBe(true);
    if (!plan.allowed) return;
    expect(plan.action).toBe("cancel");
    expect(plan.setLockedAt).toBe(undefined);
    expect(plan.auditEntry.reason).toBe("Customer asked by phone");
    expect(plan.auditEntry.reasonMissing).toBe(false);
  });
  it("agent actor is denied before any plan is built", () => {
    const plan = planHumanStatusChange({
      record: { id: "o1", status: "pending" },
      toStatus: "confirmed",
      actorType: "agent",
      nowIso: "2026-10-25T12:00:00.000Z",
    });
    expect(plan).toEqual({
      allowed: false,
      reason: "agent_may_not_confirm",
      message: "Only a human team member may confirm, cancel, or reopen an order.",
    });
  });
  it("legacy unsigned human call is flagged actorUnverified, never invented", () => {
    const plan = planHumanStatusChange({
      record: { id: "o1", status: "pending" },
      toStatus: "confirmed",
      actorType: "human",
      actorId: null,
      nowIso: "2026-10-25T12:00:00.000Z",
    });
    expect(plan.allowed).toBe(true);
    if (!plan.allowed) return;
    expect(plan.auditEntry.actorId).toBe(null);
    expect(plan.auditEntry.actorUnverified).toBe(true);
  });
  it("appendAuditTrail does not mutate the existing trail", () => {
    const before = [{ at: "t0" }];
    const after = appendAuditTrail(before, {
      at: "t1",
      actorType: "human",
      actorId: "a",
      action: "confirm",
      fromStatus: "pending",
      toStatus: "confirmed",
      fieldsChanged: ["status"],
      reason: null,
      reasonMissing: true,
    });
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(2);
  });
});

describe("cancellation rule + wording", () => {
  it("no time cutoff is enforced in code; the window is an owner decision", () => {
    expect(CANCELLATION_RULE.agentMayCancel).toBe(false);
    expect(CANCELLATION_RULE.chatMayCancel).toBe(false);
    expect(CANCELLATION_RULE.enforcedCutoff).toBe(null);
    expect(CANCELLATION_RULE.windowDecision).toBe("OWNER_DECISION");
  });
  it("team label never hides the lock; customer words stay simple", () => {
    expect(teamStatusLabel({ id: "o1", status: "confirmed" })).toBe(
      "Confirmed · Locked"
    );
    expect(teamStatusLabel({ id: "o1", status: "pending" })).toBe("Pending");
    expect(customerStatusWord("pending")).toBe("Waiting for team confirmation");
    expect(customerStatusWord("confirmed")).toBe("Order confirmed");
    expect(customerStatusWord("cancelled")).toBe("Order cancelled");
    expect(customerStatusWord("shipped")).toBe(null);
  });
});
