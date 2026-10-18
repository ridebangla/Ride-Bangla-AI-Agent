# OPERATIONS — Ride Bangla AI Agent

Multi-tenant AI customer-service + social-automation platform. One deployment
serves many businesses; every business's data is strictly isolated.

## 1. Requirements

- Node.js 20+, PostgreSQL 14+, `ffmpeg` on the host (only needed for
  customer **video** messages — photo/voice work without it).
- Environment variables — copy `.env.example` to `.env` and fill in:

| Variable | Required for | Notes |
|---|---|---|
| `DATABASE_URL` | everything | Postgres connection string |
| `JWT_SECRET` | everything | 32+ random chars; also needed at build time |
| `OPENAI_API_KEY` | AI brain (fallback) | Per-business key in Settings overrides this |
| `CRON_SECRET` | scheduled jobs | `Authorization: Bearer <CRON_SECRET>` |
| `SOCIAL_TOKEN_KEY` | social automation | 64-char hex (32 bytes); `openssl rand -hex 32` |
| `WEBHOOK_SECRET` | outbound webhooks | HMAC-SHA256 (`X-RBAI-Signature`) |
| `NEXT_PUBLIC_APP_URL` | widget/links | Public URL of this deployment |

## 2. First-time setup

```bash
npm install
npx prisma migrate deploy   # applies all migrations incl. multi-tenancy
npm run db:seed              # creates business "Ride Bangla", super admin, settings, channels, knowledge base
npm run build && npm start
```

The seed prints the **widget site key** and creates the Super Admin:

- username `admin`, password `admin123` — **change it immediately** after first login.
- role `super_admin`, `businessId` null: the single Super Admin sees/manages every business.

Then: sign in → **Settings → AI Configuration** → paste the OpenAI API key
(stored per business, masked in responses). Without it the agent replies
"AI is not configured."

### Multi-tenancy model

- `Business` is the tenant root (`slug`, `siteKey`, `isActive`).
- Every tenant table has `businessId`; the exported Prisma client auto-scopes
  all queries to the ambient business (AsyncLocalStorage) and throws
  `TenantContextError` when no context is active — **fail-closed**.
- API routes: `requireAuth()` enters the business context. A business admin
  is pinned to their business; the Super Admin passes `?business=<slug>` to
  choose (auto-selected when exactly one business exists).
- Channel workers/webhooks (no HTTP session) call
  `resolveChannelBusiness()` — single-business deployments resolve
  automatically; multi-business deployments **must** register webhooks with
  `?business=<slug>` or the event is rejected (never guessed).
- New businesses: Super Admin only — `POST /api/businesses` (name) or the
  dashboard. Each gets settings, business hours, and channel rows.

## 3. Connecting a channel (core loop: incoming → brain → reply)

### Website chat widget (fastest end-to-end test)

1. Channels page → **Website Widget** card → copy the embed snippet (contains
   your public `siteKey`).
2. Paste into any website. Visitors chat via `POST /api/chat/widget`
   (siteKey auth, 20 req/min per visitor, photo attach supported).
3. Conversations appear in the dashboard; the agent answers from the knowledge
   base + catalog.

### WhatsApp

1. Channels → WhatsApp → **Connect** (or `POST /api/channels/whatsapp`
   `{"action":"connect"}`).
2. Scan the QR code shown in the dashboard with the business phone.
3. Inbound messages → `chat()` → AI reply → auto-sent back. Photos, videos
   and voice notes go through the multimodal pipeline (see §6).

### Telegram

1. Create a bot with @BotFather → token.
2. Settings → paste **Bot token** and generate a **webhook secret**.
3. Channels → Telegram → Connect, or call `setupTelegramWebhook()`; register:
   `https://api.telegram.org/bot<token>/setWebhook?url=<app>/api/channels/telegram/webhook?business=<slug>&secret_token=<secret>`
4. Inbound updates are verified by `X-Telegram-Bot-Api-Secret-Token`
   (fail-closed: no secret → all updates rejected).

### SMS / Phone (Twilio)

Settings → Twilio SID/token/phone → Channels → connect. Voice uses
ElevenLabs for speech synthesis; inbound speech is transcribed and answered
by the brain.

### Email (IMAP/SMTP)

Settings → IMAP/SMTP credentials → Channels → Email → Connect starts the
IMAP listener; replies go out via SMTP.

## 4. Scheduled jobs (cron)

All accept `Authorization: Bearer <CRON_SECRET>` (or an admin session):

| Endpoint | What it does | Suggested schedule |
|---|---|---|
| `POST /api/followups/process` | Delivers due follow-ups (from the `schedule_followup` AI tool) via each conversation's channel | every 5 min |
| `POST /api/social/process` | Publishes due scheduled posts (generates text + AI image, posts to FB/IG/X) | every 5–15 min |
| `POST /api/social/engagement/sync` | Pulls comments/messages, auto-replies to every new one, records interactions | every 10 min |
| `POST /api/agent/commands/process` | Executes one queued admin command | every minute |

## 5. Product catalog (pluggable, tenant-configurable)

Ride Bangla has no own production yet — the catalog ships **empty-but-wired**:
models + retrieval + presentation + alternative-suggestion logic are real.

Schema:
- `ProductCategory` (`businessId`, `name`, `description`)
- `Product` (`businessId`, `categoryId?`, `name`, `description`, `price?`,
  `currency` default `BDT`, `imageUrl`, `tags` comma-separated,
  `isAvailable`, `metadata` JSON)

