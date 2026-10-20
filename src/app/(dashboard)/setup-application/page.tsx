"use client";

/**
 * Done-for-You Setup — the customer fills this AFTER signup, inside the
 * dashboard. Our team contacts them and connects every channel for them:
 * the customer never touches API keys or technical settings.
 */
import { useEffect, useState } from "react";
import { Header } from "@/components/layout/header";
import {
  Loader2,
  CheckCircle,
  Sparkles,
  Clock,
  Wrench,
  PencilLine,
  MessageCircle,
  Globe,
  Phone,
  Mail,
} from "lucide-react";
import {
  FacebookIcon,
  InstagramIcon,
  YoutubeIcon,
  LinkedinIcon,
  XBrandIcon,
} from "@/components/ui/channel-icons";
import { cn } from "@/lib/utils";

interface Application {
  id: string;
  businessName: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  channelsWanted: string[];
  preferredContact: string;
  notes: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

const CHANNEL_OPTIONS = [
  { id: "widget", label: "Website chat widget", icon: Globe },
  { id: "facebook", label: "Facebook", icon: FacebookIcon },
  { id: "messenger", label: "Messenger", icon: MessageCircle },
  { id: "instagram", label: "Instagram", icon: InstagramIcon },
  { id: "whatsapp", label: "WhatsApp", icon: MessageCircle },
  { id: "youtube", label: "YouTube", icon: YoutubeIcon },
  { id: "linkedin", label: "LinkedIn", icon: LinkedinIcon },
  { id: "x", label: "X (Twitter)", icon: XBrandIcon },
  { id: "email", label: "Email", icon: Mail },
  { id: "phone", label: "Phone", icon: Phone },
];

const CONTACT_OPTIONS = [
  { id: "whatsapp", label: "WhatsApp", desc: "হোয়াটসঅ্যাপ / Fastest" },
  { id: "phone", label: "Phone call", desc: "ফোন কল / We'll call you" },
  { id: "email", label: "Email", desc: "ইমেইল / We'll write to you" },
];

const inputClass =
  "w-full rounded-lg border border-rbai-border bg-rbai-bg px-3.5 py-2.5 text-sm text-rbai-text placeholder:text-rbai-text-light focus:outline-none focus:ring-2 focus:ring-rbai-primary focus:border-transparent transition-shadow";

function StatusChip({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    pending: {
      label: "Received — our team will contact you",
      cls: "bg-amber-100 text-amber-800 border-amber-200",
    },
    contacted: {
      label: "Our team is in touch",
      cls: "bg-blue-100 text-blue-800 border-blue-200",
    },
    in_progress: {
      label: "Setup in progress",
      cls: "bg-blue-100 text-blue-800 border-blue-200",
    },
    completed: {
      label: "Setup complete",
      cls: "bg-emerald-100 text-emerald-800 border-emerald-200",
    },
    cancelled: {
      label: "Cancelled",
      cls: "bg-slate-100 text-slate-600 border-slate-200",
    },
  };
  const s = map[status] || map.pending;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border",
        s.cls
      )}
    >
      {status === "completed" ? (
        <CheckCircle className="h-3.5 w-3.5" />
      ) : (
        <Clock className="h-3.5 w-3.5" />
      )}
      {s.label}
    </span>
  );
}

