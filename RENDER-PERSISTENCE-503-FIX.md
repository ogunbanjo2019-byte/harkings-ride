# Fixing `503 PERSISTENCE_FAILED` on Render

## What the error means

The API attempted to save its application snapshot to Supabase and the save failed. The public response intentionally hides database internals. The exact underlying reason is in the Render service logs, usually next to `Database persistence failed:`. Common causes for this project are:

- the Supabase SQL setup was never applied to the project used by Render;
- the `replace_app_records_snapshot(jsonb)` RPC is missing or stale in Supabase's API schema cache;
- Render's `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` points to the wrong project or is invalid;
- the database role/function/table grants do not allow the service-role call;
- Supabase is temporarily unavailable or the request times out.

The attached screenshot alone cannot distinguish these causes. **Do not share the service-role key.**

## Step 1 — apply the database repair

1. Open the Supabase project that Render is configured to use.
2. Open **SQL Editor** and create a new query.
3. Copy the complete contents of `SUPABASE_PERSISTENCE_FIX.sql` from this folder into the editor and run it.
4. Confirm the query completes successfully. It is designed to be repeatable; it creates the `app_records` table if missing, grants the server role access, and installs the atomic `replace_app_records_snapshot(p_rows jsonb)` function.
5. Do not run this against a different Supabase project than the one whose URL is configured in Render.

The full `SUPABASE_SCHEMA.sql` is also included for a new Supabase setup, including the private document-storage bucket and its policy. The smaller repair SQL is the targeted step for this persistence error.

## Step 2 — check Render environment and logs

In **Render → backend Web Service → Environment**, confirm `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are present and belong to the same Supabase project. Save/redeploy if a value changes. Keep the service-role key server-side only; never put it in Vercel or a frontend `.env`.

In **Render → Logs**, find the `Database persistence failed:` entry at the same timestamp as the failed Thunder Client request. If the SQL repair does not resolve it, use the exact safe error text from that log to diagnose the remaining problem. Never paste secrets into support messages.

## Step 3 — verify in Thunder Client

After the SQL has run and the Render deployment is healthy:

1. Call `GET https://harkings-ride-2.onrender.com/health`; expect HTTP 200 and `database: "supabase"`.
2. Use a registered test account with `POST https://harkings-ride-2.onrender.com/api/v1/auth/login` and JSON `{ "email": "your-test-account@example.com", "password": "your-test-password" }`.
3. A successful login should return HTTP 200 with an access token. Then call `GET https://harkings-ride-2.onrender.com/api/v1/auth/me` with `Authorization: Bearer <token>`; expect HTTP 200.
4. Test registration only with a disposable test identity if required. A `201` response confirms the new record was durably written; then verify that identity can log in.

Do not repeatedly retry `POST /auth/register` after a 503 until checking whether the record was saved. Confirm in the app/database first to avoid duplicate test accounts.

## Code changes included

- Login, logout, and refresh-token requests no longer trigger an unnecessary full-database snapshot write. Login can therefore give a real credential result instead of being replaced by a persistence error.
- State-changing requests still require a successful save and still return `503 PERSISTENCE_FAILED` if durable persistence is unavailable.
- CORS now validates the allowlist and returns only the requesting Vercel origin, rather than a combined list. Set Render `CORS_ORIGIN` to the exact origins, comma-separated with no paths or trailing slashes:

```text
https://switchride-driver-app.vercel.app,https://switchride-rider-app-sihq.vercel.app
```

If the admin frontend uses a separate Vercel domain, add that exact origin as a third comma-separated value.

## Security notice about the original ZIP

The ZIP supplied for this repair included a local `.env` file containing credential fields (including Supabase, JWT, email, AWS, and Paystack secrets). This repaired ZIP deliberately excludes `.env`, `.git`, and `node_modules`. **Do not forward the original ZIP. If those values are real or were used in production, rotate/revoke them in their respective provider dashboards and update Render with the new server-side values.**
