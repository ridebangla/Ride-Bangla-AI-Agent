import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { verifyJwtEdge } from "@/lib/edge-auth";

const API_VERSION = "2026-04-07";

// NOTE: Strict-Transport-Security is sent by Vercel's edge on every
// response (max-age=63072000) — it is deliberately NOT duplicated here.
const CSP_DIRECTIVES = [
  "default-src 'self'",
  // 'unsafe-inline' is required for Next.js App Router's own inline
  // bootstrap scripts (no nonce infrastructure yet). Everything else is
  // locked down; revisit with nonces if the app adopts them.
  "script-src 'self' 'unsafe-inline' https://www.gstatic.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https: blob:",
  "font-src 'self' data:",
  "media-src 'self'",
  // Firebase JS SDK (Auth/Firestore) + future hCaptcha widget. The
  // embeddable chat widget is a static JS file served without these
  // headers (see the static bypass below), so customer-site embeds are
  // unaffected by this policy.
  "connect-src 'self' https://*.googleapis.com https://*.gstatic.com https://hcaptcha.com https://*.hcaptcha.com wss:",
  "frame-src https://js.stripe.com https://hcaptcha.com https://*.hcaptcha.com",
  // Our pages are never framed (the widget injects DOM, not an iframe),
  // so framing stays denied — matches X-Frame-Options: DENY above.
  "frame-ancestors 'self'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "1; mode=block",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": CSP_DIRECTIVES,
  "X-API-Version": API_VERSION,
};

const CORS_ORIGIN = process.env.CORS_ORIGIN || "";

/**
 * Public EMBED endpoints — designed to be called from OTHER origins:
 * the embeddable chat widget (any tenant website), the first-party AI
 * endpoint and the shared reviews / firebase-config APIs (sibling
 * sites). Their auth is the public siteKey carried in the request, never
 * cookies, so a wildcard CORS policy is safe here — and REQUIRED:
 * the single-origin CORS_ORIGIN env can never cover every tenant's
 * website. (A-to-Z audit 2026-10-20: without this, cross-origin embeds
 * received responses the browser refused to expose — the server stored
 * the chat and replied, but the visitor only saw "Connection error".)
 */
const PUBLIC_EMBED_PREFIXES = [
  "/api/chat/widget",
  "/api/chat/vision",
  "/api/chat/voice",
  "/api/public/ai/generate",
  "/api/public/reviews",
  "/api/public/firebase-config",
];

function isPublicEmbedPath(pathname: string): boolean {
  return PUBLIC_EMBED_PREFIXES.some((p) => pathname.startsWith(p));
}

function applyPublicEmbedCors(response: NextResponse): NextResponse {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );
  response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  response.headers.set("Access-Control-Max-Age", "86400");
  return response;
}

function generateRequestId(): string {
  return crypto.randomUUID();
}

function addHeaders(
  response: NextResponse,
  requestId: string,
  rateLimit?: { limit: number; remaining: number; resetAt: number }
): NextResponse {
  // Security headers
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(key, value);
  }

  // Request ID
  response.headers.set("X-Request-Id", requestId);

  // Rate limit headers
  if (rateLimit) {
    response.headers.set("X-RateLimit-Limit", String(rateLimit.limit));
    response.headers.set("X-RateLimit-Remaining", String(Math.max(0, rateLimit.remaining)));
    response.headers.set("X-RateLimit-Reset", String(Math.ceil(rateLimit.resetAt / 1000)));
  }

  // CORS
  if (CORS_ORIGIN) {
    response.headers.set("Access-Control-Allow-Origin", CORS_ORIGIN);
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key, X-Request-Id");
    response.headers.set("Access-Control-Expose-Headers", "X-Request-Id, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-API-Version");
    response.headers.set("Access-Control-Max-Age", "86400");
  }

  return response;
}

function getClientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const requestId = request.headers.get("x-request-id") || generateRequestId();

  // Static files and Next.js internals
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.startsWith("/widget/") ||
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml" ||
    pathname.endsWith(".png") ||
    pathname.endsWith(".jpg") ||
    pathname.endsWith(".jpeg") ||
    pathname.endsWith(".svg") ||
    pathname.endsWith(".ico") ||
    pathname.endsWith(".mp4") ||
    pathname.endsWith(".webm") ||
    // The PWA manifest (declared in the root layout metadata) is a public
    // static asset: browsers fetch it without a session, so it must bypass
    // the auth gate like the icons do — otherwise /manifest.webmanifest
    // 307-redirects to /login and the manifest is unreachable.
    pathname.endsWith(".webmanifest")
  ) {
    return NextResponse.next();
  }

  // CORS preflight
  if (request.method === "OPTIONS" && isPublicEmbedPath(pathname)) {
    return applyPublicEmbedCors(
      addHeaders(new NextResponse(null, { status: 204 }), requestId)
    );
  }
  if (request.method === "OPTIONS" && CORS_ORIGIN) {
    return addHeaders(new NextResponse(null, { status: 204 }), requestId);
  }

  // Public paths that don't require auth. NOTE: /api/openapi.json is NOT
  // public (M-59 — admin-gated in its route); /api/health stays public but
  // returns only `{ status }` to non-admins (M-59).
  // NOTE: /api/chat/widget is the PUBLIC website-widget chat endpoint — its
  // auth is the business's public siteKey (validated in the route handler,
  // rate-limited per siteKey+visitor). It must stay in this list or the
  // embeddable widget can never reach the chat API (401 for all visitors).
  // Phase 3: /api/chat/vision and /api/chat/voice are the widget's photo /
  // voice upload endpoints — same public siteKey auth model as the widget
  // chat endpoint, so they must be public here too.
  // Premium polish: /api/landing/quality is the public visual quality gate
  // for landing pages (GET ?slug=). It is read-only, fail-closed on the
  // slug (same scoping as /p/[slug]), rate-limited per IP in its handler,
  // and every check is derived from public page data (image URLs, copy,
  // theme, SEO meta) — nothing tenant-private is exposed.
  // Phase 4: /pricing is the public SaaS pricing page (marketing, no
  // tenant data), and /api/webhooks/stripe carries Stripe's signature, not
  // a JWT — it verifies authenticity itself via STRIPE_WEBHOOK_SECRET in
  // its handler (see src/app/api/webhooks/stripe/route.ts). Both must stay
  // public here or pricing 404-redirects to /login and Stripe can never
  // deliver billing events.
  // Help Center (Phase 5): /contact is the public contact page (marketing,
  // no tenant data), and /api/contact is the public ticket + contacts API —
  // it validates every field itself, is rate-limited per IP, and writes
  // through the Admin SDK, so it is safe to expose here.
  // First-party AI (sibling sites): /api/public/ai/generate is the
  // site-key-authenticated AI endpoint for the Tools site and other sibling
  // sites — same public siteKey auth model as the widget chat endpoint
  // (validated + rate-limited in the route handler), so it must be public
  // here too.
  // Shared Reviews API (Tools / AI site / Studio): /api/public/reviews and
  // /api/public/firebase-config follow the same siteKey auth model as
  // /api/public/ai/generate (validated + rate-limited in the route
  // handlers), so they must be public here too.
  const publicPaths = ["/login", "/setup", "/signup", "/pricing", "/privacy", "/terms", "/contact", "/api/contact", "/api/auth", "/api/health", "/api/chat/widget", "/api/chat/vision", "/api/chat/voice", "/api/public/ai/generate", "/api/public/reviews", "/api/public/firebase-config", "/api/landing/quality", "/api/webhooks/stripe", "/p/"];
  const isPublic = publicPaths.some((p) => pathname.startsWith(p));

  // The SaaS marketing landing page lives at `/` — EXACT match only (a
  // startsWith("/") prefix here would make the entire site public).
  // Logged-out visitors see the landing page; the root page itself
  // redirects logged-in users to /dashboard (or /billing when their
  // trial/subscription is inactive).
  const isLandingRoot = pathname === "/";

  // Channel webhook endpoints (authenticated via provider signatures, not JWT)
  if (
    pathname.startsWith("/api/channels/phone/") ||
    pathname.startsWith("/api/channels/sms") ||
    pathname.startsWith("/api/channels/telegram") ||
    // Phase 5: provider webhooks — Meta (X-Hub-Signature-256), WhatsApp
    // Cloud (verify-token handshake), X (CRC challenge). Signature/token
    // verified inside each route; never JWT.
    pathname.startsWith("/api/webhooks/meta") ||
    pathname.startsWith("/api/webhooks/whatsapp") ||
    pathname.startsWith("/api/webhooks/x")
  ) {
    return addHeaders(NextResponse.next(), requestId);
  }

  // Phase 6 (Launch Readiness): the Admin Console (admin.ridebangla.bd) calls
  // GET /api/admin/launch-readiness from the browser with a Firebase ID token
  // in the Authorization header — it has no rbai-token cookie. The middleware
  // preflight below lets the CORS preflight through; the GET itself reaches
  // the handler via the bearer pass-through further down, where the token is
  // verified fail-closed. The origin is scoped to the Admin Console only.
  const adminConsoleOrigin =
    process.env.ADMIN_CONSOLE_ORIGIN || "https://admin.ridebangla.bd";
  if (
    pathname.startsWith("/api/admin/launch-readiness") &&
    request.method === "OPTIONS"
  ) {
    const preflight = new NextResponse(null, { status: 204 });
    preflight.headers.set("Access-Control-Allow-Origin", adminConsoleOrigin);
    preflight.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    preflight.headers.set(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type"
    );
    preflight.headers.set("Access-Control-Max-Age", "86400");
    return addHeaders(preflight, requestId);
  }

  // Rate limiting for auth endpoint
  if (pathname.startsWith("/api/auth")) {
    const ip = getClientIp(request);
    const rateResult = checkRateLimit(`auth:${ip}`, RATE_LIMITS.auth);

    if (!rateResult.allowed) {
      const response = NextResponse.json(
        { error: { code: "RATE_LIMIT_EXCEEDED", message: "Too many requests. Please try again later.", requestId } },
        { status: 429 }
      );
      response.headers.set("Retry-After", String(Math.ceil((rateResult.resetAt - Date.now()) / 1000)));
      return addHeaders(response, requestId, { limit: RATE_LIMITS.auth.maxRequests, remaining: 0, resetAt: rateResult.resetAt });
    }

    return addHeaders(NextResponse.next(), requestId, {
      limit: RATE_LIMITS.auth.maxRequests,
      remaining: rateResult.remaining,
      resetAt: rateResult.resetAt,
    });
  }

  if (isPublic || isLandingRoot) {
    const res = addHeaders(NextResponse.next(), requestId);
    return isPublicEmbedPath(pathname) ? applyPublicEmbedCors(res) : res;
  }

  // General API rate limiting
  let apiRateInfo: { limit: number; remaining: number; resetAt: number } | undefined;
  if (pathname.startsWith("/api/")) {
    const ip = getClientIp(request);
    const rateResult = checkRateLimit(`api:${ip}`, RATE_LIMITS.api);

    if (!rateResult.allowed) {
      const response = NextResponse.json(
        { error: { code: "RATE_LIMIT_EXCEEDED", message: "Too many requests. Please try again later.", requestId } },
        { status: 429 }
      );
      response.headers.set("Retry-After", String(Math.ceil((rateResult.resetAt - Date.now()) / 1000)));
      return addHeaders(response, requestId, { limit: RATE_LIMITS.api.maxRequests, remaining: 0, resetAt: rateResult.resetAt });
    }

    apiRateInfo = {
      limit: RATE_LIMITS.api.maxRequests,
      remaining: rateResult.remaining,
      resetAt: rateResult.resetAt,
    };
  }

  // Check for auth token (cookie) or API key (header)
  const token = request.cookies.get("rbai-token")?.value;
  const apiKey = request.headers.get("x-api-key");

  if (!token && !apiKey) {
    if (pathname.startsWith("/api/")) {
      return addHeaders(
        NextResponse.json(
          { error: { code: "UNAUTHORIZED", message: "Authentication required", requestId } },
          { status: 401 }
        ),
        requestId,
        apiRateInfo
      );
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // API key auth is validated in route handlers (requireAuth), just pass through
  if (apiKey && !token) {
    return addHeaders(NextResponse.next(), requestId, apiRateInfo);
  }

  // Phase 6 (Launch Readiness): bearer requests for
  // /api/admin/launch-readiness carry a Firebase ID token and no cookie.
  // The token is verified inside the route (fail-closed); the middleware
  // only lets the request reach the handler, with API rate-limit headers
  // already applied above.
  const bearerAuth = request.headers.get("authorization") || "";
  if (
    !token &&
    pathname.startsWith("/api/admin/launch-readiness") &&
    /^Bearer\s+\S+$/i.test(bearerAuth.trim())
  ) {
    return addHeaders(NextResponse.next(), requestId, apiRateInfo);
  }

  // Verify the JWT signature (C-07). Previously middleware only checked that
  // the cookie had 3 dot-separated parts, so a forged `a.b.c` token passed.
  // Signature verification here is an optimistic pre-filter; route handlers
  // still enforce auth + permissions via requireAuth (incl. revocation),
  // because middleware cannot query the database.
  const payload = await verifyJwtEdge(
    token || "",
    process.env.JWT_SECRET || ""
  );
  if (!payload) {
    if (pathname.startsWith("/api/")) {
      return addHeaders(
        NextResponse.json(
          { error: { code: "INVALID_TOKEN", message: "Invalid authentication token", requestId } },
          { status: 401 }
        ),
        requestId,
        apiRateInfo
      );
    }
    const response = NextResponse.redirect(new URL("/login", request.url));
    response.cookies.delete("rbai-token");
    return response;
  }

  return addHeaders(NextResponse.next(), requestId, apiRateInfo);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};


