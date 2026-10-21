"use client";

/**
 * ReviewsSection — public reviews for the AI site, rendered on the marketing
 * landing page. Data comes from the shared public Reviews API
 * (GET /api/public/reviews?site=ai&siteKey=…) — published reviews only, no
 * seeded/fake data. The write-review form is shown only to customers who are
 * signed in with Firebase on this device (their existing session); they post
 * with their ID token. UI copy via i18n (English default; bn in locales/bn.ts).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { Star } from "lucide-react";
import { getFirebaseAuth } from "@/lib/firebase-client";
import { t, tf, DEFAULT_LOCALE } from "@/lib/i18n";

interface PublicReview {
  name: string;
  /** Reviewer's profile photo captured at submission; "" when none. */
  photoURL?: string;
  /** True only when the stored record proves Google sign-in. */
  verifiedGoogle?: boolean;
  rating: number;
  text: string;
  createdAt: string;
}

/** Reviewer avatar: their profile photo when the record carries one;
 *  an initial circle otherwise (same pattern as the main website). */
function Avatar({ name, photoURL }: { name: string; photoURL?: string }) {
  const [broken, setBroken] = useState(false);
  if (photoURL && !broken) {
    return (
      <img
        src={photoURL}
        alt={name}
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
        className="h-10 w-10 shrink-0 rounded-full object-cover"
      />
    );
  }
  return (
    <span className="h-10 w-10 shrink-0 rounded-full bg-[#4A7C9B] text-white flex items-center justify-center font-semibold">
      {(name || "?").charAt(0).toUpperCase()}
    </span>
  );
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

  // One-row sliding carousel (same behaviour as the main website):
  // cards in a single horizontal line, advancing one card at a time.
  const [slide, setSlide] = useState(0);
  const [carouselPaused, setCarouselPaused] = useState(false);
  const [visibleCount, setVisibleCount] = useState(2);
  useEffect(() => {
    const update = () => setVisibleCount(window.innerWidth >= 1024 ? 4 : 2);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const maxSlide = Math.max(0, reviews.length - visibleCount);
  const safeSlide = Math.min(slide, maxSlide);
  const maxSlideRef = useRef(maxSlide);
  maxSlideRef.current = maxSlide;
  useEffect(() => {
    if (carouselPaused || maxSlide <= 0) return;
    const timer = setInterval(() => {
      const max = maxSlideRef.current;
      if (max <= 0) return;
      setSlide((prev) => (prev >= max ? 0 : prev + 1));
    }, 4000);
    return () => clearInterval(timer);
  }, [carouselPaused, maxSlide]);
  const goToSlide = (index: number) => {
    const max = maxSlideRef.current;
    if (max <= 0) return;
    setSlide(((index % (max + 1)) + (max + 1)) % (max + 1));
  };

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
      setFormError(t("reviews.name_required"));
      return;
    }
    if (!text.trim()) {
      setFormError(t("reviews.text_required"));
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
            t("reviews.post_failed")
        );
        return;
      }
      setText("");
      setFormOk(
        t("reviews.post_success")
      );
      await load();
    } catch {
      setFormError(
        t("reviews.post_failed_network")
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
          {t("reviews.heading")}
        </h2>
        <p className="text-slate-700 text-center mt-3 max-w-2xl mx-auto">
          {t("reviews.subheading")}
        </p>

        <div className="flex items-center justify-center gap-3 mt-8">
          <Stars value={average} size={26} />
          <span className="text-2xl font-bold">{average.toFixed(1)}</span>
          <span className="text-slate-700 text-sm">
            {tf(count === 1 ? "reviews.count_one" : "reviews.count_other", DEFAULT_LOCALE, { count })}
          </span>
        </div>

        {loaded && reviews.length === 0 && (
          <p className="text-center text-slate-700 mt-10">
            {t("reviews.empty")}
          </p>
        )}

        {reviews.length > 0 && (
          <div
            className="relative mt-10"
            onMouseEnter={() => setCarouselPaused(true)}
            onMouseLeave={() => setCarouselPaused(false)}
            onTouchStart={() => setCarouselPaused(true)}
            onTouchEnd={() => setCarouselPaused(false)}
          >
            <div className="overflow-hidden">
              <div
                className="-mx-2.5 flex transition-transform duration-700 ease-[cubic-bezier(0.22,1,0.36,1)]"
                style={{
                  transform: `translateX(-${safeSlide * (100 / visibleCount)}%)`,
                }}
              >
                {reviews.map((r, i) => (
                  <div
                    key={`${r.createdAt}-${i}`}
                    className="w-1/2 shrink-0 px-2.5 lg:w-1/4"
                  >
                    <article className="h-full bg-white border border-slate-200 rounded-2xl p-6">
                      <div className="flex items-center gap-3">
                        <Avatar name={r.name} photoURL={r.photoURL} />
                        <div className="min-w-0">
                          <p className="font-semibold text-sm truncate">
                            {r.name}
                          </p>
                          <Stars value={r.rating} size={13} />
                        </div>
                      </div>
                      <p className="text-sm text-slate-600 mt-3 leading-relaxed whitespace-pre-line">
                        {r.text}
                      </p>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        {r.verifiedGoogle === true && (
                          <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                            {t("reviews.verified_badge")}
                          </span>
                        )}
                        <p className="text-xs text-slate-600">
                          {new Date(r.createdAt).toLocaleDateString("en-GB", {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                          })}
                        </p>
                      </div>
                    </article>
                  </div>
                ))}
              </div>
            </div>
            {maxSlide > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => goToSlide(safeSlide - 1)}
                  aria-label="Previous reviews"
                  className="absolute -left-2 top-1/2 z-10 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full bg-white shadow-md transition hover:bg-slate-50 sm:-left-4"
                >
                  <svg
                    className="h-4 w-4 text-slate-600"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M15 19l-7-7 7-7"
                    />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => goToSlide(safeSlide + 1)}
                  aria-label="Next reviews"
                  className="absolute -right-2 top-1/2 z-10 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full bg-white shadow-md transition hover:bg-slate-50 sm:-right-4"
                >
                  <svg
                    className="h-4 w-4 text-slate-600"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                </button>
                <div className="mt-4 flex items-center justify-center gap-1.5">
                  {Array.from({ length: maxSlide + 1 }).map((_, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => goToSlide(idx)}
                      aria-label={`Go to slide ${idx + 1}`}
                      className={`h-1.5 rounded-full transition-all ${
                        idx === safeSlide
                          ? "w-6 bg-[#4A7C9B]"
                          : "w-1.5 bg-slate-300 hover:bg-slate-400"
                      }`}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* Write a review — signed-in customers only */}
        {user ? (
          <form
            onSubmit={submit}
            className="mt-12 max-w-2xl mx-auto bg-white border border-slate-200 rounded-2xl p-7"
          >
            <h3 className="font-semibold text-lg">
              {t("reviews.write_heading")}
            </h3>
            <label className="block text-sm font-medium text-slate-700 mt-5">
              {t("reviews.your_name")}
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                className="mt-1.5 block w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#4A7C9B]"
              />
            </label>
            <div className="mt-4">
              <span className="block text-sm font-medium text-slate-700">
                {t("reviews.your_rating")}
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
              {t("reviews.your_review")}
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
              {posting ? "Posting…" : t("reviews.post_button")}
            </button>
          </form>
        ) : (
          <p className="text-center text-sm text-slate-700 mt-12">
            {t("reviews.signin_prompt")}{" "}
            <a href="/login" className="text-[#4A7C9B] font-medium hover:underline">
              Log in
            </a>
          </p>
        )}
      </div>
    </section>
  );
}
