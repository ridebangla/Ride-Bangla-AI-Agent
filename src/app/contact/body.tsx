"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Mail,
  Phone,
  PhoneCall,
  Send,
  Loader2,
  CheckCircle2,
  Paperclip,
  X,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Client-side attachment rules (mirror of the API contract):
// - Images: canvas-compressed to max 1280px, JPEG q0.75, before base64.
// - Video: passed through ONLY when the base64 fits in 700KB (~500KB file);
//   otherwise an honest error (no silent downscale).
// - At most 3 files total.
// NOTE: base64-in-Firestore is TEMPORARY — migrate attachments to Firebase
// Storage (download URLs) once Blaze billing is enabled.
// ---------------------------------------------------------------------------

const MAX_DIM = 1280;
const JPEG_QUALITY = 0.75;
const MAX_B64_BYTES = 700 * 1024;
const ALLOWED = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/webm",
]);

interface Attachment {
  name: string;
  mimeType: string;
  size: number;
  dataBase64: string;
  kind: "image" | "video";
}

function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("read-failed"));
    reader.readAsDataURL(file);
  });
}

async function compressImage(file: File): Promise<Attachment> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas-unavailable");
  ctx.drawImage(bitmap, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((res) =>
    canvas.toBlob(res, "image/jpeg", JPEG_QUALITY)
  );
  if (!blob) throw new Error("compress-failed");
  const dataUrl = await fileToBase64(blob);
  const dataBase64 = dataUrl.includes(",")
    ? dataUrl.slice(dataUrl.indexOf(",") + 1)
    : dataUrl;
  return { name: file.name, mimeType: "image/jpeg", size: blob.size, dataBase64, kind: "image" };
}

async function passVideo(file: File): Promise<Attachment> {
  const dataUrl = await fileToBase64(file);
  const dataBase64 = dataUrl.includes(",")
    ? dataUrl.slice(dataUrl.indexOf(",") + 1)
    : dataUrl;
  if (dataBase64.length > MAX_B64_BYTES) {
    throw new Error("video-too-large");
  }
  return { name: file.name, mimeType: file.type, size: file.size, dataBase64, kind: "video" };
}

const TOPICS = [
  { id: "general", bn: "সাধারণ জিজ্ঞাসা", en: "General" },
  { id: "payment", bn: "পেমেন্ট সমস্যা", en: "Payment issue" },
  { id: "technical", bn: "কারিগরি সমস্যা", en: "Technical issue" },
  { id: "feedback", bn: "মতামত", en: "Feedback" },
] as const;

