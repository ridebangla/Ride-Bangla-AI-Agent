# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.2.x   | Yes       |
| 0.1.x   | Security fixes only |

## Security Features

Ride Bangla AI Agent includes the following security measures out of the box:

- **JWT authentication** with httpOnly, secure, sameSite cookies
- **bcrypt password hashing** with 12 salt rounds
- **Rate limiting** on auth (5 req/min) and API (60 req/min) endpoints
- **Input validation** via Zod schemas on all API request bodies
- **Security headers**: X-Content-Type-Options, X-Frame-Options, X-XSS-Protection, Referrer-Policy, Permissions-Policy
- **Secret masking** in API responses (API keys, passwords, tokens replaced with `***`)
- **XSS protection** via HTML entity escaping in email templates
- **CRLF injection prevention** in email subject lines
- **Webhook signatures** using HMAC-SHA256 (`X-RBAI-Signature` header)
- **Request ID tracking** for audit trail (`X-Request-Id` header)
- **Non-root Docker container** (UID 1001)
- **Structured logging** (no secrets in log output)

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please send an email to the maintainers or use [GitHub's private vulnerability reporting](https://github.com/ridebangla/Ride-Bangla-AI-Agent/security/advisories/new).

### What to include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response timeline

- **Acknowledgment:** Within 48 hours
- **Initial assessment:** Within 1 week
- **Fix and disclosure:** Coordinated with reporter

## Security Best Practices for Deployment

- Set a strong `JWT_SECRET` (use `openssl rand -hex 32`)
- Set a strong `WEBHOOK_SECRET` for webhook payload verification
- Use HTTPS in production (reverse proxy with Nginx/Caddy, or Ingress with TLS in Kubernetes)
- Never commit `.env` files to version control
- Regularly update dependencies (`npm audit`)
- Restrict database access to localhost or trusted IPs
- Use strong passwords for the admin account
- Set `CORS_ORIGIN` to your frontend domain (do not use `*` in production)
- Monitor the `/api/health` endpoint for service degradation
- Review the activity log (`/api/activity`) for suspicious access patterns
