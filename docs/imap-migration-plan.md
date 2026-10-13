# L-20 — IMAP migration plan (`imap@0.8.19` → maintained library)

**Status: BLOCKED — plan only, migration NOT performed.**
**Reason:** `imap@0.8.19` is old and unmaintained, but there is **no confirmed CVE**
against it, and it sits on the live email-ingestion path (IMAP IDLE → unseen
search → fetch → AI reply). Rewriting it blind risks silently breaking email
replies. The migration needs a real test mailbox and operator verification
against the production mailbox (see "User steps" below). Do not migrate
without those.

## Current usage (verified 2026-10-13)

- `imap` is used in exactly **one** file: `src/lib/channels/email.ts`.
- API surface used: `new Imap({...})`, `imap.once("ready")`,
  `imap.openBox("INBOX", ...)`, `imap.on("mail")`,
  `imap.search(["UNSEEN"])`, `imap.fetch(results, { bodies: "" })`,
  `imap.once("error")`, `imap.once("end")`, `imap.connect()`.
- `mailparser` (`simpleParser`) parses fetched messages — it is maintained
  and **stays**; only the IMAP client changes.
- Dev dependency `@types/imap` goes away with `imap` (the replacement ships
  its own types).
- `nitro: latest` (also mentioned in L-20) is **not a dependency** of this
  repo (no `nitro` in `package.json`) — nothing to pin here.
- `whatsapp-web.js` / `puppeteer` transitive `tar-fs` / `ws` CVEs from L-20
  could not be confirmed for the installed versions — re-check with
  `npm audit` at migration time; not part of this plan.

## Pre-existing issue the migration MUST fix

`createImapConnection()` in `src/lib/channels/email.ts` sets:

```ts
tlsOptions: { rejectUnauthorized: false }
```

That disables TLS certificate verification for the IMAP connection (MITM
risk: credentials + email content to any impersonating server). The
replacement client must **not** carry this over — use default certificate
verification (`rejectUnauthorized: true` / library default) and only
relax it temporarily, behind an explicit env flag, if a specific provider's
certificate genuinely fails (document the provider + expiry).

## Library choice: `imapflow`

- Maintained, promise/async-iterator based, by the Nodemailer author
  (same ecosystem as the already-used `nodemailer` + `mailparser`).
- Supports IDLE, `mailboxOpen`, `search`, `fetch` with `source: true`,
  and TLS verification by default.
- Rejected alternatives: staying on `imap@0.8.19` (unmaintained);
  `emailjs-imap-client` (unmaintained); a hand-rolled raw-socket IMAP
  client (unnecessary risk).

## Migration steps

1. **Install / remove:**
   `npm install imapflow` then `npm uninstall imap @types/imap`.
   Pin the installed version in `package.json` (no floating ranges).
2. **Rewrite `src/lib/channels/email.ts` (only file touched):**
   - Replace `new Imap({...})` with `new ImapFlow({ host, port, secure: true,
     auth: { user, pass }, logger: false })`. No `rejectUnauthorized: false`.
   - Replace the event/callback flow with async/await:
     - `await client.connect()`, `await client.mailboxOpen("INBOX")`.
     - Initial sweep: `client.search({ seen: false })`, then
       `client.fetch(uid, { source: true })` and pass the source to
       `simpleParser` (unchanged).
     - Live mail: `client.on("exists", ...)` or `client.idle()` loop
       instead of `imap.on("mail")`; re-run the unseen sweep on wake.
     - Error/end handling: `try/catch` around the loop + reconnect with
       backoff; keep the existing `isListening` / `startEmailListener` /
       `stopEmailListener` / `getEmailStatus` API used by
       `src/app/api/channels/email/route.ts` (no route changes).
   - Keep `processEmail`, `getSmtpTransporter`, branding, and reply logic
     untouched.
3. **Tests:** extend the email-channel tests to cover connect → unseen
   sweep → fetch → parse → reply against a mocked `ImapFlow` client
   (mock the client, not the network). Add a test asserting no
   `rejectUnauthorized: false` anywhere in the file.
4. **Checks:** `npx tsc --noEmit`, `npx vitest run`, `npm run build`.
5. **Staged rollout:** deploy with the email listener off, verify with a
   test mailbox (send 3 test mails: plain text, HTML-only, attachment),
   confirm replies + no duplicate replies (IDLE re-delivery), then enable
   against the production mailbox and watch logs for one day.

## User steps to unblock (operator action)

1. Provision a **test mailbox** (any IMAP provider) and share its host /
   credentials with the implementer (via the approved credential flow —
   never in chat).
2. Approve a maintenance window: email replies may pause while the
   listener is swapped.
3. After the migration lands: send the 3 test mails above, confirm
   correct replies, then approve enabling the production mailbox.
