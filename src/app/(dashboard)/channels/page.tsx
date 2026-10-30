"use client";

import { Header } from "@/components/layout/header";
import {
  MessageCircle,
  Mail,
  Phone,
  Wifi,
  WifiOff,
  Save,
  Loader2,
  QrCode,
  Key,
  TestTube,
  PhoneCall,
  CheckCircle,
  XCircle,
  Eye,
  EyeOff,
  Link2,
  AlertTriangle,
  Info,
  Copy,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { FacebookIcon, InstagramIcon, XBrandIcon, MessengerIcon, YoutubeIcon, LinkedinIcon } from "@/components/ui/channel-icons";
import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

// ---------------------------------------------------------------------------
// Done-for-you banner — the customer never needs an API key.
// ---------------------------------------------------------------------------

function DoneForYouBanner() {
  return (
    <div className="mb-6 rounded-2xl border border-rbai-primary/30 bg-gradient-to-r from-rbai-primary-50 to-rbai-surface p-5 flex flex-col sm:flex-row sm:items-center gap-4 max-w-7xl">
      <div className="flex items-start gap-3 flex-1">
        <span className="p-2.5 rounded-xl bg-rbai-primary text-white shrink-0">
          <Sparkles className="h-5 w-5" />
        </span>
        <div>
          <h3 className="font-semibold text-rbai-text">
            {t("channels.no_api_keys_title")}
          </h3>
          <p className="text-sm text-rbai-text-light mt-0.5">
            You never need to find, buy or paste an API key. Apply for our
            done-for-you setup and our team will connect every channel for you.
          </p>
        </div>
      </div>
      <Link
        href="/setup-application"
        className="shrink-0 inline-flex items-center justify-center gap-1.5 rounded-lg bg-rbai-primary text-white px-4 py-2.5 text-sm font-medium hover:opacity-90 transition-opacity"
      >
        <Sparkles className="h-4 w-4" />
        Apply for setup
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// All-channels overview — every channel the customer can have, with honest
// status: connected, or "our team will connect it for you" (never faked).
// ---------------------------------------------------------------------------

interface ChannelOverviewEntry {
  id: string;
  name: string;
  icon: React.ElementType;
  iconClass: string;
  capability: string;
  connected: boolean;
  teamManaged: boolean;
}

function ChannelOverviewGrid({
  meta,
  x,
  whatsappCloud,
  whatsappLegacy,
}: {
  meta: ConnectStatus["meta"] | null;
  x: ConnectStatus["x"] | null;
  whatsappCloud: ConnectStatus["whatsappCloud"] | null;
  whatsappLegacy: ChannelData;
}) {
  const fbConnected = (meta?.accounts || []).some((a) => a.platform === "facebook");
  const igConnected = (meta?.accounts || []).some((a) => a.platform === "instagram");
  const waConnected = !!whatsappCloud?.configured || whatsappLegacy.status === "connected";

  const entries: ChannelOverviewEntry[] = [
    {
      id: "facebook",
      name: "Facebook",
      icon: FacebookIcon,
      iconClass: "bg-blue-50 text-[#1877F2]",
      capability: "AI replies to Page comments + Messenger messages",
      connected: fbConnected,
      teamManaged: false,
    },
    {
      id: "messenger",
      name: "Messenger",
      icon: MessengerIcon,
      iconClass: "bg-indigo-50 text-indigo-600",
      capability: "AI replies to direct messages via your Page",
      connected: fbConnected,
      teamManaged: false,
    },
    {
      id: "instagram",
      name: "Instagram",
      icon: InstagramIcon,
      iconClass: "bg-pink-50 text-pink-600",
      capability: "AI replies to comments + DMs",
      connected: igConnected,
      teamManaged: false,
    },
    {
      id: "whatsapp",
      name: "WhatsApp",
      icon: MessageCircle,
      iconClass: "bg-green-50 text-green-600",
      capability: "AI replies to customer messages",
      connected: waConnected,
      teamManaged: false,
    },
    {
      id: "youtube",
      name: "YouTube",
      icon: YoutubeIcon,
      iconClass: "bg-red-50 text-red-600",
      capability: "AI replies to video comments",
      connected: false,
      teamManaged: true,
    },
    {
      id: "linkedin",
      name: "LinkedIn",
      icon: LinkedinIcon,
      iconClass: "bg-sky-50 text-sky-700",
      capability: "AI replies to Page comments + messages",
      connected: false,
      teamManaged: true,
    },
    {
      id: "x",
      name: "X",
      icon: XBrandIcon,
      iconClass: "bg-slate-100 text-slate-700",
      capability: "Posts, replies and DMs",
      connected: !!x?.configured,
      teamManaged: false,
    },
  ];

  return (
    <div className="mb-8 max-w-7xl">
      <h2 className="text-lg font-semibold text-rbai-text mb-1">
        All your channels
      </h2>
      <p className="text-sm text-rbai-text-light mb-4">
        Everywhere your AI can talk to customers. Channels without a live
        connection yet are connected by our team — nothing is faked.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {entries.map((e) => (
          <div
            key={e.id}
            className="bg-rbai-surface rounded-xl border border-rbai-border p-4 flex flex-col gap-3"
          >
            <div className="flex items-center justify-between">
              <div className={cn("p-2.5 rounded-lg", e.iconClass)}>
                <e.icon className="h-5 w-5" />
              </div>
              {e.connected ? (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-rbai-success/10 text-rbai-success">
                  <span className="w-1.5 h-1.5 rounded-full bg-rbai-success" />
                  Connected
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                  {e.teamManaged ? "Team connects it" : "Not connected"}
                </span>
              )}
            </div>
            <div>
              <h3 className="font-semibold text-rbai-text text-sm">{e.name}</h3>
              <p className="text-xs text-rbai-text-light mt-0.5">
                {e.capability}
              </p>
            </div>
            {!e.connected && (
              <Link
                href="/setup-application"
                className="mt-auto text-xs font-medium text-rbai-primary hover:underline"
              >
                {e.teamManaged
                  ? "Our team will connect this for you →"
                  : "Connect it, or let our team do it →"}
              </Link>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChannelData {
  id: string | null;
  type: string;
  isActive: boolean;
  config: Record<string, unknown>;
  status: string;
}

type WhatsAppMode = "web" | "api";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  const isConnected = status === "connected";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium",
        isConnected
          ? "bg-rbai-success/10 text-rbai-success"
          : "bg-rbai-danger/10 text-rbai-danger"
      )}
    >
      <span
        className={cn(
          "w-1.5 h-1.5 rounded-full",
          isConnected ? "bg-rbai-success" : "bg-rbai-danger"
        )}
      />
      {isConnected ? "Connected" : "Disconnected"}
    </span>
  );
}

function Toggle({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={() => onChange(!enabled)}
      className={cn(
        "relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-rbai-primary/30 focus:ring-offset-2",
        enabled ? "bg-rbai-primary" : "bg-rbai-border"
      )}
    >
      <span
        className={cn(
          "pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out",
          enabled ? "translate-x-5" : "translate-x-0"
        )}
      />
    </button>
  );
}

function FieldInput({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  isSecret = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  isSecret?: boolean;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div>
      <label className="block text-xs font-medium text-rbai-text-light mb-1">
        {label}
      </label>
      <div className="relative">
        <input
          type={isSecret && !visible ? "password" : type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full px-3 py-2 text-sm border border-rbai-border rounded-lg bg-rbai-bg text-rbai-text placeholder:text-rbai-text-light/50 focus:outline-none focus:ring-2 focus:ring-rbai-primary/30 focus:border-rbai-primary transition-colors"
        />
        {isSecret && (
          <button
            type="button"
            onClick={() => setVisible(!visible)}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-rbai-text-light hover:text-rbai-text transition-colors"
          >
            {visible ? (
              <EyeOff className="h-3.5 w-3.5" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WhatsApp Card
// ---------------------------------------------------------------------------

function WhatsAppCard({
  channel,
  onSave,
  onAction,
  saving,
}: {
  channel: ChannelData;
  onSave: (type: string, config: Record<string, unknown>, isActive: boolean) => void;
  onAction: (type: string, action: string) => void;
  saving: boolean;
}) {
  const cfg = channel.config as Record<string, string>;
  const [isActive, setIsActive] = useState(channel.isActive);
  const [mode, setMode] = useState<WhatsAppMode>(
    (cfg.mode as WhatsAppMode) || "web"
  );
  const [apiKey, setApiKey] = useState(cfg.apiKey || "");
  const [phoneNumber, setPhoneNumber] = useState(cfg.phoneNumber || "");
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectStatus, setConnectStatus] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isConnected = channel.status === "connected";

  // Poll WhatsApp status while connecting to get QR code updates
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const handleConnect = async () => {
    setConnecting(true);
    setQrCode(null);
    setConnectError(null);
    setConnectStatus(null);
    // Every failure path below stops polling AND resets `connecting`,
    // so the button re-enables and the user can retry. Previously a
    // failed start left the button stuck on "Connecting..." forever
    // with no error shown (owner video 2026-10-30: spinner, no QR,
    // no error, status still Disconnected).
    const stopWithError = (message: string) => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      setConnecting(false);
      setConnectError(message);
    };
    let postRes: Response | null = null;
    try {
      postRes = await fetch("/api/channels/whatsapp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "connect" }),
      });
    } catch {
      stopWithError(
        "Could not reach the server. Check your connection and try again."
      );
      return;
    }
    if (!postRes || !postRes.ok) {
      let message = "WhatsApp could not be started. Try again.";
      try {
        const data = await postRes?.json();
        if (typeof data?.error === "string" && data.error) {
          message = data.error;
        } else if (typeof data?.message === "string" && data.message) {
          message = data.message;
        }
      } catch {
        // Keep the default message when the error body is not JSON.
      }
      stopWithError(message);
      return;
    }
    try {
      const data = await postRes.json();
      if (data.qr) setQrCode(data.qr);
      if (typeof data?.message === "string" && data.message) {
        setConnectStatus(data.message);
      }
      if (data.status === "connected") {
        setConnecting(false);
        onAction("whatsapp", "connect");
        return;
      }
    } catch {
      // Unparseable start response: polling below still resolves it.
    }
    // Start polling for QR code / status updates
    if (pollRef.current) clearInterval(pollRef.current);
    const pollStartedAt = Date.now();
    let consecutiveFailures = 0;
    pollRef.current = setInterval(async () => {
      // Stop polling after 10 minutes, exactly as on connect/unmount —
      // and reset the button with a timeout message (previously the
      // interval was cleared but `connecting` stayed true forever).
      if (Date.now() - pollStartedAt > 10 * 60 * 1000) {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        setConnecting(false);
        setConnectError("Timed out waiting for WhatsApp. Try again.");
        return;
      }
      // Hidden tabs skip the fetch; the next visible tick resumes.
      if (document.visibilityState === "hidden") return;
      try {
        const statusRes = await fetch("/api/channels/whatsapp");
        if (!statusRes.ok) {
          consecutiveFailures += 1;
          if (consecutiveFailures >= 3) {
            stopWithError("Could not check WhatsApp status. Try again.");
          }
          return;
        }
        consecutiveFailures = 0;
        const status = await statusRes.json();
        if (status.qr) setQrCode(status.qr);
        if (typeof status?.message === "string" && status.message) {
          setConnectStatus(status.message);
        }
        if (status.status === "connected") {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          setConnecting(false);
          onAction("whatsapp", "connect");
        } else if (status.status === "error") {
          stopWithError(
            typeof status.message === "string" && status.message
              ? status.message
              : "WhatsApp connection failed. Try again."
          );
        }
      } catch {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 3) {
          stopWithError("Could not check WhatsApp status. Try again.");
        }
      }
    }, 3000);
  };

  return (
    <div className="bg-rbai-surface rounded-xl border border-rbai-border overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-rbai-border">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-green-50 text-green-600">
              <MessageCircle className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-semibold text-rbai-text">WhatsApp</h3>
              <p className="text-xs text-rbai-text-light mt-0.5">
                Messaging via WhatsApp Web or API
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <StatusBadge status={channel.status} />
            <Toggle enabled={isActive} onChange={setIsActive} />
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="p-5 space-y-4">
        {/* Mode selector */}
        <div>
          <label className="block text-xs font-medium text-rbai-text-light mb-2">
            Connection Method
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setMode("web")}
              className={cn(
                "flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border transition-colors",
                mode === "web"
                  ? "border-green-300 bg-green-50 text-green-700"
                  : "border-rbai-border bg-rbai-bg text-rbai-text-light hover:bg-rbai-primary-50 hover:text-rbai-text"
              )}
            >
              <QrCode className="h-4 w-4" />
              WhatsApp Web
            </button>
            <button
              type="button"
              onClick={() => setMode("api")}
              className={cn(
                "flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border transition-colors",
                mode === "api"
                  ? "border-green-300 bg-green-50 text-green-700"
                  : "border-rbai-border bg-rbai-bg text-rbai-text-light hover:bg-rbai-primary-50 hover:text-rbai-text"
              )}
            >
              <Key className="h-4 w-4" />
              API
            </button>
          </div>
        </div>

        {mode === "web" ? (
          <div>
            {isConnected ? (
              <div className="rounded-lg border border-green-200 bg-green-50 p-4">
                <div className="flex items-center gap-2 mb-2">
                  <CheckCircle className="h-4 w-4 text-green-600" />
                  <span className="text-sm font-medium text-green-700">
                    Session Active
                  </span>
                </div>
                {phoneNumber && (
                  <p className="text-sm text-green-600">
                    Phone: {phoneNumber}
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => onAction("whatsapp", "disconnect")}
                  className="mt-3 flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-600 bg-white border border-red-200 rounded-lg hover:bg-red-50 transition-colors"
                >
                  <WifiOff className="h-3.5 w-3.5" />
                  Disconnect
                </button>
              </div>
            ) : (
              <div className="rounded-lg border border-rbai-border bg-rbai-bg p-6 flex flex-col items-center">
                <div className="w-48 h-48 bg-white border-2 border-dashed border-rbai-border rounded-lg flex items-center justify-center mb-3 overflow-hidden">
                  {qrCode ? (
                    <img
                      src={qrCode}
                      alt="WhatsApp QR Code"
                      className="w-full h-full object-contain"
                    />
                  ) : connecting ? (
                    <Loader2 className="h-8 w-8 animate-spin text-green-600" />
                  ) : (
                    <div className="text-center">
                      <QrCode className="h-10 w-10 text-rbai-text-light/40 mx-auto mb-1" />
                      <p className="text-xs text-rbai-text-light/60">
                        QR Code
                      </p>
                    </div>
                  )}
                </div>
                <p className="text-xs text-rbai-text-light text-center max-w-[220px]">
                  {qrCode
                    ? "Scan this QR code with WhatsApp on your phone to connect"
                    : connecting && connectStatus
                      ? connectStatus
                      : connecting
                        ? "Connecting to WhatsApp…"
                        : "Click Connect to generate a QR code"}
                </p>
                {connectError && (
                  <p
                    role="alert"
                    className="mt-2 text-xs text-red-600 text-center max-w-[220px]"
                  >
                    {connectError}
                  </p>
                )}
                <button
                  type="button"
                  onClick={handleConnect}
                  disabled={connecting}
                  className="mt-3 flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50"
                >
                  {connecting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Wifi className="h-4 w-4" />
                  )}
                  {connecting ? "Connecting..." : "Connect"}
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-rbai-text-light rounded-lg bg-rbai-bg border border-rbai-border p-3">
              Prefer hands-off? You don&apos;t have to set this up yourself —{" "}
              <Link
                href="/setup-application"
                className="text-rbai-primary font-medium hover:underline"
              >
                apply for done-for-you setup
              </Link>{" "}
              and our team will connect WhatsApp for you.
            </p>
            <FieldInput
              label="API Key"
              value={apiKey}
              onChange={setApiKey}
              placeholder="Enter your WhatsApp API key"
              isSecret
            />
            <FieldInput
              label="Phone Number"
              value={phoneNumber}
              onChange={setPhoneNumber}
              placeholder="+1234567890"
            />
            {isConnected && (
              <div className="rounded-lg border border-green-200 bg-green-50 p-3 flex items-center gap-2">
                <CheckCircle className="h-4 w-4 text-green-600" />
                <span className="text-sm text-green-700">
                  API connected - Phone: {phoneNumber || "N/A"}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-5 py-3 border-t border-rbai-border bg-rbai-bg/50">
        <button
          type="button"
          disabled={saving}
          onClick={() =>
            onSave(
              "whatsapp",
              { mode, apiKey, phoneNumber },
              isActive
            )
          }
          className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-rbai-primary rounded-lg hover:bg-rbai-primary-dark disabled:opacity-50 transition-colors"
        >
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          Save
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Email Card
// ---------------------------------------------------------------------------

function EmailCard({
  channel,
  onSave,
  onAction,
  saving,
  onRefresh,
}: {
  channel: ChannelData;
  onSave: (type: string, config: Record<string, unknown>, isActive: boolean) => void;
  onAction: (type: string, action: string) => void;
  saving: boolean;
  onRefresh?: () => void;
}) {
  const cfg = channel.config as Record<string, string>;
  const [isActive, setIsActive] = useState(channel.isActive);

  const [smtpHost, setSmtpHost] = useState(cfg.smtpHost || "");
  const [smtpPort, setSmtpPort] = useState(cfg.smtpPort || "587");
  const [smtpUser, setSmtpUser] = useState(cfg.smtpUser || "");
  const [smtpPass, setSmtpPass] = useState(cfg.smtpPass || "");
  const [smtpFrom, setSmtpFrom] = useState(cfg.smtpFrom || "");

  const [imapHost, setImapHost] = useState(cfg.imapHost || "");
  const [imapPort, setImapPort] = useState(cfg.imapPort || "993");
  const [imapUser, setImapUser] = useState(cfg.imapUser || "");
  const [imapPass, setImapPass] = useState(cfg.imapPass || "");

  const [testResult, setTestResult] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Connect starts the listener from the SAVED details, so unsaved edits
  // must be saved first — otherwise Connect would run the old details.
  const isDirty =
    smtpHost !== (cfg.smtpHost || "") ||
    smtpPort !== (cfg.smtpPort || "587") ||
    smtpUser !== (cfg.smtpUser || "") ||
    smtpPass !== (cfg.smtpPass || "") ||
    smtpFrom !== (cfg.smtpFrom || "") ||
    imapHost !== (cfg.imapHost || "") ||
    imapPort !== (cfg.imapPort || "993") ||
    imapUser !== (cfg.imapUser || "") ||
    imapPass !== (cfg.imapPass || "");

  const handleTest = async () => {
    // Tests exactly what is typed (the test itself never saves anything).
    setTestResult("Testing…");
    try {
      const res = await fetch("/api/channels/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "test",
          config: {
            smtpHost,
            smtpPort,
            smtpUser,
            smtpPass,
            smtpFrom,
            imapHost,
            imapPort,
            imapUser,
            imapPass,
          },
        }),
      });
      const data = await res.json();
      setTestResult(
        data.message ||
          data.error ||
          (res.ok ? "Connection works." : "Connection failed.")
      );
    } catch {
      setTestResult("Test failed. Check the details and try again.");
    }
    setTimeout(() => setTestResult(null), 8000);
  };

  const handleConnect = () => {
    if (isDirty) {
      setTestResult("Save your details first, then Connect.");
      setTimeout(() => setTestResult(null), 8000);
      return;
    }
    setConnecting(true);
    setTestResult(null);
    onAction("email", "connect");
    // IMAP connects asynchronously: poll the channel row until it flips
    // to connected (60 s cap), then refresh the page's channel list so
    // the badge updates. Mirrors the WhatsApp card's QR polling.
    if (pollRef.current) clearInterval(pollRef.current);
    const pollStartedAt = Date.now();
    pollRef.current = setInterval(async () => {
      if (Date.now() - pollStartedAt > 60 * 1000) {
        if (pollRef.current) clearInterval(pollRef.current);
        setConnecting(false);
        return;
      }
      if (document.visibilityState === "hidden") return;
      try {
        const statusRes = await fetch("/api/channels/email");
        if (statusRes.ok) {
          const doc = await statusRes.json();
          if (doc.status === "connected") {
            if (pollRef.current) clearInterval(pollRef.current);
            setConnecting(false);
            onRefresh?.();
          }
        }
      } catch {
        /* ignore polling errors */
      }
    }, 3000);
  };

  return (
    <div className="bg-rbai-surface rounded-xl border border-rbai-border overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-rbai-border">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-blue-50 text-blue-600">
              <Mail className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-semibold text-rbai-text">Email</h3>
              <p className="text-xs text-rbai-text-light mt-0.5">
                Send and receive via SMTP / IMAP
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <StatusBadge status={channel.status} />
            <Toggle enabled={isActive} onChange={setIsActive} />
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="p-5 space-y-5">
        {/* SMTP */}
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-rbai-text-light mb-3">
            SMTP Settings (Outgoing)
          </h4>
          <div className="grid grid-cols-2 gap-3">
            <FieldInput
              label="Host"
              value={smtpHost}
              onChange={setSmtpHost}
              placeholder="Your SMTP server address"
            />
            <FieldInput
              label="Port"
              value={smtpPort}
              onChange={setSmtpPort}
              placeholder="587"
              type="text"
            />
            <FieldInput
              label="Username"
              value={smtpUser}
              onChange={setSmtpUser}
              placeholder="Your SMTP username"
            />
            <FieldInput
              label="Password"
              value={smtpPass}
              onChange={setSmtpPass}
              placeholder="Password"
              isSecret
            />
          </div>
          <div className="mt-3">
            <FieldInput
              label="From Address"
              value={smtpFrom}
              onChange={setSmtpFrom}
              placeholder="Sender email address"
            />
          </div>
        </div>

        {/* IMAP */}
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-rbai-text-light mb-3">
            IMAP Settings (Incoming)
          </h4>
          <div className="grid grid-cols-2 gap-3">
            <FieldInput
              label="Host"
              value={imapHost}
              onChange={setImapHost}
              placeholder="Your IMAP server address"
            />
            <FieldInput
              label="Port"
              value={imapPort}
              onChange={setImapPort}
              placeholder="993"
              type="text"
            />
            <FieldInput
              label="Username"
              value={imapUser}
              onChange={setImapUser}
              placeholder="Your IMAP username"
            />
            <FieldInput
              label="Password"
              value={imapPass}
              onChange={setImapPass}
              placeholder="Password"
              isSecret
            />
          </div>
        </div>

        {/* Test result */}
        {testResult && (
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 flex items-center gap-2">
            <CheckCircle className="h-4 w-4 text-blue-600" />
            <span className="text-sm text-blue-700">{testResult}</span>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-5 py-3 border-t border-rbai-border bg-rbai-bg/50 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={() =>
            onSave(
              "email",
              {
                smtpHost,
                smtpPort,
                smtpUser,
                smtpPass,
                smtpFrom,
                imapHost,
                imapPort,
                imapUser,
                imapPass,
              },
              isActive
            )
          }
          className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-rbai-primary rounded-lg hover:bg-rbai-primary-dark disabled:opacity-50 transition-colors"
        >
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          Save
        </button>
        <button
          type="button"
          disabled={connecting}
          onClick={handleConnect}
          className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-green-700 bg-green-50 border border-green-200 rounded-lg hover:bg-green-100 disabled:opacity-50 transition-colors"
        >
          <Wifi className="h-4 w-4" />
          {connecting ? "Connecting…" : "Connect"}
        </button>
        <button
          type="button"
          onClick={handleTest}
          className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-blue-600 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors"
        >
          <TestTube className="h-4 w-4" />
          Test Connection
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phone Card
// ---------------------------------------------------------------------------

function PhoneCard({
  channel,
  onSave,
  onAction,
  saving,
}: {
  channel: ChannelData;
  onSave: (type: string, config: Record<string, unknown>, isActive: boolean) => void;
  onAction: (type: string, action: string) => void;
  saving: boolean;
}) {
  const cfg = channel.config as Record<string, string>;
  const [isActive, setIsActive] = useState(channel.isActive);

  const [twilioSid, setTwilioSid] = useState(cfg.twilioSid || "");
  const [twilioToken, setTwilioToken] = useState(cfg.twilioToken || "");
  const [twilioPhone, setTwilioPhone] = useState(cfg.twilioPhone || "");

  const [elevenLabsKey, setElevenLabsKey] = useState(cfg.elevenLabsKey || "");
  const [elevenLabsVoice, setElevenLabsVoice] = useState(
    // Female voices only (owner rule): a previously saved male voice
    // shows as Rachel, the first female voice, until the next Save.
    cfg.elevenLabsVoice === "drew" || cfg.elevenLabsVoice === "clyde"
      ? "rachel"
      : cfg.elevenLabsVoice || ""
  );

  const voiceOptions = [
    { id: "", label: "Select a voice..." },
    { id: "rachel", label: "Rachel - Calm, professional" },
    { id: "domi", label: "Domi - Energetic, upbeat" },
    { id: "bella", label: "Bella - Soft, gentle" },
  ];

  const [testResult, setTestResult] = useState<string | null>(null);

  // Connect verifies the SAVED Twilio details, so unsaved edits must be
  // saved first — otherwise Connect would verify the old details.
  // (The ElevenLabs voice is not part of this check: it does not affect
  // whether Twilio connects.)
  const isTwilioDirty =
    twilioSid !== (cfg.twilioSid || "") ||
    twilioToken !== (cfg.twilioToken || "") ||
    twilioPhone !== (cfg.twilioPhone || "");

  const handleTestCall = async () => {
    // Verifies exactly what is typed: a read-only Twilio credential
    // check. It never saves anything, and no call is placed.
    setTestResult("Verifying…");
    try {
      const res = await fetch("/api/channels/phone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "test",
          config: { twilioSid, twilioToken, twilioPhone },
        }),
      });
      const data = await res.json();
      setTestResult(
        data.message ||
          data.error ||
          (res.ok ? "Twilio credentials verified." : "Verification failed.")
      );
    } catch {
      setTestResult("Verification failed. Check the details and try again.");
    }
    setTimeout(() => setTestResult(null), 8000);
  };

  const handlePhoneConnect = () => {
    if (isTwilioDirty) {
      setTestResult("Save your details first, then Connect.");
      setTimeout(() => setTestResult(null), 8000);
      return;
    }
    onAction("phone", "connect");
  };

  return (
    <div className="bg-rbai-surface rounded-xl border border-rbai-border overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-rbai-border">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-purple-50 text-purple-600">
              <Phone className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-semibold text-rbai-text">Phone</h3>
              <p className="text-xs text-rbai-text-light mt-0.5">
                Voice calls via Twilio and ElevenLabs
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <StatusBadge status={channel.status} />
            <Toggle enabled={isActive} onChange={setIsActive} />
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="p-5 space-y-5">
        {/* Twilio */}
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-rbai-text-light mb-3">
            Twilio Settings
          </h4>
          <div className="space-y-3">
            <FieldInput
              label="Account SID"
              value={twilioSid}
              onChange={setTwilioSid}
              placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            />
            <FieldInput
              label="Auth Token"
              value={twilioToken}
              onChange={setTwilioToken}
              placeholder="Your Twilio auth token"
              isSecret
            />
            <FieldInput
              label="Phone Number"
              value={twilioPhone}
              onChange={setTwilioPhone}
              placeholder="+1234567890"
            />
          </div>
        </div>

        {/* ElevenLabs */}
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-rbai-text-light mb-3">
            ElevenLabs Voice
          </h4>
          <div className="space-y-3">
            <FieldInput
              label="API Key"
              value={elevenLabsKey}
              onChange={setElevenLabsKey}
              placeholder="Your ElevenLabs API key"
              isSecret
            />
            <div>
              <label className="block text-xs font-medium text-rbai-text-light mb-1">
                Voice
              </label>
              <select
                value={elevenLabsVoice}
                onChange={(e) => setElevenLabsVoice(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-rbai-border rounded-lg bg-rbai-bg text-rbai-text focus:outline-none focus:ring-2 focus:ring-rbai-primary/30 focus:border-rbai-primary transition-colors"
              >
                {voiceOptions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Test result */}
        {testResult && (
          <div className="rounded-lg border border-purple-200 bg-purple-50 p-3 flex items-center gap-2">
            <CheckCircle className="h-4 w-4 text-purple-600" />
            <span className="text-sm text-purple-700">{testResult}</span>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-5 py-3 border-t border-rbai-border bg-rbai-bg/50 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={() =>
            onSave(
              "phone",
              {
                twilioSid,
                twilioToken,
                twilioPhone,
                elevenLabsKey,
                elevenLabsVoice,
              },
              isActive
            )
          }
          className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-rbai-primary rounded-lg hover:bg-rbai-primary-dark disabled:opacity-50 transition-colors"
        >
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          Save
        </button>
        <button
          type="button"
          onClick={handlePhoneConnect}
          className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-green-700 bg-green-50 border border-green-200 rounded-lg hover:bg-green-100 transition-colors"
        >
          <Wifi className="h-4 w-4" />
          Connect
        </button>
        <button
          type="button"
          onClick={handleTestCall}
          className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-purple-600 bg-purple-50 border border-purple-200 rounded-lg hover:bg-purple-100 transition-colors"
        >
          <PhoneCall className="h-4 w-4" />
          Verify Credentials
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Website widget card — shows the public site key + embed snippet.
// ---------------------------------------------------------------------------

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function WidgetCard({
  siteKey,
  businessName,
}: {
  siteKey: string | null;
  businessName: string | null;
}) {
  const [copied, setCopied] = useState(false);
  // Tenant identity isolation (2026-10-23): without data-title the
  // embed falls back to its platform default header ("Ride Bangla
  // AI Agent") — a tenant's customers would see OUR name on THEIR
  // shop's agent. The snippet therefore carries the business's own
  // name whenever it is known.
  const titleAttr = businessName
    ? `\n  data-title="${escapeHtmlAttr(businessName)}"`
    : "";
  const snippet = siteKey
    ? `<script src="${typeof window !== "undefined" ? window.location.origin : ""}/widget/ride-bangla-chat.js"\n  data-site-key="${siteKey}"${titleAttr}\n  data-visitor-id="VISITOR_ID">\n</script>`
    : "";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="bg-white rounded-xl border border-rbai-border p-6 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-rbai-primary/10">
            <MessageCircle className="h-5 w-5 text-rbai-primary" />
          </div>
          <div>
            <h3 className="font-semibold text-rbai-text">Website Widget</h3>
            <p className="text-xs text-rbai-text-light">Live chat for your website</p>
          </div>
        </div>
        <StatusBadge status={siteKey ? "connected" : "disconnected"} />
      </div>

      {siteKey ? (
        <>
          <label className="block text-xs font-medium text-rbai-text-light mb-1">
            Site key (public — safe to embed)
          </label>
          <code className="block text-xs bg-rbai-bg rounded-lg px-3 py-2 mb-3 break-all text-rbai-text">
            {siteKey}
          </code>
          <label className="block text-xs font-medium text-rbai-text-light mb-1">
            Embed snippet
          </label>
          <pre className="text-xs bg-rbai-bg rounded-lg px-3 py-2 mb-3 overflow-x-auto text-rbai-text whitespace-pre-wrap break-all">
            {snippet}
          </pre>
          <button
            type="button"
            onClick={copy}
            className="px-4 py-2 text-sm font-medium text-white bg-rbai-primary rounded-lg hover:bg-rbai-primary/90 transition-colors"
          >
            {copied ? "Copied" : "Copy snippet"}
          </button>
          <p className="text-xs text-rbai-text-light mt-3">
            Replace VISITOR_ID with a unique id per visitor. Visitors chat through
            a public endpoint (rate-limited); no admin login is exposed.
          </p>
        </>
      ) : (
        <p className="text-sm text-rbai-text-light">
          Site key is available to the Super Admin. Sign in as the super admin to
          view the embed snippet.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 5: social connect cards — Meta (Facebook + Instagram), WhatsApp
// Cloud API, X. Every card degrades honestly when env is missing: no fake
// connected states, no crashes — "not connected yet, see setup guide".
// ---------------------------------------------------------------------------

interface MetaAccountInfo {
  id: string;
  platform: string;
  label: string;
  accountRef: string;
}

interface ConnectStatus {
  meta: {
    configured: boolean;
    webhookConfigured: boolean;
    accounts: MetaAccountInfo[];
    webhookUrl: string;
    setupGuide: string[];
  };
  whatsappCloud: {
    configured: boolean;
    webhookConfigured: boolean;
    webhookUrl: string;
    setupGuide: string[];
  };
  x: {
    configured: boolean;
    writeConfigured: boolean;
    hasBearer: boolean;
    hasUserContext: boolean;
    webhookUrl: string;
    setupGuide: string[];
  };
}

function SetupGuide({ steps }: { steps: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-xs font-medium text-rbai-primary hover:underline"
      >
        <Info className="h-3.5 w-3.5" />
        {open ? "Hide setup guide" : "Show setup guide"}
      </button>
      {open && (
        <ol className="mt-2 space-y-1.5 text-xs text-rbai-text-light list-decimal list-inside bg-rbai-bg rounded-lg p-3">
          {steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      )}
    </div>
  );
}

function NotConnectedNote({ what }: { what: string }) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 flex items-start gap-2">
      <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
      <p className="text-xs text-amber-800">
        <span className="font-semibold">{what} is not connected yet.</span>{" "}
        Nothing is faked — connect it below when the setup is done.
      </p>
    </div>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <p className="text-xs font-medium text-rbai-text-light mb-1">{label}</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 text-xs bg-rbai-bg rounded-lg px-3 py-2 break-all text-rbai-text">
          {value}
        </code>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch { /* ignore */ }
          }}
          className="p-2 text-rbai-text-light hover:text-rbai-text border border-rbai-border rounded-lg transition-colors"
          title="Copy"
        >
          {copied ? <CheckCircle className="h-4 w-4 text-rbai-success" /> : <Copy className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

function MetaCard({
  status,
  onToast,
}: {
  status: ConnectStatus["meta"] | null;
  onToast: (m: string, t: "success" | "error") => void;
}) {
  const [connecting, setConnecting] = useState(false);
  const [accounts, setAccounts] = useState<MetaAccountInfo[]>(status?.accounts || []);
  const [autoReply, setAutoReply] = useState<Record<string, boolean>>({});
  const [toggling, setToggling] = useState<string | null>(null);

  useEffect(() => {
    if (status?.accounts) {
      setAccounts(status.accounts);
      fetch("/api/social/accounts")
        .then((r) => (r.ok ? r.json() : []))
        .then((list: Array<{ id: string; autoReply: boolean }>) => {
          const map: Record<string, boolean> = {};
          for (const a of list) map[a.id] = a.autoReply === true;
          setAutoReply(map);
        })
        .catch(() => {});
    }
  }, [status]);

  // OAuth result banners (?meta=connected / denied / error)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const m = params.get("meta");
    if (m === "connected") {
      onToast("Meta accounts connected", "success");
      window.history.replaceState({}, "", "/channels");
      fetch("/api/channels/connect-status")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d?.meta?.accounts && setAccounts(d.meta.accounts))
        .catch(() => {});
    } else if (m === "denied") {
      onToast("Meta connect was cancelled", "error");
      window.history.replaceState({}, "", "/channels");
    } else if (m === "error") {
      onToast("Meta connect failed — try again", "error");
      window.history.replaceState({}, "", "/channels");
    }
  }, [onToast]);

  const handleConnect = async () => {
    setConnecting(true);
    try {
      const res = await fetch("/api/social/meta/connect");
      const data = await res.json();
      if (!data.configured) {
        onToast(data.reason || "Meta is not configured yet", "error");
        return;
      }
      window.location.href = data.url;
    } catch {
      onToast("Failed to start Meta connect", "error");
    } finally {
      setConnecting(false);
    }
  };

  const handleAutoReply = async (id: string, value: boolean) => {
    setToggling(id);
    try {
      const res = await fetch(`/api/social/accounts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoReply: value }),
      });
      if (!res.ok) throw new Error("Failed");
      setAutoReply((prev) => ({ ...prev, [id]: value }));
      onToast(
        value ? "Auto-reply enabled for this account" : "Auto-reply disabled — the AI will only draft replies",
        "success"
      );
    } catch {
      onToast("Failed to update auto-reply", "error");
    } finally {
      setToggling(null);
    }
  };

  const handleDisconnect = async (id: string, label: string) => {
    if (!confirm(`Disconnect ${label}?`)) return;
    try {
      const res = await fetch(`/api/social/accounts/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed");
      setAccounts((prev) => prev.filter((a) => a.id !== id));
      onToast(`${label} disconnected`, "success");
    } catch {
      onToast("Failed to disconnect", "error");
    }
  };

  return (
    <div className="bg-rbai-surface rounded-xl border border-rbai-border overflow-hidden">
      <div className="px-5 py-4 border-b border-rbai-border">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-blue-50 text-[#1877F2]">
              <FacebookIcon className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-semibold text-rbai-text">Meta</h3>
              <p className="text-xs text-rbai-text-light mt-0.5">
                Facebook Pages + Instagram via OAuth
              </p>
            </div>
          </div>
          <StatusBadge status={status && accounts.length > 0 ? "connected" : "disconnected"} />
        </div>
      </div>

      <div className="p-5 space-y-4">
        {!status ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-6 w-6 animate-spin text-rbai-primary" />
          </div>
        ) : !status.configured ? (
          <>
            <NotConnectedNote what="Meta" />
            <SetupGuide steps={status.setupGuide} />
          </>
        ) : (
          <>
            {accounts.length === 0 ? (
              <p className="text-sm text-rbai-text-light">
                Meta app is configured but no Pages are connected yet. Click Connect to sign in with
                the Facebook account that owns your Page.
              </p>
            ) : (
              <div className="space-y-2">
                {accounts.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center gap-3 rounded-lg border border-rbai-border bg-rbai-bg p-3"
                  >
                    <div className={cn("p-2 rounded-lg", a.platform === "instagram" ? "bg-pink-50 text-pink-600" : "bg-blue-50 text-[#1877F2]")}>
                      {a.platform === "instagram" ? <InstagramIcon className="h-4 w-4" /> : <FacebookIcon className="h-4 w-4" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-rbai-text truncate">{a.label}</p>
                      <p className="text-xs text-rbai-text-light capitalize">{a.platform}</p>
                      <label className="mt-1.5 flex items-center gap-2 text-xs text-rbai-text-light cursor-pointer">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={autoReply[a.id] === true}
                          disabled={toggling === a.id}
                          onClick={() => handleAutoReply(a.id, !(autoReply[a.id] === true))}
                          className={cn(
                            "relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors",
                            autoReply[a.id] === true ? "bg-rbai-primary" : "bg-rbai-border"
                          )}
                        >
                          <span
                            className={cn(
                              "pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition",
                              autoReply[a.id] === true ? "translate-x-4" : "translate-x-0"
                            )}
                          />
                        </button>
                        Auto-reply to comments
                      </label>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDisconnect(a.id, a.label)}
                      className="text-xs font-medium text-red-600 hover:underline flex-shrink-0"
                    >
                      Disconnect
                    </button>
                  </div>
                ))}
                <p className="text-xs text-rbai-text-light">
                  Auto-reply off (default): the AI drafts comment replies for your approval in the Inbox.
                  Auto-reply on: replies post automatically.
                </p>
              </div>
            )}

            <button
              type="button"
              onClick={handleConnect}
              disabled={connecting}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-[#1877F2] rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
              {connecting ? "Connecting..." : accounts.length > 0 ? "Connect another account" : "Connect with Facebook"}
            </button>

            <div className="space-y-3 pt-1">
              <CopyRow label="Webhook URL (paste in the Meta dashboard)" value={status.webhookUrl} />
              <div className="flex items-center gap-2 text-xs">
                <span className="text-rbai-text-light">Verify token:</span>
                {status.webhookConfigured ? (
                  <span className="inline-flex items-center gap-1 text-rbai-success font-medium">
                    <CheckCircle className="h-3.5 w-3.5" /> Set
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-amber-600 font-medium">
                    <AlertTriangle className="h-3.5 w-3.5" /> META_VERIFY_TOKEN not set
                  </span>
                )}
              </div>
            </div>
            <SetupGuide steps={status.setupGuide} />
          </>
        )}
      </div>
    </div>
  );
}

function WhatsAppCloudCard({
  status,
}: {
  status: ConnectStatus["whatsappCloud"] | null;
}) {
  return (
    <div className="bg-rbai-surface rounded-xl border border-rbai-border overflow-hidden">
      <div className="px-5 py-4 border-b border-rbai-border">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-green-50 text-green-600">
              <MessageCircle className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-semibold text-rbai-text">WhatsApp Cloud API</h3>
              <p className="text-xs text-rbai-text-light mt-0.5">
                Official Meta business API (no phone needed online)
              </p>
            </div>
          </div>
          <StatusBadge status={status?.configured ? "connected" : "disconnected"} />
        </div>
      </div>

      <div className="p-5 space-y-4">
        {!status ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-6 w-6 animate-spin text-rbai-primary" />
          </div>
        ) : !status.configured ? (
          <>
            <NotConnectedNote what="WhatsApp Cloud API" />
            <SetupGuide steps={status.setupGuide} />
          </>
        ) : (
          <>
            <div className="rounded-lg border border-green-200 bg-green-50 p-3 flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-green-600" />
              <span className="text-sm text-green-700">
                Cloud API credentials found — inbound messages flow to the Inbox.
              </span>
            </div>
            <div className="space-y-3">
              <CopyRow label="Webhook URL (paste in the Meta dashboard)" value={status.webhookUrl} />
              <div className="flex items-center gap-2 text-xs">
                <span className="text-rbai-text-light">Verify token:</span>
                {status.webhookConfigured ? (
                  <span className="inline-flex items-center gap-1 text-rbai-success font-medium">
                    <CheckCircle className="h-3.5 w-3.5" /> Set
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-amber-600 font-medium">
                    <AlertTriangle className="h-3.5 w-3.5" /> WHATSAPP_VERIFY_TOKEN not set — the webhook handshake will fail
                  </span>
                )}
              </div>
            </div>
            <SetupGuide steps={status.setupGuide} />
          </>
        )}
      </div>
    </div>
  );
}

function XCard({
  status,
}: {
  status: ConnectStatus["x"] | null;
}) {
  return (
    <div className="bg-rbai-surface rounded-xl border border-rbai-border overflow-hidden">
      <div className="px-5 py-4 border-b border-rbai-border">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-slate-100 text-slate-700">
              <XBrandIcon className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-semibold text-rbai-text">X</h3>
              <p className="text-xs text-rbai-text-light mt-0.5">
                Posts, replies and DM webhooks
              </p>
            </div>
          </div>
          <StatusBadge status={status?.configured ? "connected" : "disconnected"} />
        </div>
      </div>

      <div className="p-5 space-y-4">
        {!status ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-6 w-6 animate-spin text-rbai-primary" />
          </div>
        ) : !status.configured ? (
          <>
            <NotConnectedNote what="X" />
            <SetupGuide steps={status.setupGuide} />
          </>
        ) : (
          <>
            <div className="space-y-2 text-xs">
              <div className="flex items-center gap-2">
                {status.hasBearer ? (
                  <CheckCircle className="h-4 w-4 text-rbai-success" />
                ) : (
                  <XCircle className="h-4 w-4 text-rbai-danger" />
                )}
                <span className="text-rbai-text">Read access (mentions sync)</span>
              </div>
              <div className="flex items-center gap-2">
                {status.hasUserContext ? (
                  <CheckCircle className="h-4 w-4 text-rbai-success" />
                ) : (
                  <XCircle className="h-4 w-4 text-rbai-danger" />
                )}
                <span className="text-rbai-text">Write access (posts, replies, DMs)</span>
              </div>
            </div>
            {!status.writeConfigured && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
                Read-only: the engagement sync can read mentions, but posting and DMs need the full
                user-context keys (X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET).
              </p>
            )}
            <CopyRow label="DM webhook URL (Account Activity dashboard)" value={status.webhookUrl} />
            <SetupGuide steps={status.setupGuide} />
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function ChannelsPage() {
  const [channels, setChannels] = useState<ChannelData[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [businessName, setBusinessName] = useState<string | null>(null);
  const [connectStatus, setConnectStatus] = useState<ConnectStatus | null>(null);
  const [toast, setToast] = useState<{
    message: string;
    type: "success" | "error";
  } | null>(null);

  const showToast = useCallback(
    (message: string, type: "success" | "error" = "success") => {
      setToast({ message, type });
      setTimeout(() => setToast(null), 3000);
    },
    []
  );

  const fetchChannels = useCallback(async () => {
    try {
      setFetchError(null);
      // Forward the selected business to the list call: a Super Admin
      // session with several businesses has none auto-selected, so a
      // bare /api/channels call fails (BUSINESS_REQUIRED) and the page
      // can never load. Same URLSearchParams pattern as line 1331.
      const business = new URLSearchParams(window.location.search).get("business");
      const url = business
        ? `/api/channels?business=${encodeURIComponent(business)}`
        : "/api/channels";
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      setChannels(data);
    } catch {
      setFetchError("Failed to load channels. Please try refreshing the page.");
      showToast("Failed to load channels", "error");
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    fetchChannels();
  }, [fetchChannels]);

  // Phase 5: social connect status (Meta / WhatsApp Cloud / X).
  useEffect(() => {
    fetch("/api/channels/connect-status")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => data && setConnectStatus(data))
      .catch(() => {});
  }, []);
  useEffect(() => {
    // Re-audit #2 (tenant journey): the install snippet needs the
    // TENANT's own siteKey, but /api/businesses is Super-Admin-only
    // (403 for tenants) — every tenant's snippet shipped with an
    // empty data-site-key and the widget could not be installed.
    // Resolve the caller's own key from the tenant-scoped
    // /api/profile (which carries it); the Super Admin keeps the
    // businesses-list fallback (their profile has no business).
    fetch("/api/profile")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.business?.siteKey) {
          setSiteKey(data.business.siteKey);
          // Tenant identity isolation (2026-10-23): the install
          // snippet below carries the business's own name as the
          // widget's data-title, so a tenant's customers see the
          // TENANT's name in the widget header — never the
          // platform default ("Ride Bangla AI Agent").
          if (data.business.name) setBusinessName(data.business.name);
          return undefined;
        }
        return fetch("/api/businesses")
          .then((r) => (r.ok ? r.json() : null))
          .then((list) => {
            const first = list?.businesses?.[0];
            if (first?.siteKey) setSiteKey(first.siteKey);
            if (first?.name) setBusinessName(first.name);
          });
      })
      .catch(() => {});
  }, []);

  const handleSave = async (
    type: string,
    config: Record<string, unknown>,
    isActive: boolean
  ) => {
    setSaving(true);
    try {
      const res = await fetch(`/api/channels/${type}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config, isActive }),
      });
      if (!res.ok) throw new Error("Failed to save");
      const updated = await res.json();
      setChannels((prev) =>
        prev.map((ch) => (ch.type === type ? updated : ch))
      );
      showToast(`${type.charAt(0).toUpperCase() + type.slice(1)} settings saved`);
    } catch {
      showToast("Failed to save settings", "error");
    } finally {
      setSaving(false);
    }
  };

  const handleAction = async (type: string, action: string) => {
    try {
      const res = await fetch(`/api/channels/${type}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Action failed");
      }
      const data = await res.json();
      if (data.type) {
        setChannels((prev) =>
          prev.map((ch) => (ch.type === type ? { ...ch, ...data } : ch))
        );
        // State-changing actions (connect/disconnect) return the channel
        // row: re-read the list so the badges show the server truth.
        fetchChannels();
      }
      showToast(data.message || "Action completed");
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : "Action failed",
        "error"
      );
    }
  };

  const getChannel = (type: string): ChannelData =>
    channels.find((ch) => ch.type === type) || {
      id: null,
      type,
      isActive: false,
      config: {},
      status: "disconnected",
    };

  return (
    <>
      <Header
        title="Channels"
        description="Connect and manage your communication channels"
      />

      <div className="flex-1 overflow-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-rbai-primary" />
          </div>
        ) : fetchError ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <p className="font-medium text-rbai-text">Could not load channels</p>
            <p className="text-sm text-rbai-text-light mt-1">{fetchError}</p>
            <button
              onClick={() => { setLoading(true); fetchChannels(); }}
              className="mt-3 px-4 py-2 text-sm font-medium text-white bg-rbai-primary rounded-lg hover:bg-rbai-primary/90 transition-colors"
            >
              Retry
            </button>
          </div>
        ) : (
          <>
          <DoneForYouBanner />
          <ChannelOverviewGrid
            meta={connectStatus?.meta || null}
            x={connectStatus?.x || null}
            whatsappCloud={connectStatus?.whatsappCloud || null}
            whatsappLegacy={getChannel("whatsapp")}
          />
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 max-w-7xl">
            <WhatsAppCard
              channel={getChannel("whatsapp")}
              onSave={handleSave}
              onAction={handleAction}
              saving={saving}
            />
            <EmailCard
              channel={getChannel("email")}
              onSave={handleSave}
              onAction={handleAction}
              saving={saving}
              onRefresh={fetchChannels}
            />
            <PhoneCard
              channel={getChannel("phone")}
              onSave={handleSave}
              onAction={handleAction}
              saving={saving}
            />
            <WidgetCard siteKey={siteKey} businessName={businessName} />
            {/* Phase 5: social connect cards */}
            <MetaCard status={connectStatus?.meta || null} onToast={showToast} />
            <WhatsAppCloudCard status={connectStatus?.whatsappCloud || null} />
            <XCard status={connectStatus?.x || null} />
          </div>
          </>
        )}
      </div>

      {/* Toast notification */}
      {toast && (
        <div
          className={cn(
            "fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-3 rounded-lg shadow-lg text-sm font-medium transition-all animate-in slide-in-from-bottom-4 duration-300",
            toast.type === "success"
              ? "bg-rbai-success text-white"
              : "bg-rbai-danger text-white"
          )}
        >
          {toast.type === "success" ? (
            <CheckCircle className="h-4 w-4" />
          ) : (
            <XCircle className="h-4 w-4" />
          )}
          {toast.message}
        </div>
      )}
    </>
  );
}