export default function SetupApplicationPage() {
  const [loading, setLoading] = useState(true);
  const [app, setApp] = useState<Application | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const [businessName, setBusinessName] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [channelsWanted, setChannelsWanted] = useState<string[]>([]);
  const [preferredContact, setPreferredContact] = useState("whatsapp");
  const [notes, setNotes] = useState("");

  function fillFrom(a: Application) {
    setBusinessName(a.businessName || "");
    setContactName(a.contactName || "");
    setContactPhone(a.contactPhone || "");
    setContactEmail(a.contactEmail || "");
    setChannelsWanted(a.channelsWanted || []);
    setPreferredContact(a.preferredContact || "whatsapp");
    setNotes(a.notes || "");
  }

  useEffect(() => {
    fetch("/api/setup-application")
      .then((r) => r.json())
      .then((data) => {
        if (data.application) {
          setApp(data.application);
          fillFrom(data.application);
        } else {
          setEditing(true);
        }
      })
      .catch(() => setError("Couldn't load your setup request. Please refresh."))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleChannel(id: string) {
    setChannelsWanted((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaved(false);
    setSaving(true);
    try {
      const res = await fetch("/api/setup-application", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessName,
          contactName,
          contactPhone,
          contactEmail,
          channelsWanted,
          preferredContact,
          notes,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Couldn't save. Please try again.");
        setSaving(false);
        return;
      }
      setApp(data.application);
      setEditing(false);
      setSaved(true);
    } catch {
      setError("Network error. Check your connection and try again.");
    }
    setSaving(false);
  }

  const field = (
    label: string,
    bn: string,
    children: React.ReactNode
  ) => (
    <div>
      <label className="block text-sm font-medium text-rbai-text mb-1.5">
        {label} <span className="font-normal text-rbai-text-light">/ {bn}</span>
      </label>
      {children}
    </div>
  );

  return (
    <>
      <Header
        title="Done-for-You Setup"
        description="Tell us about your business — our team sets everything up for you"
      />
      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-3xl mx-auto">
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-8 w-8 animate-spin text-rbai-primary" />
            </div>
          ) : app && !editing ? (
            <div className="space-y-6">
              {/* Status card */}
              <div className="bg-rbai-surface border border-rbai-border rounded-2xl p-6">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <span className="p-3 rounded-xl bg-rbai-primary-50 text-rbai-primary">
                      <Wrench className="h-6 w-6" />
                    </span>
                    <div>
                      <h2 className="font-bold text-rbai-text text-lg">
                        Your setup request
                      </h2>
                      <p className="text-sm text-rbai-text-light mt-0.5">
                        আমাদের টিম আপনার সাথে যোগাযোগ করে সব সেটআপ করে দেবে —{" "}
                        আপনাকে কিছুই করতে হবে না।
                      </p>
                    </div>
                  </div>
                  <StatusChip status={app.status} />
                </div>

                <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-xs font-medium text-rbai-text-light mb-1">
                      Business / ব্যবসা
                    </p>
                    <p className="text-rbai-text font-medium">
                      {app.businessName}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-rbai-text-light mb-1">
                      Contact / যোগাযোগ
                    </p>
                    <p className="text-rbai-text font-medium">
                      {app.contactName}
                      {app.contactPhone && ` · ${app.contactPhone}`}
                      {app.contactEmail && ` · ${app.contactEmail}`}
                    </p>
                  </div>
                  <div className="sm:col-span-2">
                    <p className="text-xs font-medium text-rbai-text-light mb-1">
                      Channels to connect / যেসব চ্যানেল যুক্ত করতে হবে
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {app.channelsWanted.length === 0 ? (
                        <span className="text-rbai-text-light">
                          All recommended channels — our team will decide with you.
                        </span>
                      ) : (
                        app.channelsWanted.map((c) => (
                          <span
                            key={c}
                            className="px-2.5 py-1 rounded-full bg-rbai-primary-50 text-rbai-primary text-xs font-medium"
                          >
                            {CHANNEL_OPTIONS.find((o) => o.id === c)?.label || c}
                          </span>
                        ))
                      )}
                    </div>
                  </div>
                  {app.notes && (
                    <div className="sm:col-span-2">
                      <p className="text-xs font-medium text-rbai-text-light mb-1">
                        Notes / নোট
                      </p>
                      <p className="text-rbai-text">{app.notes}</p>
                    </div>
                  )}
                </div>

                <div className="mt-6 rounded-xl bg-rbai-bg border border-rbai-border p-4">
                  <p className="text-sm text-rbai-text font-medium">
                    {app.status === "completed"
                      ? "Your setup is complete! Check your Channels page to review everything."
                      : app.status === "pending"
                        ? "আপনার আবেদন আমাদের কাছে পৌঁছেছে। আমাদের টিম শীঘ্রই আপনার পছন্দের মাধ্যমে যোগাযোগ করবে — তারপর Facebook, WhatsApp, Instagram সহ সবকিছু আমাদের টিম নিজে সেটআপ করে দেবে। / We've received your request. Our team will reach out on your preferred channel soon and set up Facebook, WhatsApp, Instagram and everything else for you."
                        : "Our team is working on your setup and will reach out on your preferred channel."}
                  </p>
                </div>

                {app.status === "pending" && (
                  <button
                    onClick={() => {
                      if (app) fillFrom(app);
                      setEditing(true);
                      setSaved(false);
                    }}
                    className="mt-4 flex items-center gap-1.5 text-sm font-medium text-rbai-primary hover:underline"
                  >
                    <PencilLine className="h-4 w-4" /> Edit my request
                  </button>
                )}
              </div>

              {saved && (
                <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-4 text-sm text-emerald-800">
                  Your request was saved — our team will contact you to set
                  everything up.
                </div>
              )}
            </div>
          ) : (
            <div className="bg-rbai-surface border border-rbai-border rounded-2xl p-6 sm:p-8">
              <div className="flex items-center gap-3 mb-2">
                <span className="p-3 rounded-xl bg-rbai-primary-50 text-rbai-primary">
                  <Sparkles className="h-6 w-6" />
                </span>
                <div>
                  <h2 className="font-bold text-rbai-text text-xl">
                    We set everything up for you
                  </h2>
                  <p className="text-sm text-rbai-text-light mt-0.5">
                    আপনার তথ্য দিন — বাকিটা আমাদের টিম করবে। কোনো API key বা
                    টেকনিক্যাল সেটিংস আপনার লাগবে না।
                  </p>
                </div>
              </div>

              <form onSubmit={handleSubmit} className="mt-6 space-y-5">
                {field(
                  "Business name",
                  "ব্যবসার নাম",
                  <input
                    value={businessName}
                    onChange={(e) => setBusinessName(e.target.value)}
                    required
                    minLength={2}
                    maxLength={100}
                    placeholder="e.g. Dhaka Cake House"
                    className={inputClass}
                  />
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                  {field(
                    "Your name",
                    "আপনার নাম",
                    <input
                      value={contactName}
                      onChange={(e) => setContactName(e.target.value)}
                      required
                      minLength={2}
                      maxLength={100}
                      placeholder="e.g. Rahim Uddin"
                      className={inputClass}
                    />
                  )}
                  {field(
                    "Phone / WhatsApp",
                    "ফোন / হোয়াটসঅ্যাপ",
                    <input
                      value={contactPhone}
                      onChange={(e) => setContactPhone(e.target.value)}
                      inputMode="tel"
                      placeholder="01XXXXXXXXX"
                      className={inputClass}
                    />
                  )}
                </div>

                {field(
                  "Email",
                  "ইমেইল",
                  <input
                    value={contactEmail}
                    onChange={(e) => setContactEmail(e.target.value)}
                    type="email"
                    placeholder="you@yourbusiness.com"
                    className={inputClass}
                  />
                )}

                <div>
                  <p className="block text-sm font-medium text-rbai-text mb-2">
                    Which channels should we connect?{" "}
                    <span className="font-normal text-rbai-text-light">
                      / কোন কোন চ্যানেল যুক্ত করবো?
                    </span>
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {CHANNEL_OPTIONS.map((c) => {
                      const active = channelsWanted.includes(c.id);
                      return (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => toggleChannel(c.id)}
                          className={cn(
                            "flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl border text-sm font-medium text-left transition-colors",
                            active
                              ? "border-rbai-primary bg-rbai-primary-50 text-rbai-primary"
                              : "border-rbai-border bg-rbai-bg text-rbai-text hover:border-rbai-primary"
                          )}
                        >
                          <c.icon className="h-4 w-4 shrink-0" />
                          {c.label}
                          {active && <CheckCircle className="h-4 w-4 ml-auto shrink-0" />}
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-xs text-rbai-text-light mt-2">
                    কিছু না বাছলেও সমস্যা নেই — আমাদের টিম আপনার সাথে কথা বলে
                    সব ঠিক করে দেবে। / Leave it empty if you're unsure — our
                    team will figure it out with you.
                  </p>
                </div>

                <div>
                  <p className="block text-sm font-medium text-rbai-text mb-2">
                    How should our team contact you?{" "}
                    <span className="font-normal text-rbai-text-light">
                      / আমরা কীভাবে যোগাযোগ করবো?
                    </span>
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    {CONTACT_OPTIONS.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setPreferredContact(c.id)}
                        className={cn(
                          "px-3.5 py-2.5 rounded-xl border text-sm text-left transition-colors",
                          preferredContact === c.id
                            ? "border-rbai-primary bg-rbai-primary-50"
                            : "border-rbai-border bg-rbai-bg hover:border-rbai-primary"
                        )}
                      >
                        <span
                          className={cn(
                            "block font-medium",
                            preferredContact === c.id
                              ? "text-rbai-primary"
                              : "text-rbai-text"
                          )}
                        >
                          {c.label}
                        </span>
                        <span className="block text-xs text-rbai-text-light mt-0.5">
                          {c.desc}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                {field(
                  "Anything else?",
                  "আর কিছু জানাতে চান?",
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={3}
                    maxLength={1000}
                    placeholder="Optional — anything we should know about your business."
                    className={cn(inputClass, "resize-y")}
                  />
                )}

                {error && (
                  <div className="rounded-lg bg-red-50 border border-red-200 px-3.5 py-2.5 text-sm text-red-700">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={saving}
                  className="w-full rounded-lg bg-rbai-primary text-white font-medium py-3 text-sm hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                >
                  {saving ? (
                    <span className="flex items-center justify-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Sending your request…
                    </span>
                  ) : (
                    <span className="flex items-center justify-center gap-2">
                      <Sparkles className="h-4 w-4" />
                      Send my setup request — our team handles the rest
                    </span>
                  )}
                </button>
              </form>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
