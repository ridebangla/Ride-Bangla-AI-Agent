"use client";

import { Header } from "@/components/layout/header";
import {
  Loader2,
  MessageCircle,
  Mail,
  Phone,
  Globe,
  Share2,
  ShoppingBag,
  Truck,
  Webhook,
  CreditCard,
  CheckCircle2,
  XCircle,
  HelpCircle,
  ArrowUpRight,
  Info,
} from "lucide-react";
import Link from "next/link";
import { useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";

/**
 * Integrations Hub page (STAGED, Leg F) — DISPLAY ONLY.
 *
 * One page listing every channel / store / service with its
 * connection status, from GET /api/integrations (tenant-scoped,
 * booleans + counts only — no credential, token, key, URL, or
 * account value is ever rendered here).
 *
 * Statuses: Connected / Not connected / Status unknown. "Status
 * unknown" is shown honestly where no tenant record evidences the
 * connection; it is never rendered as Connected, and its detail
 * line says why. "Manage" links to the existing management
 * surface; "Set up" links to the existing setup surface. Where no
 * surface exists, there is NO button — only a follow-up note
 * (Telegram setup screen, live Shopify/WooCommerce connections).
 *
 * All user-facing wording on this page is PROPOSAL for owner
 * approval, not settled copy. No money figure is shown. Counts shown are the tenant's own live counts
 * from the API (active webhooks, indexed websites) — never demo
 * figures.
 */

type IntegrationStatus = "connected" | "not_connected" | "unknown";

type IntegrationAction =
  | { kind: "link"; href: string; label: string }
  | { kind: "follow_up"; note: string };

interface IntegrationItem {
  id: string;
  group: "channels" | "websites" | "stores" | "services";
  name: string;
  status: IntegrationStatus;
  detail: string;
  action: IntegrationAction;
}

const GROUP_TITLES: Record<IntegrationItem["group"], string> = {
  channels: "Channels",
  websites: "Websites",
  stores: "Stores",
  services: "Services",
};

const GROUP_NOTES: Record<IntegrationItem["group"], string> = {
  channels: "Everywhere your AI can talk to customers.",
  websites: "Websites your agent answers from.",
  stores: "Shops your catalog could sync with.",
  services: "Platform services attached to this workspace.",
};

const ICONS: Record<string, React.ElementType> = {
  "website-widget": Globe,
  facebook: Share2,
  messenger: MessageCircle,
  instagram: Share2,
  "whatsapp-legacy": MessageCircle,
  "whatsapp-cloud": MessageCircle,
  x: Share2,
  youtube: Share2,
  linkedin: Share2,
  email: Mail,
  phone: Phone,
  sms: MessageCircle,
  telegram: MessageCircle,
  websites: Globe,
  shopify: ShoppingBag,
  woocommerce: ShoppingBag,
  courier: Truck,
  "outbound-webhooks": Webhook,
  "stripe-billing": CreditCard,
};

function StatusBadge({ status }: { status: IntegrationStatus }) {
  if (status === "connected") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-50 text-green-700">
        <CheckCircle2 className="h-3.5 w-3.5" />
        Connected
      </span>
    );
  }
  if (status === "unknown") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700">
        <HelpCircle className="h-3.5 w-3.5" />
        Status unknown
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600">
      <XCircle className="h-3.5 w-3.5" />
      Not connected
    </span>
  );
}

function IntegrationCard({ item }: { item: IntegrationItem }) {
  const Icon = ICONS[item.id] || Globe;
  return (
    <div className="bg-rbai-surface rounded-xl border border-rbai-border p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="p-2 rounded-lg bg-rbai-primary-50 text-rbai-primary">
            <Icon className="h-5 w-5" />
          </span>
          <h3 className="font-semibold text-rbai-text">{item.name}</h3>
        </div>
        <StatusBadge status={item.status} />
      </div>
      <p className="text-sm text-rbai-text-light flex-1">{item.detail}</p>
      {item.action.kind === "link" ? (
        <Link
          href={item.action.href}
          className={cn(
            "inline-flex items-center justify-center gap-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
            item.status === "connected"
              ? "border border-rbai-border text-rbai-text hover:bg-rbai-bg"
              : "bg-rbai-primary text-white hover:opacity-90",
          )}
        >
          {item.action.label}
          <ArrowUpRight className="h-4 w-4" />
        </Link>
      ) : (
        <p className="flex items-start gap-1.5 text-xs text-rbai-text-light bg-rbai-bg rounded-lg px-3 py-2">
          <Info className="h-4 w-4 shrink-0 mt-px" />
          {item.action.note}
        </p>
      )}
    </div>
  );
}

export default function IntegrationsPage() {
  const [items, setItems] = useState<IntegrationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const fetchItems = useCallback(async () => {
    try {
      const res = await fetch("/api/integrations");
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          (data as { error?: string }).error || "Could not load integrations",
        );
      }
      const data = await res.json();
      setItems(Array.isArray(data.items) ? data.items : []);
      setFetchError(null);
    } catch (err) {
      setFetchError(
        err instanceof Error ? err.message : "Could not load integrations",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  const groups = (["channels", "websites", "stores", "services"] as const)
    .map((g) => ({
      key: g,
      items: items.filter((i) => i.group === g),
    }))
    .filter((g) => g.items.length > 0);

  return (
    <>
      <Header
        title="Integrations"
        description="Every channel, store, and service connected to this workspace — and its connection status"
      />
      <div className="flex-1 overflow-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-rbai-primary" />
          </div>
        ) : fetchError ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <p className="font-medium text-rbai-text">
              Could not load integrations
            </p>
            <p className="text-sm text-rbai-text-light mt-1">{fetchError}</p>
            <button
              onClick={() => {
                setLoading(true);
                fetchItems();
              }}
              className="mt-3 px-4 py-2 text-sm font-medium text-white bg-rbai-primary rounded-lg hover:bg-rbai-primary/90 transition-colors"
            >
              Retry
            </button>
          </div>
        ) : (
          <div className="space-y-8 max-w-7xl">
            {groups.map((g) => (
              <section key={g.key}>
                <h2 className="text-lg font-semibold text-rbai-text mb-1">
                  {GROUP_TITLES[g.key]}
                </h2>
                <p className="text-sm text-rbai-text-light mb-4">
                  {GROUP_NOTES[g.key]}
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {g.items.map((item) => (
                    <IntegrationCard key={item.id} item={item} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
