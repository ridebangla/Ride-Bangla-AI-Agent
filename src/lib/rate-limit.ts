interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

// Cleanup old entries every 5 minutes
const CLEANUP_INTERVAL = 5 * 60 * 1000;
let lastCleanup = Date.now();

function cleanup() {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL) return;
  lastCleanup = now;

  for (const [key, entry] of store) {
    if (now > entry.resetAt) {
      store.delete(key);
    }
  }
}

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

export const RATE_LIMITS = {
  auth: { maxRequests: 5, windowMs: 60 * 1000 } as RateLimitConfig,
  api: { maxRequests: 60, windowMs: 60 * 1000 } as RateLimitConfig,
  // Money-moving endpoints: rare, expensive — 10 per hour per key.
  claim: { maxRequests: 10, windowMs: 60 * 60 * 1000 } as RateLimitConfig,
  // Onboarding analyze/confirm: website scraping + DB writes — 30/hour/key.
  onboarding: { maxRequests: 30, windowMs: 60 * 60 * 1000 } as RateLimitConfig,
} as const;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export function checkRateLimit(
  key: string,
  config: RateLimitConfig
): RateLimitResult {
  cleanup();

  const now = Date.now();
  const entry = store.get(key);

  if (!entry || now > entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + config.windowMs });
    return {
      allowed: true,
      remaining: config.maxRequests - 1,
      resetAt: now + config.windowMs,
    };
  }

  entry.count++;

  if (entry.count > config.maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: entry.resetAt,
    };
  }

  return {
    allowed: true,
    remaining: config.maxRequests - entry.count,
    resetAt: entry.resetAt,
  };
}

export function resetRateLimit(key: string): void {
  store.delete(key);
}

export function _getStoreForTesting() {
  return store;
}
