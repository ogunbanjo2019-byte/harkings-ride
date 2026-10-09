# Ride Platform Backend

MVP Node.js/Express API for a CNG e-hailing platform serving rider, driver, and admin clients. Production persistence uses **Supabase Postgres** through a server-side JSONB-backed `app_records` table.

## Quick start

```bash
cp .env.example .env
npm install
npm test
npm run lint
npm start
```

The API runs on `http://localhost:4000` by default. Health check: `GET /health`. Copy `.env.example` to `.env` for local setup. The template uses in-memory development data, manual identity review, and preview-only notifications. Email OTP works with configured email delivery. Optional phone OTP uses Twilio when server-side SMS credentials are configured; otherwise the API returns SMS_PROVIDER_NOT_CONFIGURED. Local/test email responses include a development OTP for testing. Configure an email provider for real delivery. Keep `.env` private and ignored by Git. For production, set secrets in Render's Environment settings instead of uploading `.env`. Apply the current [`SUPABASE_SCHEMA.sql`](./SUPABASE_SCHEMA.sql) in the Supabase SQL Editor; if upgrading an existing installation, re-run it to add the atomic snapshot RPC. Then configure `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and a random `JWT_SECRET` of at least 32 characters in production. Tests automatically use an in-memory provider.

The separate driver liveness client is in [`face-liveness-client/`](./face-liveness-client/). Build it with `cd face-liveness-client && npm ci && npm run build`; see its README for public Cloudflare Pages settings.

The admin web console is served at `http://localhost:4000/admin/`. A demo admin is seeded only for local development when both `NODE_ENV=development` and `ALLOW_DEMO_ADMIN_SEED=true` are set. Never enable this outside local development; provision staging and production admins through a controlled process.

## Architecture

The project uses a feature-based Express structure under `src/modules`. Each module owns its routes and business logic. The repository keeps the existing in-process controller contract and flushes changes to Supabase after API responses.

Core modules include authentication, drivers, verification, rides, payments, subscriptions, wallets, notifications, complaints, support, CNG, and admin operations.

## API

All public routes are versioned under `/api/v1`. Responses use:

```json
{"success": true, "message": "...", "data": {}, "error": null}
```

The driver frontend contract can be migrated to these canonical routes. Compatibility aliases are intentionally not added until the mobile team confirms the final contract.

## Driver capability routes

- **Approval:** the existing admin routes `PUT /api/v1/admin/drivers/:id/approve`, `reject`, and `suspend` update the driver gate used by `POST /api/v1/drivers/status`.
- **Verification:** `POST /api/v1/drivers/verification/nin`, `POST /api/v1/drivers/verification/document`, `POST /api/v1/drivers/verification/selfie`, `GET /api/v1/drivers/verification/status`.
- **AWS face verification:** `POST /api/v1/drivers/verification/face/session` creates a liveness session after explicit biometric consent and selection of a privately stored JPEG/PNG identity document; the driver client must complete the video capture with AWS Amplify `FaceLivenessDetector`; then `POST /api/v1/drivers/verification/face/complete` retrieves the liveness result and compares its reference image with the document. This does not approve the driver or replace document review. See [`FACE-LIVENESS.md`](./FACE-LIVENESS.md).
- **Safety:** `POST /api/v1/drivers/sos/trigger` with `tripId`, `latitude`, and `longitude`.
- **Subscription:** `GET /api/v1/drivers/subscription/status`, `history`, and `POST /api/v1/drivers/subscription/pay`. Manual references work only in local development/test; production safely rejects this route until verified provider settlement is implemented.
- **Wallet:** transactions, bank-account, withdraw, and withdrawals under `/api/v1/drivers/wallet`.
- **CNG:** log, history, summary, and unit-config under `/api/v1/drivers/cng`.
- **Daily verification:** `GET /api/v1/drivers/verification/daily-status` and multipart `POST /api/v1/drivers/verification/daily-check`.
- **Auth/app:** `POST /api/v1/auth/change-password`, `POST /api/v1/auth/send-otp`, `POST /api/v1/auth/verify-otp`, and public `GET /api/v1/app/version`.

Password reset is complete: `POST /api/v1/auth/forgot-password` creates a hashed, 30-minute, single-use token and sends a reset email; `POST /api/v1/auth/reset-password` consumes it. The reset page is served at `/reset-password`. Email notifications cover reset instructions, OTPs sent to email, payment receipts, password-change notices, and payout-status changes.

## Admin back-office

The admin console now includes executive metrics, driver clearance/document review, SOS response status, wallet payout review, dispatch radar data, CNG station summaries, audit logs, and authenticated CSV exports. The matching protected API routes are under `/api/v1/admin`.

Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to persist all app collections in Supabase. Set `PAYSTACK_SECRET_KEY` and optionally `PAYSTACK_CALLBACK_URL` to enable Paystack checkout initialization and server-side transaction verification for rider payments. Credentials are read only from the server environment and are never sent to the browser.

Set `EMAIL_PROVIDER=resend` with `RESEND_API_KEY`, or `EMAIL_PROVIDER=smtp` with `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, and `SMTP_PASSWORD`. With `EMAIL_PROVIDER=development`, messages are not sent; only delivery status metadata is recorded, and email recipients or message bodies are never stored in the email log. Real delivery requires `EMAIL_PROVIDER=resend` with `RESEND_API_KEY`, or a configured SMTP provider.

Authentication OTP is email-only. Phone OTP requests are rejected with `EMAIL_VERIFICATION_REQUIRED`; the frontend should ask users to verify by email. For real email delivery, configure `EMAIL_PROVIDER=resend` with `RESEND_API_KEY`, or configure SMTP. In development and tests, OTPs are previewed without sending real email.

Uploads validate MIME type and size, store sensitive files in a private Supabase Storage bucket, retain metadata only, and use short-lived signed URLs. OTP and password-reset secrets are hashed at rest, expire, are single-use, and have dedicated request rate limits. Only `development` and `test` responses include `developmentOtp`; production requires real email delivery.

## Production checklist

See [`DEPLOYMENT.md`](./DEPLOYMENT.md) for Render API deployment and Cloudflare Pages/DNS guidance. The included [`face-liveness-client`](./face-liveness-client/README.md) is a separate static driver client for Cloudflare Pages; the Node API stays on Render. Production still requires operator-owned provider accounts/credentials, verified email SPF/DKIM/DMARC, identity and payout configuration, monitoring, backups/restore drills, staging UAT, and a production deployment. This archive is not a Cloudflare Workers API application.
