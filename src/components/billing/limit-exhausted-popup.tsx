"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertOctagon, Check } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/utils";
import { useLimitUx } from "./limit-ux-context";
import {
  LIMIT_UX_TEXTS,
  buildLimitBody,
  type LimitReset,
} from "@/lib/limit-ux";
import type { CatalogPlanView } from "@/lib/plan-catalog";

function fmtUsd(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function fmtCount(n: number): string {
  return n.toLocaleString("en-US");
}

export interface LimitExhaustedPopupProps {
  reset: LimitReset;
  /** Active plans from the LIVE ai_plans catalog (never hardcoded). */
  plans: CatalogPlanView[];
  /** The plan id the exhausted gate resolved to. */
  currentPlanId: string;
  used: number;
  limit: number;
}

export interface LimitExhaustedPopupContentProps
  extends LimitExhaustedPopupProps {
  onClose: () => void;
}

/**
 * The popup's inner content (no Modal wrapper) — exported so the render
 * path is unit-verifiable via server-side static markup.
 */
export function LimitExhaustedPopupContent({
  reset,
  plans,
  currentPlanId,
  used,
  limit,
  onClose,
}: LimitExhaustedPopupContentProps) {
  return (
    <>
      <div className="text-center">
        <span className="inline-flex p-3 rounded-2xl bg-red-50 text-red-600">
          <AlertOctagon className="h-7 w-7" />
        </span>
        <h2 className="text-xl font-bold text-rbai-text mt-4">
          {LIMIT_UX_TEXTS.headline}
        </h2>
        <p className="text-sm text-rbai-text-light mt-2 max-w-lg mx-auto">
          {buildLimitBody(reset)}
        </p>
        <p className="text-xs text-rbai-text-light mt-2">
          {fmtCount(used)} / {fmtCount(limit)} AI messages used this period
        </p>
      </div>

      {plans.length > 0 && (
        <div className="mt-6">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {plans.map((plan) => {
              const isCurrent = plan.id === currentPlanId;
              const offer = plan.monthly.offer;
              return (
                <div
                  key={plan.id}
                  className={cn(
                    "relative rounded-xl border p-4 flex flex-col",
                    isCurrent
                      ? "border-rbai-primary ring-2 ring-rbai-primary/20 bg-rbai-primary-50/40"
                      : "border-rbai-border bg-rbai-bg"
                  )}
                >
                  {isCurrent && (
                    <span className="absolute -top-2.5 left-3 inline-flex items-center gap-1 rounded-full bg-rbai-primary text-white text-[11px] font-medium px-2.5 py-0.5">
                      <Check className="h-3 w-3" /> Current plan
                    </span>
                  )}
                  <p className="font-semibold text-rbai-text text-sm">
                    {plan.name}
                  </p>
                  {plan.tagline && (
                    <p className="text-xs text-rbai-text-light mt-1 line-clamp-2">
                      {plan.tagline}
                    </p>
                  )}
                  <p className="mt-3">
                    {offer ? (
                      <>
                        <span className="text-xs text-rbai-text-light line-through mr-1.5">
                          ${fmtUsd(offer.regularPriceUsd)}
                        </span>
                        <span className="text-lg font-bold text-rbai-text">
                          ${fmtUsd(offer.effectivePriceUsd)}
                        </span>
                      </>
                    ) : (
                      <span className="text-lg font-bold text-rbai-text">
                        ${fmtUsd(plan.monthly.regularPriceUsd)}
                      </span>
                    )}
                    <span className="text-xs text-rbai-text-light"> / month</span>
                  </p>
                  {offer && (
                    <p className="text-[11px] text-emerald-700 font-medium mt-0.5">
                      {offer.name}
                    </p>
                  )}
                  <p className="text-xs text-rbai-text-light mt-2">
                    <span className="font-semibold text-rbai-text">
                      {fmtCount(plan.messagesPerMonth)}
                    </span>{" "}
                    AI messages / period
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="mt-6 flex flex-col sm:flex-row items-center justify-center gap-3">
        <Link
          href="/billing"
          className="inline-flex items-center justify-center rounded-lg bg-rbai-primary text-white font-semibold py-2.5 px-8 text-sm hover:opacity-90 transition-opacity"
        >
          {LIMIT_UX_TEXTS.cta}
        </Link>
        <button
          type="button"
          onClick={onClose}
          className="text-sm text-rbai-text-light hover:text-rbai-text underline underline-offset-2"
        >
          Continue browsing
        </button>
      </div>
    </>
  );
}

/**
 * LimitExhaustedPopup — the limit-exhausted popup (owner directive
 * 2026-10-22). It appears while the tenant's product limit is finished:
 * the limit state, WHEN it resets, the plans with their allowances
 * rendered from the LIVE ai_plans catalog, and the upgrade path.
 * Dismissible — the dashboard behind it stays fully usable; only the
 * work-action is disabled while exhausted.
 */
export function LimitExhaustedPopup(props: LimitExhaustedPopupProps) {
  const { exhausted, popupOpen, openPopup, closePopup } = useLimitUx();

  // Auto-open once when the dashboard loads in the exhausted state.
  useEffect(() => {
    if (exhausted) openPopup();
  }, [exhausted, openPopup]);

  if (!exhausted) return null;

  return (
    <Modal open={popupOpen} onClose={closePopup} size="lg">
      <LimitExhaustedPopupContent {...props} onClose={closePopup} />
    </Modal>
  );
}
