"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Sparkles,
  BookOpen,
  Users,
  Contact,
  MessageSquare,
  Settings,
  Radio,
  Ticket,
  BarChart3,
  ScrollText,
  Timer,
  Zap,
  Workflow,
  Clock,
  Shield,
  FileCode,
  Webhook,
  ChevronLeft,
  ChevronRight,
  Share2,
  LayoutTemplate,
  ShoppingBag,
  ClipboardList,
  Inbox,
  Target,
  UserRound,
} from "lucide-react";
import { useState } from "react";

interface NavSection {
  title?: string;
  items: { name: string; href: string; icon: React.ElementType }[];
}

const sections: NavSection[] = [
  {
    items: [
      { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
      { name: "Done-for-You Setup", href: "/setup-application", icon: Sparkles },
      { name: "Profile", href: "/profile", icon: UserRound },
      { name: "Inbox", href: "/inbox", icon: Inbox },
      { name: "Conversations", href: "/conversations", icon: MessageSquare },
      { name: "Customers", href: "/customers", icon: Contact },
      { name: "Tickets", href: "/tickets", icon: Ticket },
    ],
  },
  {
    title: "Knowledge",
    items: [
      { name: "Knowledge Base", href: "/knowledge", icon: BookOpen },
      { name: "Canned Responses", href: "/canned-responses", icon: Zap },
      { name: "Automation", href: "/automation", icon: Workflow },
      { name: "Business Hours", href: "/business-hours", icon: Clock },
    ],
  },
  {
    title: "Storefront",
    items: [
      { name: "Landing Page", href: "/landing", icon: LayoutTemplate },
      { name: "Catalog", href: "/catalog", icon: ShoppingBag },
      { name: "Orders", href: "/orders", icon: ClipboardList },
    ],
  },
  {
    title: "Team",
    items: [
      { name: "Team", href: "/team", icon: Users },
      { name: "SLA Rules", href: "/sla", icon: Timer },
    ],
  },
  {
    title: "Channels",
    items: [
      { name: "Channels", href: "/channels", icon: Radio },
      { name: "Social Automation", href: "/social", icon: Share2 },
      { name: "Webhooks", href: "/webhooks", icon: Webhook },
    ],
  },
  {
    title: "Growth",
    items: [
      { name: "Lead Engine", href: "/leads", icon: Target },
    ],
  },
  {
    title: "Insights",
    items: [
      { name: "Analytics", href: "/analytics", icon: BarChart3 },
      { name: "Activity Log", href: "/activity", icon: ScrollText },
    ],
  },
  {
    title: "System",
    items: [
      { name: "Administration", href: "/admin", icon: Shield },
      { name: "API Docs", href: "/api-docs", icon: FileCode },
      { name: "Settings", href: "/settings", icon: Settings },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      className={cn(
        "flex flex-col bg-rbai-sidebar text-white transition-all duration-300",
        collapsed ? "w-16" : "w-60"
      )}
    >
      <div className="flex items-center gap-3 px-4 py-4 border-b border-white/10">
        <Image
          src="/agent-avatar.png"
          alt="Ride Bangla AI Agent"
          width={32}
          height={32}
          className="rounded-lg flex-shrink-0"
        />
        {!collapsed && (
          <div className="overflow-hidden">
            <h1 className="text-base font-bold tracking-tight">Ride Bangla AI Agent</h1>
            <p className="text-[10px] text-white/50">AI Customer Support</p>
          </div>
        )}
      </div>

      <nav className="flex-1 px-2 py-3 overflow-y-auto space-y-3">
        {sections.map((section, si) => (
          <div key={si}>
            {section.title && !collapsed && (
              <p className="px-3 mb-1 text-[10px] uppercase tracking-wider text-white/40 font-medium">
                {section.title}
              </p>
            )}
            {collapsed && si > 0 && (
              <div className="mx-3 mb-2 border-t border-white/10" />
            )}
            <div className="space-y-0.5">
              {section.items.map((item) => {
                const isActive =
                  pathname === item.href ||
                  (item.href !== "/" && pathname.startsWith(item.href));

                return (
                  <Link
                    key={item.name}
                    href={item.href}
                    className={cn(
                      "flex items-center gap-2.5 px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors",
                      isActive
                        ? "bg-rbai-sidebar-active text-white"
                        : "text-white/65 hover:bg-rbai-sidebar-hover hover:text-white"
                    )}
                    title={collapsed ? item.name : undefined}
                  >
                    <item.icon className="h-4 w-4 flex-shrink-0" />
                    {!collapsed && <span>{item.name}</span>}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="px-2 py-2 border-t border-white/10">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center justify-center w-full py-1.5 rounded-md text-white/40 hover:text-white hover:bg-rbai-sidebar-hover transition-colors"
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <ChevronLeft className="h-4 w-4" />
          )}
        </button>
      </div>
    </aside>
  );
}

