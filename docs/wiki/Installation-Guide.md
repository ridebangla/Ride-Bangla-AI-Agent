# Installation Guide

This guide covers everything you need to install and run Ride Bangla AI Agent on your machine, whether you prefer Docker Compose (recommended for production) or a manual npm-based setup for development.

---

## Prerequisites

Before installing Ride Bangla AI Agent, make sure you have the following:

| Requirement | Minimum Version | Notes |
|-------------|----------------|-------|
| **Node.js** | 20.0+ | Required for npm-based setup. Check with `node -v` |
| **Firebase project** | Firestore enabled | Database (no local install needed) |
| **npm** | 10.0+ | Comes with Node.js. Check with `npm -v` |
| **Git** | 2.0+ | For cloning the repository |
| **Docker** (optional) | 24.0+ | Required only for Docker Compose setup |
| **Docker Compose** (optional) | 2.20+ | Required only for Docker Compose setup |

### Optional Dependencies

- **Puppeteer/Chromium dependencies** -- Required only if you plan to use the WhatsApp Web channel (QR code scan method). See the [Troubleshooting](#troubleshooting) section for OS-specific packages.

---

## Option 1: Docker Compose (Recommended)

Docker Compose is the simplest way to run Ride Bangla AI Agent. It builds the application container and reads your Firebase credentials from `.env` (Firestore itself runs in your Firebase project — no database container needed).

### Step 1: Clone the Repository

```bash
git clone https://github.com/ridebangla/Ride-Bangla-AI-Agent.git
cd ride-bangla-ai-agent
```

### Step 2: Configure Environment Variables

Copy the example environment file and edit it with your values:

```bash
cp .env.example .env
```

Open `.env` in your editor and configure the required variables. See the [Environment Variables](#environment-variables) section below for a complete reference.

At minimum, you need to set:

```bash
JWT_SECRET="a-random-secret-string-at-least-32-chars"
NEXTAUTH_SECRET="another-random-secret-string"
```

The Firebase credentials come from your `.env` file (see below) — no database container is needed.

### Step 3: Start the Services

```bash
docker compose up -d
```

This starts the service:

- **app** -- Ride Bangla AI Agent application on port 3000

### Step 4: Open the Application

Navigate to `http://localhost:3000` in your browser. You will be redirected to the [Setup Wizard](Setup-Wizard) on first launch.

### Stopping and Restarting

```bash
# Stop all services
docker compose down

# Stop and remove volumes (WARNING: deletes database data)
docker compose down -v

# Restart
docker compose up -d

# View logs
docker compose logs -f app
```

---

## Option 2: Manual Setup (npm)

Use this method for development or if you prefer to run Node.js directly.

### Step 1: Clone the Repository

```bash
git clone https://github.com/ridebangla/Ride-Bangla-AI-Agent.git
cd ride-bangla-ai-agent
```

### Step 2: Install Dependencies

```bash
npm install
```

### Step 3: Configure Environment Variables

```bash
cp .env.example .env
```

Edit `.env` and set your Firebase service-account credentials:

```bash
# Required: Firebase service-account credentials (Firestore)
FIREBASE_PROJECT_ID="your-firebase-project-id"
FIREBASE_CLIENT_EMAIL="firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com"
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

Also set your secret keys:

```bash
JWT_SECRET="a-random-secret-string-at-least-32-chars"
NEXTAUTH_SECRET="another-random-secret-string"
```

### Step 4: Enable Firestore

In the Firebase console, open your project and enable **Firestore Database**
(Native mode). No tables or migrations are needed — collections are created
on first write.

### Step 5: Seed the database

```bash
npm run db:seed
```

Firestore is schemaless — there are no migrations. This creates the default business, the Super Admin, and the knowledge base.

### Step 6: (Optional) Seed Demo Data

If you want to populate the database with sample data for testing:

```bash
npm run db:seed
```

### Step 7: Start the Development Server

```bash
npm run dev
```

The application will be available at `http://localhost:3000`.

### Building for Production

```bash
npm run build
npm start
```

---

## Environment Variables

The following table describes all environment variables in `.env.example`:

| Variable | Required | Description |
|----------|----------|-------------|
| `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` | Yes | Firebase service-account credentials (Firestore). |
| `JWT_SECRET` | Yes | Secret key for signing JWT authentication tokens. Use a random string of at least 32 characters. |
| `NEXTAUTH_SECRET` | Yes | Secret for NextAuth session encryption. Use a different random string from `JWT_SECRET`. |
| `NEXT_PUBLIC_APP_URL` | No | Public URL of your Ride Bangla AI Agent instance. Defaults to `http://localhost:3000`. Set this to your domain in production. |
| `OPENAI_API_KEY` | No | OpenAI API key. Can also be configured later through the Setup Wizard or Settings page. |
| `ELEVENLABS_API_KEY` | No | ElevenLabs API key for phone channel voice synthesis (text-to-speech). |
| `TWILIO_ACCOUNT_SID` | No | Twilio Account SID for the phone channel. |
| `TWILIO_AUTH_TOKEN` | No | Twilio Auth Token for the phone channel. |
| `TWILIO_PHONE_NUMBER` | No | Your Twilio phone number in E.164 format (e.g., `+1234567890`). |

**Notes:**

- The AI API key (`OPENAI_API_KEY`) can be set here or through the web UI at Settings. The web UI setting takes precedence.
- Twilio and ElevenLabs keys are only required if you plan to use the Phone channel.
- For production, always use strong, unique values for `JWT_SECRET` and `NEXTAUTH_SECRET`.

---

## Verifying the Installation

After starting Ride Bangla AI Agent, verify that everything is working:

1. **Health check endpoint:** Open `http://localhost:3000/api/health` in your browser or run:

   ```bash
   curl http://localhost:3000/api/health
   ```

   A successful response returns `{ "status": "ok" }`.

2. **Setup wizard:** Navigate to `http://localhost:3000`. On first launch you will be redirected to the setup wizard at `/setup`.

3. **Database connection:** If you see a database connection error, check that Firestore is enabled and your Firebase service-account credentials are correct.

---

## Troubleshooting

### Port 3000 Already in Use

If another application is using port 3000:

```bash
# Find what is using port 3000
lsof -i :3000

# Kill the process
kill -9 <PID>
```

For Docker Compose, you can change the port mapping in `docker-compose.yml`:

```yaml
ports:
  - "8080:3000"  # Access Ride Bangla AI Agent at localhost:8080
```

### Database Connection Refused

Common causes and solutions:

1. **Firestore is not reachable:**
   ```bash
   # Check the app logs for the Firebase Admin SDK error
   docker compose logs app          # Docker
   ```

2. **Wrong credentials:** Verify `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY` in your `.env` file.

3. **Firestore not enabled:** Enable Firestore (Native mode) in the Firebase console for your project.

4. **Permission denied:** The service account needs the Cloud Datastore User role (or Owner) on the project.

### Firestore Errors

If writes fail, check the service-account credentials and Firestore permissions
(see "Database Connection Refused" above). The seed is idempotent — re-running
it is safe:

```bash
npm run db:seed
```

### WhatsApp Channel: Missing Puppeteer Dependencies

The WhatsApp Web integration uses Puppeteer, which requires a Chromium browser. On headless servers (Linux), you may need to install system-level dependencies.

**Debian/Ubuntu:**

```bash
sudo apt-get update
sudo apt-get install -y \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcups2 \
  libdbus-1-3 \
  libdrm2 \
  libgbm1 \
  libgtk-3-0 \
  libnspr4 \
  libnss3 \
  libx11-xcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  xdg-utils \
  fonts-liberation \
  libappindicator3-1
```

**Alpine (Docker):**

```bash
apk add --no-cache \
  chromium \
  nss \
  freetype \
  harfbuzz \
  ca-certificates \
  ttf-freefont
```

**macOS:** No additional dependencies are needed. Puppeteer downloads its own Chromium binary.

### Application Crashes on Startup

1. Check the logs:
   ```bash
   # Docker
   docker compose logs app

   # npm
   # Check terminal output for error messages
   ```

2. Ensure Node.js version is 20+:
   ```bash
   node -v
   ```

3. Clear node_modules and reinstall:
   ```bash
   rm -rf node_modules
   npm install
   ```

4. Re-run the seed (idempotent):
   ```bash
   npm run db:seed
   ```

---

## Successful Installation

Once everything is running, you should see the Ride Bangla AI Agent dashboard after completing the setup wizard:


From here, proceed to the [Setup Wizard](Setup-Wizard) guide to configure your admin account, business profile, and AI provider.

---

## Next Steps

- [Setup Wizard](Setup-Wizard) -- Complete first-run configuration
- [Quick Start Tutorial](Quick-Start-Tutorial) -- Get your first AI conversation in 5 minutes
- [Channel Setup](Channel-Setup) -- Connect WhatsApp, Email, or Phone