Admin API (`knowledge:update` permission):
- `GET /api/catalog` — categories with products
- `POST /api/catalog` — `{"kind":"category","name",...}` or
  `{"kind":"product","name","price","tags","categoryId","isAvailable",...}`
- `PUT /api/catalog/[id]`, `DELETE /api/catalog/[id]?kind=product|category`

Brain behavior:
- `search_catalog` tool: keyword search over available products (name,
  description, tags, category).
- `recommend_alternative` tool: graceful redirect when the customer asks for
  something unavailable — returns closest available items, never invents.
- The system prompt includes a live catalog brief + the
  UNAVAILABLE-PRODUCT RULE (acknowledge → honest "not available" → 1–3 real
  alternatives → offer team contact).
- `take_order` tool: persists orders as high-priority tickets with structured
  metadata (`serviceType`, `pickup`, `dropoff`, `details`, contact) — visible
  and actionable in the dashboard Tickets view.

## 6. Multimodal pipeline (real, not stubs)

`src/lib/ai/media.ts` — perception-first: media is understood into text,
then the brain answers.

| Input | Path | Model / API needed |
|---|---|---|
| Photo | Vision describe → identifies objects / product category (catalog-aware when the catalog is filled) | OpenAI vision model — business's `aiModel` if vision-capable, else `gpt-4o-mini` |
| Video | `ffmpeg` extracts 3 frames (start/mid/end) → vision per frame → synthesis | Same vision model **+ `ffmpeg` installed on host** |
| Voice | Transcription → brain answers the transcript | OpenAI `whisper-1` |

Wired in: WhatsApp (image/video/voice), Telegram (photo/voice/video),
website widget (photo attach). If perception fails, the agent says so
honestly and continues with the text.

## 7. Intent understanding + retention

`src/lib/ai/intent.ts`:
- `classifyIntent()` — bilingual (EN/BN) classifier; cancellation, complaint
  and human-handoff intents are **strong** (never misread as orders).
- `getIntentGuidance()` — per-intent strategy injected into the system prompt.
- `RETENTION_DOCTRINE` — 100% effort to keep the customer: warm, human,
  persuasive, never cold; never walk away empty-handed — always offer the
  next-best path (alternative, ticket, callback, human).

## 8. Social automation

Dashboard → **Social** page (or the API):

1. **Connect accounts**: Social → add account (platform `facebook` |
   `instagram` | `x`, label, account ref = Page ID / IG user ID, token).
   Tokens are AES-256-GCM encrypted (`SOCIAL_TOKEN_KEY`).
2. **Posting schedule** (admin-provided, configurable — nothing hardcoded):
   `POST /api/social/scheduled-posts`
   `{"platform","postType":"promo","topic":"Eid offer","scheduledAt":"<ISO future>"}`
   The `process` cron generates text (OpenAI, grounded in knowledge base +
   website content + audience brief) and an AI promo image
   (`openai.images.generate`, model `gpt-image-1`), then publishes.
   Instagram requires a **public image URL** — bytes-only posts throw an
   honest error (Meta limitation, not a bug).
3. **Every comment/message gets a reply**: the `engagement/sync` cron pulls
   new comments/messages, generates a polite natural reply, posts it, and
   records the interaction (`SocialInteraction`: which comment, which
   message, likes) — the customer memory.
4. **Audience intelligence**: `POST /api/social/audience/analyze` aggregates
   engagement into per-platform `AudienceProfile` rows — top topics, best
   posting hours, common questions — which the content generator uses to
   adapt topics/tone/timing. It improves over time; nothing is hardcoded.
5. **Command queue**: `POST /api/agent/commands {"command":"..."}` → the
   `commands/process` cron executes it with real tools (schedule posts,
   publish now, sync engagement, audience summary).

## 9. External setup still needed (exact list)

| Service | Needed for | Status in code |
|---|---|---|
| PostgreSQL database | everything | code ready; operator provisions |
| OpenAI API key | brain, vision, Whisper, post text, promo images | code ready; key in Settings |
| `ffmpeg` on host | customer video messages | code ready; install on server |
| Meta app + Facebook Page token | FB posting, comment/message sync | code ready; operator creates app, passes review |
| Instagram business account + token | IG posting/replies | code ready; **image posts need a public image URL** |
| X (Twitter) API — paid tier with write | X posting, mention sync | code ready; free tier cannot post |
| WhatsApp session | WhatsApp channel | QR scan in dashboard (whatsapp-web.js, unofficial) |
| Telegram bot token + webhook secret | Telegram channel | code ready; @BotFather |
| Twilio (SMS/voice) + ElevenLabs | SMS/phone channels | code ready; paid accounts |
| SMTP/IMAP mailbox | email channel | code ready |
| hCaptcha keys | login captcha | optional; hooks in place |
| Cron scheduler | §4 endpoints | operator configures (any cron service) |
| `https://ridebangla.bd` reachable | website content grounding for posts | code tolerates 404s |

## 10. Security notes

- No plaintext secrets: API keys stored as SHA-256 hashes (shown once);
  social tokens AES-256-GCM; cookies `rbai-token`/`rbai-refresh` (httpOnly).
- Webhook signature renamed to `X-RBAI-Signature` (HMAC-SHA256).
- Tenant isolation is enforced in the data layer (fail-closed), not just UI.
- `npm test` (385 tests) covers auth, tenant isolation, tools, RBAC,
  webhooks, and injection resistance.
