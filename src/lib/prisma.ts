import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { AsyncLocalStorage } from "async_hooks";

const connectionString =
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5432/ride-bangla-ai-agent?schema=public";

// ---------------------------------------------------------------------------
// MULTI-TENANCY (data-layer enforcement)
//
// Every business-data model carries a `businessId`. All queries issued through
// the exported `prisma` client below are AUTOMATICALLY scoped to the current
// request's business — a business can never read or write another business's
// rows, even if a route forgets to filter.
//
// How the current business is established:
//   1. API routes: `requireAuth()` (src/lib/route-auth.ts) calls
//      `enterBusinessContext()` after resolving the admin / API key.
//   2. Public widget chat: `/api/chat` resolves the business from the
//      per-business `siteKey` and enters its context.
//   3. Channel webhooks/workers (no request auth): each handler wraps itself
//      in `runWithBusiness(await resolveChannelBusiness())`.
//   4. Scripts/seed: use `getUnscopedPrisma()` directly (never the proxy).
//
// Super Admin = Admin row with businessId NULL  =>  no scoping applied.
// If NO context was ever entered, tenant-model access THROWS
// (fail-closed) instead of silently leaking across businesses.
// ---------------------------------------------------------------------------

const TENANT_MODELS = new Set([
  "settings",
  "admin",
  "category",
  "knowledgeEntry",
  "department",
  "teamMember",
  "conversation",
  "message",
  "ticket",
  "tag",
  "conversationTag",
  "callLog",
  "channel",
  "webhook",
  "webhookDelivery",
  "activityLog",
  "slaRule",
  "cannedResponse",
  "customer",
  "customerNote",
  "automationRule",
  "businessHours",
  "apiKey",
  "internalNote",
  "campaign",
  "flow",
  "schedule",
  "followUp",
  "productCategory",
  "product",
  "socialAccount",
  "scheduledPost",
  "socialInteraction",
  "audienceProfile",
  "agentCommand",
]);

export class TenantContextError extends Error {
  constructor(model: string, operation: string) {
    super(
      `Tenant context missing for ${model}.${operation}: ` +
        `call enterBusinessContext()/runWithBusiness() first, or use getUnscopedPrisma() in scripts.`
    );
    this.name = "TenantContextError";
  }
}

type TenantStore = { businessId: string | null };
const tenantStore = new AsyncLocalStorage<TenantStore>();

/** Run `fn` with an explicit business context (workers, scripts, tests). */
export function runWithBusiness<T>(
  businessId: string | null,
  fn: () => T
): T {
  return tenantStore.run({ businessId }, fn);
}

/**
 * Enter a business context for the REMAINDER of the current async execution
 * (used by requireAuth inside API route handlers: everything the handler
 * awaits afterwards inherits the context).
 */
export function enterBusinessContext(businessId: string | null): void {
  tenantStore.enterWith({ businessId });
}

/** Current business id, or null (super admin), or undefined (no context). */
export function getBusinessId(): string | null | undefined {
  return tenantStore.getStore()?.businessId;
}

/**
 * Attach the ambient business id to a create payload. The tenant proxy also
 * injects it at runtime, but TypeScript needs it statically: Prisma's
 * CreateInput requires the `business` relation. Fail-closed: throws when no
 * tenant context is active.
 */
export function withBusinessId<T extends object>(data: T): T & { businessId: string } {
  const id = getBusinessId();
  if (!id) {
    throw new TenantContextError("create", "withBusinessId");
  }
  return { ...data, businessId: id };
}

/** Array variant of withBusinessId (for createMany). */
export function withBusinessIdMany<T extends object>(
  rows: T[]
): (T & { businessId: string })[] {
  const id = getBusinessId();
  if (!id) {
    throw new TenantContextError("createMany", "withBusinessIdMany");
  }
  return rows.map((r) => ({ ...r, businessId: id }));
}

function scopedWhere(
  where: Record<string, unknown> | undefined,
  businessId: string
): Record<string, unknown> {
  if (!where || Object.keys(where).length === 0) return { businessId };
  return { AND: [where, { businessId }] };
}

const LIST_OPS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "count",
  "aggregate",
  "groupBy",
  "updateMany",
  "deleteMany",
]);

function p2025(model: string): Error {
  const err = new Error(
    `An operation failed because it depends on one or more records that were required but not found. (${model})`
  );
  (err as unknown as { code: string }).code = "P2025";
  return err;
}

