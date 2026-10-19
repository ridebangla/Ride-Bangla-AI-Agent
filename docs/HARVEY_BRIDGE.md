# Harvey → SaaS Bridge Specification

How the Harvey Python sidecar talks to this platform. The codebases are NOT
merged — Firestore is the contract.

## Direction of data flow

| Direction | Mechanism |
|---|---|
| Harvey → SaaS | Sidecar writes Firestore docs with the Firebase **Admin SDK** (service account). Collections: `leadScans`, `leads`, `leadDrafts`. |
| SaaS → Harvey | Sidecar polls Firestore for work: `leadScans` where `status == 'requested'`, and `leadDrafts` where `status == 'approved'`. |

The sidecar runs with its own infrastructure: the tenant's (or the
platform's) Claude/Codex subscription login and mailbox credentials, taken
from the `leadSettings` doc of the business it serves.

## Tenant identity

Every lead-engine doc carries `businessId`:

- Tenant docs: `businessId` = the tenant's business id (from `businesses`).
- The platform's own outbound account: `businessId = "ride-bangla"`.
  The sidecar needs a `businesses/ride-bangla` doc to exist (created once by
  the platform team; it is the tenant row for Ride Bangla itself).

The sidecar MUST set `businessId` on every write. Reads are tenant-scoped
by `firestore.rules` (tenant + Super Admin only).

## Collection mapping (Harvey SQLite → Firestore)

### `leadScans` ← scan lifecycle
Harvey has no scan object; the sidecar creates one per discovery run:
- `name`: human label (e.g. "Dhaka restaurants — 2026-10-20")
- `icp`: snapshot of the tenant's confirmed ICP (`leadSettings.icp`)
- `status`: `requested` → `running` → `completed` | `failed`
- `stats`: `{ discovered, profiled, scored }`
- `error`: failure reason when `failed`

### `leads` ← Company + Prospect (flattened)
Harvey's `Company` and its primary `Prospect` are flattened into ONE doc
(one row per business keeps the dashboard simple):
- `scanId`, `name`, `domain`, `website`, `description`, `industry`,
  `companySize`, `location`, `phone`
- `contactName` ← `first_name + last_name`, `contactTitle` ← `title`,
  `contactEmail` ← normalized `email`,
  `contactEmailStatus` ← `email_status` (`verified` | `risky` | `guess` | `invalid`)
- `icpScore` ← scout score (0–100)
- `signals` ← `[{ type, detail, found_at }]` (hiring, funding, tech detected…)
- `techStack` ← `tech_stack`
- `source`, `sourceUrl`, `externalId` (dedup key, e.g. `osm:node/123`)
- `personalizationNotes` ← writer observations
- `status`: `new` | `contacted` | `replied` | `meeting` | `closed` | `lost`
- Dedup: compound unique on (`businessId`, `externalId`) — the sidecar must
  upsert, never duplicate.

### `leadDrafts` ← Campaign EmailStep
One doc per email step:
- `leadId`, `scanId`, `channel: "email"`, `step`, `delayDays`
- `toEmail`, `subject`, `body` (plain text only)
- `status`: `draft` → (`approved` | `rejected` by a human) → `sent` | `failed`
- `gateCheck`: `{ ok, reasons[] }` — result of `preSendGateCheck()` in
  `src/lib/lead-engine.ts`, computed by the sidecar at write time.

## Send protocol (the human gate, enforced twice)

1. The sidecar writes drafts with `status: "draft"`. It MUST run the
   deterministic gate (`harvey/gate.py`) before writing; drafts that fail
   are never written as sendable.
2. A human approves in the dashboard (`PATCH /api/lead-drafts/[id]`,
   `action: "approve"`). The API re-runs the gate (`preSendGateCheck()`)
   and REFUSES approval (400 + reasons) when it fails.
3. The sidecar sends ONLY docs where `status == "approved"`, and re-runs
   the gate immediately before each send. Any failure → `status: "failed"`,
   `sendError` set, nothing leaves.
4. After sending: `status: "sent"`, `sentAt` set; the lead moves to
   `contacted`. Replies flip the lead to `replied` (handler pass).

There is deliberately NO send endpoint in the web app. Approval without
the sidecar arms nothing.

## `leadSettings` (written by the SaaS, read by the sidecar)

- `icp`: `{ industries[], companySize, titles[], geography[] }`
- `mailboxProvider` (`gmail` | `microsoft` | `smtp`), `mailboxUser`,
  `mailboxSecret` (same storage pattern as `settings.smtpPass`)
- `aiBackend` (`claude` | `codex`), `maxDailySends` (default 50),
  `requireApproval` (always true — structural, not user-configurable)

## Honest states

- No `leadSettings` credentials → dashboard shows "not configured"; scans
  stay `requested`; drafts stay `draft`. Nothing is faked.
- The sidecar is a separate deployment (needs the AI subscription login +
  mailbox). This repo ships the contract, the UI, and the gates — not the
  runner.
