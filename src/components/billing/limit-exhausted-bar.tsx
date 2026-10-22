"use client";

import { AlertOctagon } from "lucide-react";
import { useLimitUx } from "./limit-ux-context";
import {
  LIMIT_UX_TEXTS,
  resetSlotPhrase,
  type LimitReset,
} from "@/lib/limit-ux";

/**
 * LimitExhaustedBar — slim persistent bar at the top of the tenant
 * dashboard while the product limit is exhausted. It never blocks
 * anything: the dashboard stays fully usable, and ONLY the work-action
 * (knowledge test send) is disabled. The "প্ল্যানগুলো দেখুন" button
 * opens the full popup with the plans and the "Update your package" CTA.
 */
export function LimitExhaustedBar({ reset }: { reset: LimitReset }) {
  const { exhausted, openPopup } = useLimitUx();
  if (!exhausted) return null;

  return (
    <div
      role="alert"
      className="bg-red-50 border-b border-red-200 px-4 py-2.5"
    >
      <div className="max-w-5xl mx-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-red-900">
        <AlertOctagon className="h-4 w-4 flex-shrink-0" aria-hidden />
        <span className="font-semibold">{LIMIT_UX_TEXTS.headline}।</span>
        <span>
          আবার ব্যবহার করতে পারবেন {resetSlotPhrase(reset)}।
        </span>
        <button
          type="button"
          onClick={openPopup}
          className="font-medium text-red-800 underline underline-offset-2 hover:text-red-950"
        >
          {LIMIT_UX_TEXTS.viewPlans}
        </button>
      </div>
    </div>
  );
}
