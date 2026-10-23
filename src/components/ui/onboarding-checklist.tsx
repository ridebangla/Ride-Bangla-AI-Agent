"use client";

import { cn } from "@/lib/utils";
import {
  CheckCircle,
  Circle,
  UserCheck,
  Building2,
  Bot,
  BookOpen,
  Radio,
  Users,
  ChevronRight,
  X,
} from "lucide-react";
import Link from "next/link";
import { useState, useEffect, useCallback } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChecklistItem {
  id: string;
  title: string;
  description: string;
  href: string;
  completed: boolean;
  icon: React.ElementType;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function OnboardingChecklist() {
  const [items, setItems] = useState<ChecklistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState(false);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const [authRes, settingsRes, entriesRes, channelsRes, teamRes] =
        await Promise.all([
          fetch("/api/auth"),
          fetch("/api/settings"),
          fetch("/api/knowledge/entries"),
          fetch("/api/channels"),
          fetch("/api/team/members"),
        ]);

      const auth = authRes.ok ? await authRes.json() : {};
      const settings = settingsRes.ok ? await settingsRes.json() : {};
      const entries = entriesRes.ok ? await entriesRes.json() : [];
      const channels = channelsRes.ok ? await channelsRes.json() : [];
      const team = teamRes.ok ? await teamRes.json() : [];

      const connectedChannels = Array.isArray(channels)
        ? channels.filter((c: { isActive: boolean }) => c.isActive)
        : [];

      const teamMembers = Array.isArray(team) ? team : [];

      const checklist: ChecklistItem[] = [
        {
          id: "admin",
          title: "Admin account created",
          description: "Your admin account is set up and ready",
          href: "/admin",
          completed: auth.authenticated === true,
          icon: UserCheck,
        },
        {
          id: "business",
          title: "Business profile configured",
          description: "Set your business name and details",
          href: "/settings",
          completed:
            !!settings.businessName && settings.businessName !== "My Business",
          icon: Building2,
        },
        {
          id: "ai",
          title: "AI is ready",
          description: "Our team manages your AI connection — nothing to set up",
          href: "/settings",
          completed: settings.aiEnabled !== false,
          icon: Bot,
        },
        {
          id: "knowledge",
          title: "Knowledge base entries added",
          description: "Add content for the AI to reference",
          href: "/knowledge",
          completed: Array.isArray(entries) && entries.length > 0,
          icon: BookOpen,
        },
        {
          id: "channels",
          title: "At least one channel connected",
          description: "Connect WhatsApp, email, or phone",
          href: "/channels",
          completed: connectedChannels.length > 0,
          icon: Radio,
        },
        {
          id: "team",
          title: "Team members added",
          description: "Add your support team for escalations",
          href: "/team",
          completed: teamMembers.length > 0,
          icon: Users,
        },
      ];

      setItems(checklist);
    } catch (err) {
      console.error("Failed to fetch onboarding status:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Check if user previously dismissed
    const wasDismissed = localStorage.getItem("rbai-onboarding-dismissed");
    if (wasDismissed === "true") {
      setDismissed(true);
      setLoading(false);
      return;
    }
    fetchStatus();
  }, [fetchStatus]);

  function handleDismiss() {
    setDismissed(true);
    localStorage.setItem("rbai-onboarding-dismissed", "true");
  }

  const completedCount = items.filter((i) => i.completed).length;
  const totalCount = items.length;
  const allComplete = completedCount === totalCount && totalCount > 0;
  const progressPercent =
    totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  // Hide if dismissed or all complete
  if (dismissed || allComplete || loading) {
    if (loading) {
      return null; // Don't flash loading state on dashboard
    }
    return null;
  }

  return (
    <div className="bg-rbai-surface rounded-xl border border-rbai-border overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-rbai-border">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-rbai-text">Getting Started</h3>
            <p className="text-xs text-rbai-text-light mt-0.5">
              Complete these steps to set up Ride Bangla AI Agent
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-rbai-text-light">
              {completedCount} / {totalCount}
            </span>
            <button
              onClick={handleDismiss}
              className="p-1 text-rbai-text-light hover:text-rbai-text rounded transition-colors"
              title="Hide checklist"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Progress bar */}
        <div className="mt-3 w-full h-1.5 bg-rbai-bg rounded-full overflow-hidden">
          <div
            className="h-full bg-rbai-primary rounded-full transition-all duration-500"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>

      {/* Checklist items */}
      <div className="divide-y divide-rbai-border">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.id}
              href={item.href}
              className={cn(
                "flex items-center gap-4 px-5 py-3.5 hover:bg-rbai-bg/50 transition-colors group",
                item.completed && "opacity-60"
              )}
            >
              <div className="flex-shrink-0">
                {item.completed ? (
                  <CheckCircle className="h-5 w-5 text-rbai-success" />
                ) : (
                  <Circle className="h-5 w-5 text-rbai-border" />
                )}
              </div>

              <div className="flex-shrink-0 p-2 rounded-lg bg-rbai-bg">
                <Icon className="h-4 w-4 text-rbai-text-light" />
              </div>

              <div className="flex-1 min-w-0">
                <p
                  className={cn(
                    "text-sm font-medium",
                    item.completed
                      ? "text-rbai-text-light line-through"
                      : "text-rbai-text"
                  )}
                >
                  {item.title}
                </p>
                <p className="text-xs text-rbai-text-light mt-0.5">
                  {item.description}
                </p>
              </div>

              {!item.completed && (
                <ChevronRight className="h-4 w-4 text-rbai-text-light group-hover:text-rbai-primary transition-colors flex-shrink-0" />
              )}
            </Link>
          );
        })}
      </div>

      {/* Footer */}
      <div className="px-5 py-3 bg-rbai-bg/50 border-t border-rbai-border">
        <button
          onClick={handleDismiss}
          className="text-xs text-rbai-text-light hover:text-rbai-text transition-colors"
        >
          Hide checklist
        </button>
      </div>
    </div>
  );
}
