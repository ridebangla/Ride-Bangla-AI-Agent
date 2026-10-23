"use client";

import { Bell, Search, Sun, Moon, LogOut, User, Settings } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { useTheme } from "@/lib/hooks/use-theme";
import { useRouter } from "next/navigation";

interface HeaderProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}

interface NotificationItem {
  id: string;
  kind: string;
  text: string;
  at: string | null;
  href: string;
}

const NOTIF_SEEN_KEY = "rbai-notifications-seen-at";

export function Header({ title, description, actions }: HeaderProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  // Notification bell (A-to-Z audit 2026-10-20): previously a dead button
  // with a hardcoded red dot. Now fed by GET /api/notifications; the dot
  // reflects genuinely newer items vs the local seen-watermark and
  // clears when the panel is opened.
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifItems, setNotifItems] = useState<NotificationItem[]>([]);
  const [notifLatestAt, setNotifLatestAt] = useState<string | null>(null);
  const [notifSeenAt, setNotifSeenAt] = useState<string>("");
  const notifRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      setNotifSeenAt(window.localStorage.getItem(NOTIF_SEEN_KEY) || "");
    } catch { /* storage unavailable */ }
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/notifications");
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled) return;
        setNotifItems(Array.isArray(json.items) ? json.items : []);
        setNotifLatestAt(typeof json.latestAt === "string" ? json.latestAt : null);
      } catch { /* bell simply shows no dot on failure */ }
    };
    load();
    const timer = window.setInterval(() => {
      // Hidden tabs skip the poll; the next visible tick refreshes.
      if (document.visibilityState === "hidden") return;
      void load();
    }, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setNotifOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const hasUnread =
    !!notifLatestAt && (!notifSeenAt || notifLatestAt > notifSeenAt);

  const toggleNotifications = () => {
    const next = !notifOpen;
    setNotifOpen(next);
    if (next && notifLatestAt) {
      setNotifSeenAt(notifLatestAt);
      try {
        window.localStorage.setItem(NOTIF_SEEN_KEY, notifLatestAt);
      } catch { /* ignore */ }
    }
  };
  // Profile photo + display name for the avatar (set on the Profile page).
  // Best-effort only: any failure leaves the letter avatar untouched.
  const [profile, setProfile] = useState<{ name: string; photo: string } | null>(null);
  const { theme, toggleTheme } = useTheme();
  const router = useRouter();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/profile");
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled) return;
        setProfile({
          name:
            (typeof json.business?.contactName === "string" && json.business.contactName) ||
            (typeof json.admin?.name === "string" ? json.admin.name : "") ||
            "",
          photo:
            typeof json.business?.profilePhoto === "string"
              ? json.business.profilePhoto
              : "",
        });
      } catch {
        /* avatar falls back to the letter mark */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleLogout = async () => {
    await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "logout" }),
    });
    router.push("/login");
  };

  return (
    <header className="flex items-center justify-between px-6 py-4 bg-rbai-surface border-b border-rbai-border transition-theme">
      <div className="animate-fade-in">
        <h2 className="text-xl font-semibold text-rbai-text">{title}</h2>
        {description && (
          <p className="text-sm text-rbai-text-light mt-0.5">{description}</p>
        )}
      </div>

      <div className="flex items-center gap-2">
        {searchOpen && (
          <input
            type="text"
            placeholder="Search..."
            className="px-3 py-1.5 text-sm border border-rbai-border rounded-lg bg-rbai-surface text-rbai-text focus:outline-none focus:ring-2 focus:ring-rbai-primary/30 focus:border-rbai-primary w-64 animate-slide-in-down transition-theme"
            autoFocus
            onBlur={() => setSearchOpen(false)}
          />
        )}
        <button
          onClick={() => setSearchOpen(!searchOpen)}
          className="p-2 text-rbai-text-light hover:text-rbai-text hover:bg-rbai-primary-50 rounded-lg transition-colors"
          title="Search"
        >
          <Search className="h-5 w-5" />
        </button>

        <button
          onClick={toggleTheme}
          className="p-2 text-rbai-text-light hover:text-rbai-text hover:bg-rbai-primary-50 rounded-lg transition-colors"
          title={theme === "light" ? "Dark mode" : "Light mode"}
        >
          {theme === "light" ? (
            <Moon className="h-5 w-5" />
          ) : (
            <Sun className="h-5 w-5" />
          )}
        </button>

        <div className="relative" ref={notifRef}>
          <button
            onClick={toggleNotifications}
            className="relative p-2 text-rbai-text-light hover:text-rbai-text hover:bg-rbai-primary-50 rounded-lg transition-colors"
            title="Notifications"
            aria-label="Notifications"
          >
            <Bell className="h-5 w-5" />
            {hasUnread && (
              <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-rbai-danger rounded-full" />
            )}
          </button>
          {notifOpen && (
            <div className="absolute right-0 mt-2 w-80 max-w-[85vw] bg-rbai-surface border border-rbai-border rounded-lg shadow-lg py-1 z-50 animate-scale-in transition-theme">
              <p className="px-4 py-2 text-sm font-semibold text-rbai-text border-b border-rbai-border">
                Notifications
              </p>
              {notifItems.length === 0 ? (
                <p className="px-4 py-3 text-sm text-rbai-text-light">
                  No notifications yet.
                </p>
              ) : (
                <ul className="max-h-80 overflow-y-auto">
                  {notifItems.map((item) => (
                    <li key={item.id}>
                      <button
                        onClick={() => {
                          setNotifOpen(false);
                          router.push(item.href);
                        }}
                        className="w-full text-left px-4 py-2.5 hover:bg-rbai-primary-50 transition-colors"
                      >
                        <span className="block text-sm font-medium text-rbai-text">
                          {item.text}
                        </span>
                        {item.at && (
                          <span className="block text-xs text-rbai-text-light mt-0.5">
                            {new Date(item.at).toLocaleString()}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {actions}

        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setUserMenuOpen(!userMenuOpen)}
            className="flex items-center justify-center w-8 h-8 rounded-full bg-rbai-primary text-white text-sm font-medium hover:bg-rbai-primary-dark transition-colors overflow-hidden"
            title={profile?.name ? profile.name : "Account"}
          >
            {profile?.photo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={profile.photo} alt="" className="h-8 w-8 rounded-full object-cover" />
            ) : (
              (profile?.name || "A").trim().charAt(0).toUpperCase()
            )}
          </button>

          {userMenuOpen && (
            <div className="absolute right-0 mt-2 w-48 bg-rbai-surface border border-rbai-border rounded-lg shadow-lg py-1 z-50 animate-scale-in transition-theme">
              <button
                onClick={() => {
                  setUserMenuOpen(false);
                  router.push("/profile");
                }}
                className="flex items-center gap-2 w-full px-4 py-2 text-sm text-rbai-text hover:bg-rbai-primary-50 transition-colors"
              >
                <User className="h-4 w-4" />
                My Profile
              </button>
              <button
                onClick={() => {
                  setUserMenuOpen(false);
                  router.push("/settings");
                }}
                className="flex items-center gap-2 w-full px-4 py-2 text-sm text-rbai-text hover:bg-rbai-primary-50 transition-colors"
              >
                <Settings className="h-4 w-4" />
                Settings
              </button>
              <div className="border-t border-rbai-border my-1" />
              <button
                onClick={handleLogout}
                className="flex items-center gap-2 w-full px-4 py-2 text-sm text-rbai-danger hover:bg-red-50 transition-colors"
              >
                <LogOut className="h-4 w-4" />
                Sign Out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