function wrapModel(model: string, delegate: Record<string, unknown>) {
  const cache = new Map<string | symbol, unknown>();
  return new Proxy(delegate, {
    get(target, prop, receiver) {
      if (cache.has(prop)) return cache.get(prop);
      const orig = Reflect.get(target, prop, receiver);
      if (typeof orig !== "function") {
        cache.set(prop, orig);
        return orig;
      }
      const op = String(prop);
      const wrapped = (...args: unknown[]) => {
        const businessId = getBusinessId();
        if (businessId === undefined) {
          throw new TenantContextError(model, op);
        }
        if (businessId === null) {
          // Super Admin: unscoped.
          return (orig as (...a: unknown[]) => unknown)(...args);
        }
        const a = (args[0] ?? {}) as Record<string, unknown>;

        if (LIST_OPS.has(op)) {
          return (orig as (...x: unknown[]) => unknown)({
            ...a,
            where: scopedWhere(
              a.where as Record<string, unknown> | undefined,
              businessId
            ),
          }, ...args.slice(1));
        }

        if (op === "findUnique" || op === "findUniqueOrThrow") {
          // findUnique cannot take a compound where; use findFirst instead.
          const fn = op === "findUnique" ? "findFirst" : "findFirstOrThrow";
          const { orderBy: _ob, ...rest } = a;
          return (
            delegate[fn] as (...x: unknown[]) => unknown
          )({
            ...rest,
            where: scopedWhere(
              a.where as Record<string, unknown> | undefined,
              businessId
            ),
          });
        }

        if (op === "create") {
          const data = a.data as Record<string, unknown>;
          return (orig as (...x: unknown[]) => unknown)({
            ...a,
            data: data.businessId ? data : { ...data, businessId },
          });
        }

        if (op === "createMany") {
          const data = a.data as Record<string, unknown>[];
          return (orig as (...x: unknown[]) => unknown)({
            ...a,
            data: data.map((d) =>
              d.businessId ? d : { ...d, businessId }
            ),
          });
        }

        if (op === "update" || op === "delete") {
          // Two-step guarded mutation: first prove the row belongs to this
          // business, then mutate by id. Preserves P2025 semantics.
          return (async () => {
            const existing = (await (
              delegate["findFirst"] as (...x: unknown[]) => Promise<{ id: string } | null>
            )({
              where: scopedWhere(
                a.where as Record<string, unknown> | undefined,
                businessId
              ),
              select: { id: true },
            })) as { id: string } | null;
            if (!existing) throw p2025(model);
            return (orig as (...x: unknown[]) => Promise<unknown>)({
              ...a,
              where: { id: existing.id },
            });
          })();
        }

        if (op === "upsert") {
          return (async () => {
            const { where, create, update, ...rest } = a;
            const existing = (await (
              delegate["findFirst"] as (...x: unknown[]) => Promise<{ id: string } | null>
            )({
              where: scopedWhere(
                where as Record<string, unknown> | undefined,
                businessId
              ),
              select: { id: true },
            })) as { id: string } | null;
            if (existing) {
              return (delegate["update"] as (...x: unknown[]) => Promise<unknown>)({
                ...rest,
                where: { id: existing.id },
                data: update,
              });
            }
            const cdata = create as Record<string, unknown>;
            return (delegate["create"] as (...x: unknown[]) => Promise<unknown>)({
              ...rest,
              data: cdata.businessId ? cdata : { ...cdata, businessId },
            });
          })();
        }

        // Unknown op: pass through (fail-open would be wrong, but unknown
        // Prisma ops on delegates are vanishingly rare; log loudly).
        // eslint-disable-next-line no-console
        console.warn(
          `[tenant] unscoped passthrough: ${model}.${op} (business ${businessId})`
        );
        return (orig as (...x: unknown[]) => unknown)(...args);
      };
      cache.set(prop, wrapped);
      return wrapped;
    },
  });
}

function createTenantProxy<T extends object>(raw: T): T {
  return new Proxy(raw, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (
        typeof prop === "string" &&
        TENANT_MODELS.has(prop) &&
        value !== null &&
        typeof value === "object"
      ) {
        return wrapModel(prop, value as Record<string, unknown>);
      }
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

function createRawClient() {
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

const globalForPrisma = globalThis as unknown as {
  rawPrisma: PrismaClient | undefined;
  prisma: PrismaClient | undefined;
};

const rawPrisma = globalForPrisma.rawPrisma ?? createRawClient();

/**
 * The tenant-enforcing client. Import THIS everywhere (`import { prisma }
 * from "@/lib/prisma"`). All tenant-model queries are auto-scoped.
 */
export const prisma = (globalForPrisma.prisma ??
  createTenantProxy(rawPrisma)) as PrismaClient;

/** Bypass tenant scoping. ONLY for seed/migration scripts and controlled setup code. */
export function getUnscopedPrisma(): PrismaClient {
  return rawPrisma;
}

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.rawPrisma = rawPrisma;
  globalForPrisma.prisma = prisma;
}
