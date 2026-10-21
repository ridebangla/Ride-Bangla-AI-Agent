"use client";

/**
 * Dashboard banner for the Done-for-You Setup flow.
 * Shows the apply CTA until the customer has an application, then shows
 * its status. Customers never need API keys — the team does the setup.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, CheckCircle, Clock, Sparkles } from "lucide-react";
import { t } from "@/lib/i18n";

interface AppState {
  status: string;
  updatedAt: string;
}

export function SetupCtaCard() {
  const [state, setState] = useState<AppState | null | undefined>(undefined);

  useEffect(() => {
    fetch("/api/setup-application")
      .then((r) => (r.ok ? r.json() : { application: null }))
      .then((data) => setState(data.application ?? null))
      .catch(() => setState(null));
  }, []);

  if (state === undefined) return null;

  return (
    <div className="rounded-2xl border border-rbai-primary/30 bg-gradient-to-r from-rbai-primary-50 to-rbai-surface p-5 flex flex-col sm:flex-row sm:items-center gap-4">
      <div className="flex items-start gap-3 flex-1">
        <span className="p-2.5 rounded-xl bg-rbai-primary text-white shrink-0">
          <Sparkles className="h-5 w-5" />
        </span>
        <div>
          <h3 className="font-semibold text-rbai-text">
            {state
              ? state.status === "completed"
                ? "Your setup is complete"
                : "Setup request received"
              : "Want us to set everything up for you?"}
          </h3>
          <p className="text-sm text-rbai-text-light mt-0.5">
            {state
              ? state.status === "completed"
                ? "Our team has connected your channels. You can review them anytime on the Channels page."
                : t("cta.received_body")
              : t("cta.apply_body")}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {state && state.status !== "completed" && (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700">
            <Clock className="h-4 w-4" /> With our team
          </span>
        )}
        {state?.status === "completed" ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
            <CheckCircle className="h-4 w-4" /> Done
          </span>
        ) : (
          <Link
            href="/setup-application"
            className="inline-flex items-center gap-1.5 rounded-lg bg-rbai-primary text-white px-4 py-2.5 text-sm font-medium hover:opacity-90 transition-opacity"
          >
            {state ? "View my request" : "Apply for setup"}
            <ArrowRight className="h-4 w-4" />
          </Link>
        )}
      </div>
    </div>
  );
}
