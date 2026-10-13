# Super Cleaners Detailing — Owned Booking System (Phase 1)

A dependency-light Express app that replaces third-party schedulers with a
booking **request** system John owns outright. Customers pick a package, a
vehicle size, their details, and a real open time slot (7 AM–7 PM), choose
how they'll pay **after** the detail, and submit a request. Nothing is ever
auto-confirmed: John reviews each request, creates the Square appointment
himself, and sends the confirmation text personally.

- **Booking window:** 7:00 AM – 7:00 PM (America/Los_Angeles). After-hours
  is phone-only: call (661) 376-5857, $50 emergency call-out fee, card on
  file required. (The public website's 24/7 hours are separate and are NOT
  part of this app.)
- **No prepayment, ever.** Payment methods: card on file (charged after the
  detail), Venmo, Zelle, or cash. First-time card payers must save a card;
  returning card payers may opt out; Venmo/Zelle/Cash are always allowed.
- **Availability:** Google Calendar free/busy behind a provider interface,
  with a dev/manual JSON busy-block provider so the app runs with zero
  credentials. Slot length matches the package duration.
- **Storage:** MySQL when `DB_*` env vars are set (schema from the spec:
  customers / vehicles / appointments / message_log); otherwise booking
  requests append to a local JSON file.
- **Notifications:** John is notified instantly by email (SMTP) and/or SMS
  (Twilio) — both env-gated. With no credentials, the would-be notification
  is written to the server log instead.
- **SMS compliance:** the form implements the A2P consent block exactly —
  phone field, two separate unchecked consent checkboxes (transactional +
  marketing) with message-type descriptions, frequency info, "Msg & data
  rates may apply", HELP/STOP instructions, Privacy Policy / Terms links,
  and a distinct terms-agreement checkbox.

## Running locally

```bash
npm install
npm start            # http://localhost:3000
curl localhost:3000/health
```

With no env vars at all, the app serves the form, computes slots from an
empty calendar, stores requests in `data/bookings.json`, and logs John's
notifications to the console — a complete dev loop.

## Environment variables

| Variable | Purpose |
|---|---|
| `PORT` | Port to listen on. Hostinger sets this automatically. |
| `BUSINESS_TIMEZONE` | Business timezone for the booking window. Default `America/Los_Angeles`. |
| `BUSINESS_PHONE_DISPLAY` / `BUSINESS_PHONE_DIGITS` | Phone shown in customer copy / error messages. Default (661) 376-5857. |
| `MIN_LEAD_MINUTES` | Earliest start time = now + this many minutes. Default 120. |
| `MAX_ADVANCE_DAYS` | How far out customers can request. Default 60. |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | MySQL connection. All of host/user/name required to enable MySQL; tables are auto-created. If unset (or MySQL fails), the JSON file store is used. |
| `DATA_DIR` | Directory for the JSON fallback store. Default `./data`. |
| `GOOGLE_CALENDAR_ID` | Calendar whose free/busy drives availability. Share it with the service account. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Service-account key JSON (raw or base64-encoded). |
| `GOOGLE_CLIENT_EMAIL` + `GOOGLE_PRIVATE_KEY` | Alternative to the JSON blob (use `\n` escapes in the key). |
| `DEV_BUSY_JSON` | JSON array of `{"start","end"}` ISO busy blocks. Used as the whole availability source when Google is unset, and layered on top of Google when set (manual blocks). A `data/dev-busy.json` file with the same shape also works. |
| `SQUARE_APPLICATION_ID` + `SQUARE_LOCATION_ID` | Enables the Square Web Payments SDK card form in the browser. |
| `SQUARE_ACCESS_TOKEN` | Enables server-side card-on-file storage via the Square Cards API. Card data never touches this server — the browser tokenizes. |
| `SQUARE_ENVIRONMENT` | `sandbox` (default) or `production`. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` | SMTP connection for John's email notifications. |
| `NOTIFY_EMAIL_FROM`, `NOTIFY_EMAIL_TO` | From address and John's inbox for new-request emails. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | Twilio credentials + sending number for John's SMS notifications. |
| `JOHN_NOTIFY_PHONE` | John's mobile (E.164) that receives the SMS notifications. |

See `.env.example` for a commented template.

## Hostinger deployment notes

- This repo deploys as a Hostinger **Node.js web app** (hPanel → Node.js):
  entry file `index.js`, start command `npm start`, Node 18+ (20/22 fine).
- Run `npm install` in the app root (hPanel does this on deploy). The only
  runtime dependencies are Express, body-parser, cors, mysql2, nodemailer.
- Set every production env var in the hPanel Node.js app's **environment
  variables** UI — never in code, never committed to git.
- `process.json` (PM2) is kept for hosts that use it; it points at
  `./index.js` with a single instance. Hostinger's own process manager
  ignores it harmlessly.
- **Storage on Hostinger:** prefer MySQL (`DB_*`) in production — the app
  directory can be redeployed from git, and the JSON fallback under
  `data/` may not survive every redeploy. MySQL tables are created
  automatically on first use.
- **Domain:** point `book.supercleanersdetailing.com` at this app once
  tested. The old `/book` flow stays live as a fallback until this system
  is proven (hide, never delete).
- **Verification after deploy:** `GET /health` reports which integrations
  are live (store backend, availability provider, Square, email, SMS).

## What Phase 1 deliberately does not do (per spec)

- No automatic confirmations, reminders cron, review requests, win-back,
  referral/loyalty tracking, or magic-link portal — those are Phase 2,
  built on this foundation (the `message_log` table and customer records
  are already in place).
- No Square Bookings API writes and no charges — John creates appointments
  and charges cards himself in Square.
- ZIP codes outside Kern County prefixes (932/933/935) are flagged in
  John's notification, never blocked.
