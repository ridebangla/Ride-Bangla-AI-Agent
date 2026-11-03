"use client";

import { useRef, useState } from "react";

type Attachment = {
  name: string;
  mimeType: string;
  size: number;
  dataBase64: string;
  kind: "image" | "video";
};

const DEFAULT_ENDPOINT = "https://ai.ridebangla.bd/api/public/tickets";
const MAX_FILES = 3;
const MAX_DIM = 1280;
const JPEG_QUALITY = 0.75;
const MAX_B64_BYTES = 700 * 1024;
const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"];
const VIDEO_MIMES = ["video/mp4", "video/webm"];
const TOPICS = ["general", "payment", "technical", "feedback"] as const;
const TOPIC_LABELS: Record<string, string> = {
  general: "General / সাধারণ",
  payment: "Payment / পেমেন্ট",
  technical: "Technical / কারিগরি",
  feedback: "Feedback / মতামত",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[0-9][0-9\s\-()]{5,19}$/;
const REFCODE_RE = /^RB-[A-Za-z0-9]{4,16}$/;

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
  if (dataBase64.length > MAX_B64_BYTES) throw new Error("video-too-large");
  return { name: file.name, mimeType: file.type, size: file.size, dataBase64, kind: "video" };
}

export default function TicketForm({
  siteKey,
  endpoint = DEFAULT_ENDPOINT,
}: {
  siteKey: string;
  endpoint?: string;
}) {
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [topic, setTopic] = useState<string>("general");
  const [refCode, setRefCode] = useState("");
  const [message, setMessage] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [fileError, setFileError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [doneRef, setDoneRef] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const inputClass =
    "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 bg-white";

  async function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    setFileError("");
    if (files.length > MAX_FILES) {
      setFileError("You can attach at most 3 files. / সর্বোচ্চ ৩টি ফাইল দেওয়া যাবে।");
      return;
    }
    try {
      const out: Attachment[] = [];
      for (const f of files) {
        if (IMAGE_MIMES.includes(f.type)) out.push(await compressImage(f));
        else if (VIDEO_MIMES.includes(f.type)) out.push(await passVideo(f));
        else throw new Error("bad-type");
      }
      setAttachments(out);
    } catch (err) {
      setFileError(
        err instanceof Error && err.message === "video-too-large"
          ? "Video is too large (max 700KB). / ভিডিওটি অনেক বড় (সর্বোচ্চ ৭০০KB)।"
          : "A file could not be processed. Please try another one. / একটি ফাইল প্রসেস করা যায়নি। অন্য একটি দিয়ে চেষ্টা করুন।"
      );
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setDoneRef("");
    const n = name.trim();
    const c = contact.trim();
    const m = message.trim();
    const rc = refCode.trim().toUpperCase();
    if (n.length < 2 || n.length > 100) {
      setError("Please enter your name (2–100 characters). / নাম লিখুন (২–১০০ অক্ষর)।");
      return;
    }
    if (!EMAIL_RE.test(c) && !PHONE_RE.test(c)) {
      setError("Please enter a valid email address or phone number. / সঠিক ইমেইল বা ফোন নম্বর দিন।");
      return;
    }
    if (!TOPICS.includes(topic as (typeof TOPICS)[number])) {
      setError("Please choose a topic. / একটি বিষয় বেছে নিন।");
      return;
    }
    if (m.length < 10 || m.length > 5000) {
      setError("Please write a message between 10 and 5000 characters. / ১০–৫০০০ অক্ষরের মধ্যে বার্তা লিখুন।");
      return;
    }
    if (topic === "payment" && rc && !REFCODE_RE.test(rc)) {
      setError("Payment reference must look like RB-XXXXXXXX. / পেমেন্ট রেফারেন্স RB-XXXXXXXX এর মতো হতে হবে।");
      return;
    }
    // The endpoint has no claim lookup: a payment reference travels
    // inside the message text so no information is lost.
    const finalMessage =
      topic === "payment" && rc ? `${m}\n\nPayment reference: ${rc}` : m;
    setBusy(true);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          siteKey,
          name: n,
          contact: c,
          topic,
          message: finalMessage,
          pageUrl: window.location.href,
          attachments: attachments.map((a) => ({
            name: a.name,
            mimeType: a.mimeType,
            size: a.size,
            dataBase64: a.dataBase64,
          })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data && data.ok && typeof data.reference === "string") {
        setDoneRef(data.reference);
        setName("");
        setContact("");
        setTopic("general");
        setRefCode("");
        setMessage("");
        setAttachments([]);
        // State alone does not clear the file picker: reset the input
        // element itself, or it still shows the sent files.
        if (fileRef.current) fileRef.current.value = "";
      } else if (res.status === 429) {
        setError("Too many requests. Please try again in a little while. / অনেকবার চেষ্টা করা হয়েছে। কিছুক্ষণ পর আবার চেষ্টা করুন।");
      } else if (res.status === 401 || res.status === 403) {
        setError("This form is not configured correctly yet. Please contact the business directly. / এই ফর্মটি এখনো ঠিকমতো সেটআপ হয়নি। সরাসরি ব্যবসার সঙ্গে যোগাযোগ করুন।");
      } else if (res.status === 400) {
        setError("Please check the form — something looks invalid. / ফর্মটি আবার দেখুন — কিছু তথ্য ঠিক নেই।");
      } else {
        setError("Something went wrong on the server. Please try again later. / সার্ভারে সমস্যা হয়েছে। পরে আবার চেষ্টা করুন।");
      }
    } catch {
      setError("Could not reach the server. Check your connection and try again later. / সার্ভারের সাথে সংযোগ করা যায়নি। পরে আবার চেষ্টা করুন।");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="ticket-form-title">
      <h2 id="ticket-form-title" className="text-lg font-semibold text-slate-900">
        Open a support ticket / সাপোর্ট টিকিট খুলুন
      </h2>
      <form onSubmit={handleSubmit} className="space-y-5 mt-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <div>
            <label htmlFor="tkf-name" className="block text-sm font-medium text-slate-700 mb-1.5">
              Your name / আপনার নাম <span className="text-red-500">*</span>
            </label>
            <input id="tkf-name" type="text" required minLength={2} maxLength={100}
              value={name} onChange={(e) => setName(e.target.value)}
              className={inputClass} placeholder="Your name" />
          </div>
          <div>
            <label htmlFor="tkf-contact" className="block text-sm font-medium text-slate-700 mb-1.5">
              Email or phone / ইমেইল বা ফোন <span className="text-red-500">*</span>
            </label>
            <input id="tkf-contact" type="text" required
              value={contact} onChange={(e) => setContact(e.target.value)}
              className={inputClass} placeholder="you@example.com / 01XXXXXXXXX" />
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <div>
            <label htmlFor="tkf-topic" className="block text-sm font-medium text-slate-700 mb-1.5">
              Topic / বিষয় <span className="text-red-500">*</span>
            </label>
            <select id="tkf-topic" value={topic} onChange={(e) => setTopic(e.target.value)} className={inputClass}>
              {TOPICS.map((t) => (
                <option key={t} value={t}>{TOPIC_LABELS[t]}</option>
              ))}
            </select>
          </div>
          {topic === "payment" && (
            <div>
              <label htmlFor="tkf-ref" className="block text-sm font-medium text-slate-700 mb-1.5">
                Payment reference (optional) / পেমেন্ট রেফারেন্স (ঐচ্ছিক)
              </label>
              <input id="tkf-ref" type="text" value={refCode}
                onChange={(e) => setRefCode(e.target.value.toUpperCase())}
                className={`${inputClass} uppercase`} placeholder="RB-XXXXXXXX" maxLength={20} />
            </div>
          )}
        </div>
        <div>
          <label htmlFor="tkf-message" className="block text-sm font-medium text-slate-700 mb-1.5">
            Describe your issue / আপনার সমস্যাটি লিখুন <span className="text-red-500">*</span>
          </label>
          <textarea id="tkf-message" required minLength={10} maxLength={5000} rows={6}
            value={message} onChange={(e) => setMessage(e.target.value)}
            className={inputClass} placeholder="Describe your question or issue…" />
        </div>
        <div>
          <label htmlFor="tkf-files" className="block text-sm font-medium text-slate-700 mb-1.5">
            Photos / videos (optional, max 3) / ছবি / ভিডিও (ঐচ্ছিক, সর্বোচ্চ ৩টি)
          </label>
          <input id="tkf-files" ref={fileRef} type="file" multiple
            accept="image/jpeg,image/png,image/webp,video/mp4,video/webm"
            onChange={handleFiles} className="text-sm text-slate-700" />
          {fileError && <p className="text-sm text-red-600 mt-1.5">{fileError}</p>}
          {attachments.length > 0 && (
            <p className="text-xs text-slate-500 mt-1.5">
              {attachments.length} file(s) attached / {attachments.length}টি ফাইল যুক্ত হয়েছে
            </p>
          )}
        </div>
        {error && <p className="text-sm text-red-600" role="status">{error}</p>}
        {doneRef && (
          <p className="text-sm text-green-700" role="status">
            Thank you! Your ticket has been created. Recording number:{" "}
            <span className="font-mono font-semibold">{doneRef}</span>
            {" "}/ ধন্যবাদ! আপনার টিকিট তৈরি হয়েছে। রেকর্ডিং নম্বর:{" "}
            <span className="font-mono font-semibold">{doneRef}</span>
          </p>
        )}
        <button type="submit" disabled={busy}
          className="px-5 py-2.5 rounded-lg bg-slate-900 text-white text-sm font-semibold disabled:opacity-50">
          {busy ? "Sending… / পাঠানো হচ্ছে…" : "Send ticket / টিকিট পাঠান"}
        </button>
      </form>
    </section>
  );
}
