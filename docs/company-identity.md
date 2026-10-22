# Company identity — estate-scoped inheritance rule

Ride Bangla's own account is outside the plan/key/credit/limit
machinery on every platform surface. That exemption is keyed to ONE
estate-scoped company identity, not to per-surface wiring. This
document is the inheritance rule for new surfaces: what makes a future
website or app "covered", and what does not.

## The shared record

One Firestore doc, `company_identity/current`:

```json
{
  "aiBusinessIds": ["<AI-platform business id>", "..."],
  "studioUids": ["<Studio Firebase Auth uid>", "..."],
  "version": 1,
  "updatedAt": "<timestamp>",
  "updatedBy": "<super admin email>"
}
```

- The **Admin Console writes it** — Super Admin only, in the same
  batch as the per-platform flag write, with the audit row.
- The per-platform flags remain as a synchronised **projection /
  fallback**: on this platform, `businesses/{businessId}`
  `.isInternalAccount === true`. A business is COMPANY when its id is
  listed in `aiBusinessIds` **OR** its business doc carries the
  projection flag. Only strict boolean `true` / exact list membership
  counts — never a client-supplied value.
- Read leg (this repo): `src/lib/company-identity.ts` —
  `getCompanyIdentity()` (Admin-SDK read, 60-second in-process TTL
  cache; the TTL bounds revocation latency to ~a minute per instance
  at one read per minute per instance) and `isCompanyBusiness()`.
  On ANY read error the resolver degrades to the projection flag
  only — an error is never treated as "company", and the resolver
  never throws into a gate. An absent doc is the correct
  pre-migration state and resolves to empty lists.

## The inheritance rule

A new company surface is covered **if and only if both** hold:

1. **It resolves to the company identity.** Either:
   - it talks to the AI platform as the Ride Bangla business (the
     shared siteKey — the server resolves the business record behind
     it), or
   - it resolves its signed-in user to an identity listed in
     `company_identity/current` (an `aiBusinessIds` entry on this
     platform, a `studioUids` entry on Studio).
2. **It goes through the platform's shared gates** —
   `getSubscription()` / `isSubscriptionActive()` in
   `src/lib/subscription.ts` and the metering/limit functions in
   `src/lib/billing-usage.ts` — instead of running its own plan
   checks.

A surface with its own backend or its own plan/limit checks inherits
**nothing**, even if it belongs to the company: the exemption lives in
the shared identity + the shared gates, not in the surface. (The
historical proof: a company surface that ran a bespoke AI backend
with its own key was never covered until it was rewired to the
platform contract.)

## Post-quota seed step

The shared record starts empty (the pre-migration state above: every
platform keeps working on its projection flags alone). Seeding
`company_identity/current` with the company's real business id / uids
is a production data write owned by the Admin repo's seed step; it
happens after the Firestore quota window reopens, from the Admin
Console's grant flow — not from this repo.
