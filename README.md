# Ride Bangla AI Agent

**Ride Bangla AI Agent** is a self-hosted AI customer-support agent for Ride Bangla (ridebangla.bd). Connect WhatsApp, Email, and Phone channels, and let the AI handle customer inquiries in **Bengali and English**, 24/7.

> Small-scale deployment. Forked from [Hesper-Labs/owly](https://github.com/Hesper-Labs/owly) and rebranded for Ride Bangla.

---

## What it does

- **Multi-channel inbox** — WhatsApp, Telegram, SMS, Email, and Phone (Twilio) from one dashboard
- **Bilingual AI replies** — automatically replies in the customer's language (Bengali বাংলা or English)
- **Ride Bangla knowledge** — pre-loaded with real facts: services, Faridpur coverage, distance-based fares (no public rate chart — the agent never quotes figures), contact numbers
- **Customer memory** — unified profile across channels with full conversation history
- **Human handoff** — creates tickets and escalates to the team when the AI can't help
- **Guardrails** — sentiment analysis, intent detection, human-approval for sensitive replies

## What it does NOT do (yet)

- No automatic order booking — the agent answers questions and creates tickets; orders still go through the Ride Bangla app
- WhatsApp/Facebook/Instagram need their own API credentials (see Configuration)
- Logo: `public/rbai-logo.png` — the Ride Bangla AI Agent mark (used as app icon and favicon)

---

## Requirements

| Requirement | Why |
|---|---|
| Node.js 20+ | Runtime |
| Firebase project (Firestore enabled) | Database (conversations, knowledge base, settings) |
| OpenAI API key | AI replies (`OPENAI_API_KEY`) |
| (Optional) Twilio account | Phone/SMS channel |
| (Optional) ElevenLabs API key | Voice replies on phone calls |

## Quick start

```bash
# 1. Clone
git clone https://github.com/ridebangla/Ride-Bangla-AI-Agent.git
cd Ride-Bangla-AI-Agent

# 2. Install
npm install

# 3. Configure
cp .env.example .env
# Edit .env — at minimum set:
#   FIREBASE_PROJECT_ID="your-firebase-project-id"
#   FIREBASE_CLIENT_EMAIL="firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com"
#   FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
#   JWT_SECRET="a-random-32-character-string"
#   OPENAI_API_KEY="sk-..."

# 4. Seed the database (Firestore is schemaless — no migrations needed)
npm run db:seed               # loads Ride Bangla knowledge base + default admin

# 5. Run
npm run dev                   # http://localhost:3000
```

Default admin login: username `admin`, password `admin123` — **change this immediately** in production.

## Production

```bash
npm run build
npm start
```

Or with Docker:

```bash
docker compose up --build
```

## Configuration

All settings live in `.env` (see `.env.example`). The essentials:

| Variable | Required | Purpose |
|---|---|---|
| `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` | Yes | Firebase service-account credentials (Firestore) |
| `JWT_SECRET` | Yes | Session signing (32+ random chars) |
| `OPENAI_API_KEY` | Yes | AI-powered replies |
| `NEXT_PUBLIC_APP_URL` | Yes | Public URL (webhooks/callbacks) |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_PHONE_NUMBER` | No | Phone + SMS channel |
| `ELEVENLABS_API_KEY` | No | Voice synthesis for calls |
| `WEBHOOK_SECRET` | Recommended | HMAC signing for outbound webhooks |

Business knowledge (services, fares, coverage) is managed in the dashboard under **Knowledge Base**, and seeded from `prisma/seed.ts`.

## Project structure

```
src/
  app/            # Next.js pages + API routes
  lib/ai/         # AI engine, system prompt, tools, guardrails
  lib/channels/   # WhatsApp, Telegram, SMS, Email, Phone
  lib/i18n/       # UI translations
prisma/
  schema.prisma   # Database schema
  seed.ts         # Ride Bangla knowledge base + defaults
tests/            # 365 automated tests (vitest)
```

## Verification status

- TypeScript: clean (`npx tsc --noEmit`)
- Tests: 365/365 passing (`npm test`)
- Build: compiles cleanly (`npm run build`); needs `JWT_SECRET` set at build time

## License

MIT — see [LICENSE](LICENSE).
