# First-Party AI API — contract for sibling sites (Tools, Studio, …)

Sibling sites MUST call AI through this backend. Provider API keys
(`GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`) live ONLY in this
project's Vercel env (and optionally per site in Firestore — see "Key
resolution") and NEVER in a sibling site's code, env, or client bundle.

## Endpoint

- **Path:** `POST https://ai.ridebangla.bd/api/public/ai/generate`
- **Auth:** the site's public `siteKey` in the JSON body
  (the same site key the chat widget uses — shown in the dashboard widget
  page; it identifies the site but grants no admin powers).
- **Rate limit:** 30 requests/minute per (`siteKey` + `callerId`) → HTTP 429.
- **Billing gate:** inactive trial/subscription → HTTP 402
  `{ "ok": false, "error": "subscription_paused" }` (same as the widget).
- **Content-Type:** `application/json`.

## Request

```json
{
  "siteKey": "rbsite-00f37b79c72f4e678febbd82d43bb46c",
  "task": "chat",
  "provider": "auto",
  "callerId": "tools:qr-generator",
  "input": {
    "messages": [
      { "role": "system", "content": "You are a helpful assistant." },
      { "role": "user", "content": "Write a product description for …" }
    ]
  },
  "maxTokens": 1000,
  "temperature": 0.7
}
```

| Field | Required | Notes |
|---|---|---|
| `siteKey` | yes | 401 `{ ok:false, error:"siteKey is required" }` / `"Invalid site key"` |
| `task` | yes | Allowlisted: `"chat"` or `"generate"` only. Anything else → 400 |
| `provider` | no | Allowlisted hint: `"auto"` (default) \| `"groq"` \| `"gemini"` \| `"openai"`. Anything else → 400. `auto` = priority chain with failover (see below). A pinned provider is attempted ONLY — failure returns 502, never a silent switch |
| `callerId` | no | Free-form per-tool label (e.g. `tools:paraphraser`) for separate rate-limit buckets. Defaults to `"default"` |
| `input.messages` | task=`chat` | Non-empty array, max 50 entries; each `{ role: "user"\|"assistant"\|"system", content: string }`. Content truncated to 20,000 chars |
| `input.prompt` | task=`generate` | The prompt string (truncated to 20,000 chars) |
| `input.system` | task=`generate` | Optional system instruction |
| `maxTokens` | no | Default 1000, capped at 4000 |
| `temperature` | no | Default 0.7, range 0–2 |

## Responses

**Success — 200**
```json
{
  "ok": true,
  "aiConfigured": true,
  "provider": "groq",
  "model": "llama-3.3-70b-versatile",
  "text": "…AI-generated text…"
}
```

**Honest degraded — 200 (never faked output).**
Returned when NO provider key resolves for the site:
```json
{
  "ok": true,
  "aiConfigured": false,
  "provider": null,
  "model": null,
  "text": null,
  "message": "AI is not configured for this site yet — the site owner still needs to add an AI provider key (Groq, Gemini, or OpenAI). This response was not AI-generated."
}
```
Sibling UI rule: when `aiConfigured === false`, show a tasteful
"AI unavailable" state — never render placeholder AI text.

**Errors**
| Status | Shape | Meaning |
|---|---|---|
| 400 | `{ ok:false, error:"…" }` | Bad task / input / provider hint / maxTokens / temperature |
| 401 | `{ ok:false, error:"siteKey is required" }` or `"Invalid site key"` | Auth failed |
| 402 | `{ ok:false, error:"subscription_paused" }` | Site's trial/subscription inactive |
| 429 | `{ ok:false, error:"Too many requests. …" }` | Rate limit hit — back off |
| 502 | `{ ok:false, error:"AI provider \"groq\" failed", provider:"groq", reason:"…" }` | Pinned provider (or whole chain) failed — honest, retryable |
| 500 | `{ ok:false, error:"AI request failed" }` | Unexpected server error |

## Provider selection & failover

- `provider: "auto"` (default): providers are tried in `AI_PROVIDER_PRIORITY`
  order (default `groq,gemini,openai` — Groq first: fastest OpenAI-compatible
  drop-in with the same tool-calling semantics; Gemini second: high-quality
  fallback with native vision/audio; OpenAI last: legacy path). Providers
  without a key are skipped; on error / rate-limit / timeout the request
  fails over to the next provider automatically.
- `provider: "groq"|"gemini"|"openai"`: ONLY that provider is attempted
  (a site's config can pin its preferred provider). Failure → 502 with the
  reason; the backend never silently switches providers behind a pin.

## Key resolution (per-site keys from day one)

For each request the backend resolves keys as:

1. The site's own dedicated keys: Firestore `settings.aiKeys`
   (`{ groq?: string, gemini?: string, openai?: string }`) for that site's
   business — read with the Admin SDK, server-side only.
2. Per provider, anything missing falls back to the shared env keys
   (`GROQ_API_KEY` / `GEMINI_API_KEY` / `OPENAI_API_KEY`).
3. Legacy single-key setups (`settings.aiApiKey` + `settings.aiProvider`)
   keep working — merged under the configured provider.

Today the shared env keys serve every site. Later, adding a dedicated key
to a site's `settings.aiKeys` (via the Settings API / panel — the
`aiKeys` field is accepted by `PUT /api/settings`) plugs in with **zero
code changes**: that provider switches to the dedicated key on the next
request.

### Firestore rules requirement (final rules deploy)

`settings` docs are tenant-readable in `firestore.rules`. `aiKeys` must
NEVER be client-readable. The final rules deploy MUST add a field-level
deny, e.g. inside `match /settings/{docId}`:

```
// REQUIRED: per-site AI provider keys are Admin-SDK-only.
// Client reads of settings must not expose aiKeys.
allow get, list: if tenantRead() && !("aiKeys" in request.resource.data)
    … (or) deny aiKeys in client reads explicitly —
```

Simplest compliant options: (a) field-level rule blocking `aiKeys` on
all client paths, or (b) move `aiKeys` to a separate `settingsSecrets/{businessId}`
collection with `allow read, write: if false` (Admin SDK bypasses rules).
Until the final deploy, all reads of `aiKeys` in this codebase go through
the Admin SDK (`@/lib/prisma` / `getUnscopedPrisma()`), which is not
subject to these rules — so nothing leaks.

## Examples

**Generate (tool copy):**
```bash
curl -X POST https://ai.ridebangla.bd/api/public/ai/generate \
  -H 'Content-Type: application/json' \
  -d '{
    "siteKey": "rbsite-…",
    "task": "generate",
    "callerId": "tools:paraphraser",
    "input": { "prompt": "Paraphrase in a friendly tone: …" },
    "maxTokens": 500
  }'
```

**Chat with a pinned provider (per-provider test):**
```bash
curl -X POST https://ai.ridebangla.bd/api/public/ai/generate \
  -H 'Content-Type: application/json' \
  -d '{
    "siteKey": "rbsite-…",
    "task": "generate",
    "provider": "gemini",
    "input": { "prompt": "Say hello in one sentence." }
  }'
```

## Notes for sibling-site implementers

- Never accept a provider API key from the user for passthrough — always
  use this endpoint.
- Send a distinct `callerId` per tool so one abusive tool cannot exhaust
  another tool's bucket (buckets are per siteKey+callerId).
- Handle `aiConfigured: false` and 402/429/502 with honest UI states.
- Do not retry 502 in a tight loop — the reason is included; back off.
