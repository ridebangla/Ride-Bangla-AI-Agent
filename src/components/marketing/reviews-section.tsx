"use client";

/**
 * ReviewsSection — public reviews for the AI site, rendered on the marketing
 * landing page. Data comes from the shared public Reviews API
 * (GET /api/public/reviews?site=ai&siteKey=…) — published reviews only, no
 * seeded/fake data. The write-review form is shown only to customers who are
 * signed in with Firebase on this device (their existing session); they post
 * with their ID token. BN+EN copy (this repo's bilingual convention).
 */
import { useCallback, useEffect, useState } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { Star } from "lucide-react";
import { getFirebaseAuth } from "@/lib/firebase-client";

interface PublicReview {
  name: string;
  rating: number;
  text: string;
  createdAt: string;
}

function Stars({ value, size = 16 }: { value: number; size?: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${value} / 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          style={{ width: size, height: size }}
          className={
            value >= i - 0.25
              ? "fill-amber-400 text-amber-400"
              : "fill-slate-200 text-slate-200"
          }
        />
      ))}
    </span>
  );
}

export default function ReviewsSection({ siteKey }: { siteKey: string | null }) {
  const [average, setAverage] = useState(0);
  const [count, setCount] = useState(0);
  const [reviews, setReviews] = useState<PublicReview[]>([]);
  const [loaded, setLoaded] = useState(false);

  const [user, setUser] = useState<User | null>(null);
  const [name, setName] = useState("");
  const [rating, setRating] = useState(5);
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);
  const [formError, setFormError] = useState("");
  const [formOk, setFormOk] = useState("");

  const load = useCallback(async () => {
    if (!siteKey) {
      setLoaded(true);
      return;
    }
    try {
      const res = await fetch(
        `/api/public/reviews?site=ai&siteKey=${encodeURIComponent(siteKey)}`
      );
      const data = await res.json();
      if (data?.ok) {
        setAverage(data.average || 0);
        setCount(data.count || 0);
        setReviews(Array.isArray(data.reviews) ? data.reviews : []);
      }
    } catch {
      // Honest empty state stays if reviews can't be fetched.
    } finally {
      setLoaded(true);
    }
  }, [siteKey]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    let unsub = () => {};
    try {
      unsub = onAuthStateChanged(getFirebaseAuth(), (u) => {
        setUser(u);
        if (u) {
          setName(
            (prev) =>
              prev ||
              u.displayName ||
              (u.email ? u.email.split("@")[0] : "") ||
              ""
          );
        }
      });
    } catch {
      setUser(null);
    }
    return () => unsub();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!user || !siteKey) return;
    setFormError("");
    setFormOk("");
    if (!name.trim()) {
      setFormError("আপনার নাম লিখুন / Please write your name.");
      return;
    }
    if (!text.trim()) {
      setFormError("আপনার রিভিউ লিখুন / Please write your review.");
      return;
    }
    setPosting(true);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/public/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          siteKey,
          site: "ai",
          idToken,
          rating,
          text: text.trim(),
          name: name.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        setFormError(
          data?.error ||
            "রিভিউ পাঠানো যায়নি — আবার চেষ্টা করুন / Could not post your review. Please try again."
        );
        return;
      }
      setText("");
      setFormOk(
        "ধন্যবাদ! আপনার রিভিউ প্রকাশ হয়েছে / Thank you! Your review is now live."
      );
      await load();
    } catch {
      setFormError(
        "রিভিউ পাঠানো যায়নি — ইন্টারনেট সংযোগ যাচাই করে আবার চেষ্টা করুন / Could not post your review. Check your connection and try again."
      );
    } finally {
      setPosting(false);
    }
  }

  if (!siteKey) return null;

  return (
    <section id="reviews" className="border-b border-slate-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-20">
        <h2 className="text-3xl font-bold text-center">
          Customers love it / গ্রাহকদের ভালোবাসা
        </h2>
        <p className="text-slate-700 text-center mt-3 max-w-2xl mx-auto">
          Real reviews from businesses using Ride Bangla AI Agent. /
          রাইড বাংলা এআই এজেন্ট ব্যবহার করা ব্যবসাগুলোর আসল রিভিউ।
        </p>

        <div className="flex items-center justify-center gap-3 mt-8">
          <Stars value={average} size={26} />
          <span className="text-2xl font-bold">{average.toFixed(1)}</span>
          <span className="text-slate-700 text-sm">
            {count} review{count === 1 ? "" : "s"} / {count} টি রিভিউ
          </span>
        </div>

        {loaded && reviews.length === 0 && (
          <p className="text-center text-slate-700 mt-10">
            No reviews yet — be the first. / এখনো কোনো রিভিউ নেই — প্রথম
            রিভিউটা আপনিই লিখুন।
          </p>
        )}

        {reviews.length > 0 && (
          <div className="mt-10 flex gap-5 overflow-x-auto pb-4 snap-x">
            {reviews.map((r, i) => (
              <article
                key={`${r.createdAt}-${i}`}
                className="snap-start shrink-0 w-[320px] max-w-[85vw] bg-white border border-slate-200 rounded-2xl p-6"
              >
                <div className="flex items-center gap-3">
                  <span className="h-10 w-10 rounded-full bg-[#4A7C9B] text-white flex items-center justify-center font-semibold">
                    {(r.name || "?").charAt(0).toUpperCase()}
                  </span>
                  <div>
                    <p className="font-semibold text-sm">{r.name}</p>
                    <Stars value={r.rating} size={13} />
                  </div>
                </div>
                <p className="text-sm text-slate-600 mt-3 leading-relaxed whitespace-pre-line">
                  {r.text}
                </p>
                <p className="text-xs text-slate-600 mt-3">
                  {new Date(r.createdAt).toLocaleDateString("en-GB", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                </p>
              </article>
            ))}
          </div>
        )}

        {/* Write a review — signed-in customers only */}
        {user ? (
          <form
            onSubmit={submit}
            className="mt-12 max-w-2xl mx-auto bg-white border border-slate-200 rounded-2xl p-7"
          >
            <h3 className="font-semibold text-lg">
              Write a review / রিভিউ লিখুন
            </h3>
            <label className="block text-sm font-medium text-slate-700 mt-5">
              Your name / আপনার নাম
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                className="mt-1.5 block w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#4A7C9B]"
              />
            </label>
            <div className="mt-4">
              <span className="block text-sm font-medium text-slate-700">
                Your rating / আপনার রেটিং
              </span>
              <div className="flex gap-1 mt-2">
                {[1, 2, 3, 4, 5].map((i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setRating(i)}
                    aria-label={`${i} star${i > 1 ? "s" : ""}`}
                    className="p-1"
                  >
                    <Star
                      className={`h-7 w-7 ${
                        rating >= i
                          ? "fill-amber-400 text-amber-400"
                          : "fill-slate-200 text-slate-200"
                      }`}
                    />
                  </button>
                ))}
              </div>
            </div>
            <label className="block text-sm font-medium text-slate-700 mt-4">
              Your review / আপনার রিভিউ
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={4}
                maxLength={1000}
                placeholder="The AI replies to our customers instantly, even at 3am…"
                className="mt-1.5 block w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#4A7C9B]"
              />
            </label>
            {formError && (
              <p className="mt-3 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
                {formError}
              </p>
            )}
            {formOk && (
              <p className="mt-3 text-sm text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">
                {formOk}
              </p>
            )}
            <button
              type="submit"
              disabled={posting}
              className="mt-5 w-full rounded-lg bg-[#4A7C9B] text-white font-medium py-3 text-sm hover:bg-[#2D5A7B] transition-colors disabled:opacity-60"
            >
              {posting ? "Posting…" : "Post review / রিভিউ পোস্ট করুন"}
            </button>
          </form>
        ) : (
          <p className="text-center text-sm text-slate-700 mt-12">
            Sign in to write a review. / রিভিউ লিখতে সাইন ইন করুন।{" "}
            <a href="/login" className="text-[#4A7C9B] font-medium hover:underline">
              Log in
            </a>
          </p>
        )}
      </div>
    </section>
  );
}
