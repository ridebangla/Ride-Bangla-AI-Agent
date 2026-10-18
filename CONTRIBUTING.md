# Contributing to Ride Bangla AI Agent

Thanks for your interest in contributing to Ride Bangla AI Agent! This guide will help you get started.

## Development Setup

```bash
# Clone the repo
git clone https://github.com/ridebangla/Ride-Bangla-AI-Agent.git
cd ride-bangla-ai-agent

# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env with your PostgreSQL connection string

# Run database migrations
npx prisma migrate dev

# Start dev server
npm run dev
```

## Code Style

- **TypeScript** for all code
- **Tailwind CSS** for styling with the Ride Bangla AI Agent custom color system (`rbai-primary`, `rbai-surface`, etc.)
- **Conventional commits**: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`
- **Zod validation** on all API request bodies (`src/lib/validations.ts`)
- **Structured logging** via `logger` from `src/lib/logger.ts` (never use `console.log`/`console.error`)
- **Pagination** on all list endpoints using `parsePagination` and `paginatedResponse` from `src/lib/pagination.ts`
- **Error responses** using `AppError` and `Errors` factory from `src/lib/errors.ts`
- No emojis in code, commits, or UI text
- All UI text in English

## Available Scripts

```bash
npm run dev          # Start development server
npm run build        # Production build
npm run lint         # Run ESLint
npm run test         # Run all tests (Vitest)
npm run test:watch   # Run tests in watch mode
npm run test:coverage # Run tests with coverage report
npm run db:seed      # Seed sample data
npm run db:migrate   # Run database migrations
npm run db:studio    # Open Prisma Studio
```

## Project Structure

```
src/
  app/
    (auth)/          # Login, setup wizard
    (dashboard)/     # Dashboard pages
    api/             # REST API routes (60+ endpoints)
  components/
    layout/          # Sidebar, header
    ui/              # Reusable components
  lib/
    ai/              # AI engine, tools
    channels/        # WhatsApp, email, phone
    customer-resolver.ts  # Cross-channel identity resolution
    errors.ts        # Standardized error responses
    logger.ts        # Structured logging
    pagination.ts    # Shared pagination helper
    rate-limit.ts    # Rate limiting
    security.ts      # XSS/CRLF protection
    validations.ts   # Zod input schemas
    webhook-delivery.ts  # Webhook retry + HMAC signatures
    hooks/           # React hooks
tests/
  unit/              # Unit tests
  api/               # API route tests
  security/          # Security tests
helm/ride-bangla-ai-agent/           # Kubernetes Helm chart
```

## Writing Tests

All new features must include tests. We use [Vitest](https://vitest.dev/) with mocked Prisma and external services.

```bash
# Run all tests
npm run test

# Run a specific test file
npx vitest run tests/unit/customer-resolver.test.ts
```

Test files go in `tests/` matching the source structure:
- `tests/unit/` for library functions
- `tests/api/` for API route handlers
- `tests/security/` for security-focused tests

## Pull Request Process

1. Fork the repo and create a branch from `main`
2. Make your changes following the code style above
3. Run `npm run test` and ensure all tests pass
4. Run `npm run lint` and fix any errors
5. Run `npx tsc --noEmit` for type checking
6. Write a clear PR description explaining what and why
7. Submit the PR

## Reporting Issues

Use [GitHub Issues](https://github.com/ridebangla/Ride-Bangla-AI-Agent/issues) with the appropriate template:
- **Bug Report** for something that's broken
- **Feature Request** for new ideas

## Need Help?

Open a [discussion](https://github.com/ridebangla/Ride-Bangla-AI-Agent/discussions) or check the [Wiki](https://github.com/ridebangla/Ride-Bangla-AI-Agent/wiki) for documentation.
