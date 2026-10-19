import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { verifyJwtEdge } from "@/lib/edge-auth";

const API_VERSION = "2026-04-07";

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "1; mode=block",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "X-API-Version": API_VERSION,
};

const CORS_ORIGIN = process.env.CORS_ORIGIN || "";

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
    pathname.endsWith(".svg") ||
    pathname.endsWith(".ico") ||
    pathname.endsWith(".mp4") ||
    pathname.endsWith(".webm")
  ) {
    return NextResponse.next();
  }

  // CORS preflight
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
  const publicPaths = ["/login", "/setup", "/signup", "/api/auth", "/api/health", "/api/chat/widget", "/api/chat/vision", "/api/chat/voice", "/p/"];
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
    pathname.startsWith("/api/channels/telegram")
  ) {
    return addHeaders(NextResponse.next(), requestId);
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
    return addHeaders(NextResponse.next(), requestId);
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