export default function ContactBody() {
  const [contacts, setContacts] = useState<{ email: string; phone: string; hotline: string } | null>(null);
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [topic, setTopic] = useState<string>("general");
  const [refCode, setRefCode] = useState("");
  const [message, setMessage] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [fileError, setFileError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/contact");
        if (res.ok) setContacts(await res.json());
      } catch {
        // Contact info is a bonus — the form works without it.
      }
    })();
  }, []);

  async function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    setFileError("");
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    if (attachments.length + files.length > 3) {
      setFileError("সর্বোচ্চ ৩টি ফাইল যুক্ত করা যাবে / You can attach at most 3 files.");
      return;
    }
    for (const f of files) {
      if (!ALLOWED.has(f.type)) {
        setFileError(`"${f.name}" — এই ধরনের ফাইল সমর্থিত নয় / Unsupported file type.`);
        continue;
      }
      try {
        const att = f.type.startsWith("image/")
          ? await compressImage(f)
          : await passVideo(f);
        if (att.dataBase64.length > MAX_B64_BYTES) {
          setFileError(`"${f.name}" — ফাইলটি বড় হয়ে গেছে / File too large.`);
          continue;
        }
        setAttachments((prev) => [...prev, att]);
      } catch (err) {
        if (err instanceof Error && err.message === "video-too-large") {
          setFileError("ভিডিওটি বড় — ছোট ক্লিপ পাঠান / The video is too large — please send a shorter clip.");
        } else {
          setFileError(`"${f.name}" — ফাইলটি প্রসেস করা যায়নি / Could not process this file.`);
        }
      }
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          contact,
          topic,
          message,
          refCode: topic === "payment" ? refCode : undefined,
          pageUrl: window.location.href,
          attachments,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message || data.error || "পাঠানো যায়নি। আবার চেষ্টা করুন। / Couldn't send. Please try again.");
        setBusy(false);
        return;
      }
      setDone(true);
    } catch {
      setError("নেটওয়ার্ক সমস্যা। সংযোগ চেক করে আবার চেষ্টা করুন। / Network error. Check your connection and try again.");
      setBusy(false);
    }
  }

  const inputClass =
    "w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#4A7C9B] focus:border-transparent transition-shadow";

  return (
    <>
      {/* Contact info cards (from /api/contact — rendered only when set) */}
      {contacts && (contacts.email || contacts.phone || contacts.hotline) && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-10">
            {contacts.email && (
              <a
                href={`mailto:${contacts.email}`}
                className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 hover:border-[#4A7C9B] hover:shadow-sm transition-all"
              >
                <span className="inline-flex p-2.5 rounded-xl bg-[#EDF5FA] text-[#4A7C9B]">
                  <Mail className="h-5 w-5" />
                </span>
                <span>
                  <span className="block text-xs text-slate-500">ইমেইল / Email</span>
                  <span className="block text-sm font-medium break-all">{contacts.email}</span>
                </span>
              </a>
            )}
            {contacts.phone && (
              <a
                href={`tel:${contacts.phone.replace(/\s/g, "")}`}
                className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 hover:border-[#4A7C9B] hover:shadow-sm transition-all"
              >
                <span className="inline-flex p-2.5 rounded-xl bg-[#EDF5FA] text-[#4A7C9B]">
                  <Phone className="h-5 w-5" />
                </span>
                <span>
                  <span className="block text-xs text-slate-500">ফোন / Phone</span>
                  <span className="block text-sm font-medium">{contacts.phone}</span>
                </span>
              </a>
            )}
            {contacts.hotline && (
              <a
                href={`tel:${contacts.hotline.replace(/\s/g, "")}`}
                className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 hover:border-[#4A7C9B] hover:shadow-sm transition-all"
              >
                <span className="inline-flex p-2.5 rounded-xl bg-[#EDF5FA] text-[#4A7C9B]">
                  <PhoneCall className="h-5 w-5" />
                </span>
                <span>
                  <span className="block text-xs text-slate-500">হটলাইন / Hotline</span>
                  <span className="block text-sm font-medium">{contacts.hotline}</span>
                </span>
              </a>
            )}
          </div>
        )}

        {/* Form card */}
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-6 sm:p-8">
          {done ? (
            <div className="text-center py-10">
              <CheckCircle2 className="h-14 w-14 text-emerald-500 mx-auto" />
              <h2 className="text-xl font-bold mt-4">
                বার্তা পাঠানো হয়েছে / Message sent
              </h2>
              <p className="text-sm text-slate-500 mt-2 max-w-md mx-auto">
                ধন্যবাদ! আমাদের সাপোর্ট টিম শীঘ্রই আপনার সাথে যোগাযোগ করবে। /
                Thank you — our support team will get back to you soon.
              </p>
              <Link
                href="/"
                className="inline-block mt-6 text-sm font-medium text-[#4A7C9B] hover:underline"
              >
                ← Back to home / হোমে ফিরুন
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <div>
                  <label htmlFor="name" className="block text-sm font-medium text-slate-700 mb-1.5">
                    নাম / Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    id="name"
                    type="text"
                    required
                    minLength={2}
                    maxLength={100}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className={inputClass}
                    placeholder="আপনার নাম / Your name"
                  />
                </div>
                <div>
                  <label htmlFor="contact" className="block text-sm font-medium text-slate-700 mb-1.5">
                    ইমেইল বা ফোন / Email or phone <span className="text-red-500">*</span>
                  </label>
                  <input
                    id="contact"
                    type="text"
                    required
                    value={contact}
                    onChange={(e) => setContact(e.target.value)}
                    className={inputClass}
                    placeholder="you@example.com / 01XXXXXXXXX"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <div>
                  <label htmlFor="topic" className="block text-sm font-medium text-slate-700 mb-1.5">
                    বিষয় / Topic <span className="text-red-500">*</span>
                  </label>
                  <select
                    id="topic"
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    className={inputClass}
                  >
                    {TOPICS.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.bn} / {t.en}
                      </option>
                    ))}
                  </select>
                </div>
                {topic === "payment" && (
                  <div>
                    <label htmlFor="refCode" className="block text-sm font-medium text-slate-700 mb-1.5">
                      পেমেন্ট রেফারেন্স / Reference
                    </label>
                    <input
                      id="refCode"
                      type="text"
                      value={refCode}
                      onChange={(e) => setRefCode(e.target.value.toUpperCase())}
                      className={`${inputClass} uppercase`}
                      placeholder="RB-XXXXXXXX"
                      maxLength={20}
                    />
                    <p className="text-xs text-slate-500 mt-1.5">
                      পেমেন্টের সময় পাওয়া রেফারেন্স কোডটি দিন / Enter the reference code from your payment.
                    </p>
                  </div>
                )}
              </div>

              <div>
                <label htmlFor="message" className="block text-sm font-medium text-slate-700 mb-1.5">
                  বার্তা / Message <span className="text-red-500">*</span>
                </label>
                <textarea
                  id="message"
                  required
                  minLength={10}
                  maxLength={5000}
                  rows={6}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  className={`${inputClass} resize-y`}
                  placeholder="আপনার বার্তা বিস্তারিত লিখুন (কমপক্ষে ১০ অক্ষর) / Describe your message in detail (at least 10 characters)"
                />
              </div>

              <div>
                <span className="block text-sm font-medium text-slate-700 mb-1.5">
                  ছবি/ভিডিও যুক্ত করুন / Attach photos or video{" "}
                  <span className="font-normal text-slate-400">(সর্বোচ্চ ৩টি / max 3)</span>
                </span>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,video/mp4,video/webm"
                  multiple
                  onChange={handleFiles}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="flex items-center gap-2 rounded-lg border border-dashed border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-600 hover:border-[#4A7C9B] hover:text-[#4A7C9B] transition-colors"
                >
                  <Paperclip className="h-4 w-4" />
                  ফাইল বেছে নিন / Choose files
                </button>
                {fileError && (
                  <p className="text-xs text-red-600 mt-2">{fileError}</p>
                )}
                {attachments.length > 0 && (
                  <ul className="mt-3 space-y-2">
                    {attachments.map((a, i) => (
                      <li
                        key={i}
                        className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm"
                      >
                        <span className="flex-1 truncate text-slate-700">{a.name}</span>
                        <span className="text-xs text-slate-400">
                          {(a.size / 1024).toFixed(0)} KB
                        </span>
                        <button
                          type="button"
                          onClick={() => setAttachments(attachments.filter((_, j) => j !== i))}
                          className="p-1 text-slate-400 hover:text-red-600"
                          aria-label="Remove file"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-slate-400 mt-2">
                  ছবি স্বয়ংক্রিয়ভাবে ছোট করা হয় (JPEG, ১২৮০px) / Images are compressed automatically (JPEG, 1280px).
                </p>
              </div>

              {error && (
                <div className="rounded-lg bg-red-50 border border-red-200 px-3.5 py-2.5 text-sm text-red-700">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-lg bg-[#4A7C9B] text-white font-medium py-3 text-sm hover:bg-[#2D5A7B] disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
              >
                {busy ? (
                  <span className="flex items-center justify-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    পাঠানো হচ্ছে… / Sending…
                  </span>
                ) : (
                  <span className="flex items-center justify-center gap-2">
                    <Send className="h-4 w-4" />
                    বার্তা পাঠান / Send message
                  </span>
                )}
              </button>
            </form>
          )}
        </div>
    </>
  );
}
