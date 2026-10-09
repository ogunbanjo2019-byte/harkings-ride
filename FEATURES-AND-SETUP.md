# Harkingz backend update — setup and scope

## Install/use

1. Extract this archive into a new folder or a backup of your current backend.
2. Copy your own existing `.env` into the project root if needed. This archive intentionally does **not** include `.env`, Git history, or `node_modules`.
3. Install with `npm ci`, then run `npm test` and `npm run lint`.
4. The admin console is `/admin/`. Sign in, open **Fare pricing**, set the real tariff and cash surcharge, and save before production bookings. Production ride requests are rejected while the bootstrap tariff is still active.

## Included feature work

- Driver matching visibility and acceptance checks; rider/driver details and live driver location in ride payloads.
- Server-side fare estimates and fare locking. `estimatedFare` may still be accepted for compatibility but is ignored for pricing.
- Admin pricing API and dashboard editor: `GET/PUT /api/v1/admin/pricing`; new values affect new rides only. Fare/payment reporting is available at `GET /api/v1/admin/pricing/report`, and admin promotion management is under `/api/v1/admin/promotions`.
- Cancellation grace/fee rules from the supplied notes, driver cancellation/re-matching, pending cancellation fee records, and automatic request expiry.
- Payment status read, delayed driver earnings until successful online payment or cash confirmation, rider wallet balance/top-up/transfer, and saved Paystack reusable-card references.
- Rider safety contacts/SOS, profile edits, NIN/selfie submission for manual review, trip-share API/public tracking page, promo validation, saved places, notification read/FCM token, support-ticket messages, and account deletion request.
- Phone OTP is implemented for Twilio but disabled unless server-side Twilio settings are configured.
- Realtime ride events include `ride.accepted`, `ride.arrived`, `ride.in_progress`, `ride.completed`, `ride.cancelled`, `ride.requested`, `ride.sos`, and `ride.payment_successful`. Normal clients use `Authorization: Bearer <accessToken>`. Browser EventSource clients should POST `/api/v1/realtime/stream-token` with `{rideId}` using Bearer auth, then open the returned `eventsUrl`; its ticket expires in 60 seconds and is one-use.

## Values and integrations that must be confirmed/configured

- The initial base/per-km/per-minute/minimum values mirror mobile placeholders: **₦300 / ₦120 per km / ₦15 per minute / ₦500 minimum**. The **cash surcharge starts at ₦0 because no real value was supplied**. Set the actual tariff and surcharge in the admin dashboard before production.
- Distance is currently a straight-line estimate and duration is estimated at 30 km/h. A routing provider is required for road distance/traffic-accurate production fares.
- The 4-minute cancellation grace and ₦200 fee are from the supplied app notes and should be confirmed by the business. Request expiry defaults to 5 minutes and can be set with `RIDE_REQUEST_TIMEOUT_MINUTES`.
- Phone OTP requires `SMS_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER` in the host environment. Do not commit real values.
- Rider NIN/selfie is stored as a pending manual-review check; BVN integration is not included, and NIN is not verified against a government/provider database; this code does **not** claim to verify a NIN against a government/provider database. Admin review must approve it. Night/distance identity restrictions from the notes are not enforced until the real business rule is confirmed.
- Saved cards store only a reusable authorization from a successful Paystack verification; raw card number/CVV are never accepted or stored. Paystack credentials are required.
- Account deletion records a request and blocks further authentication; it does not immediately purge retained legal/financial records. Implement a retention/purge process with the business/legal owner.

## Important

The original `.env` contained private configuration and was deliberately excluded. Preserve your local credentials separately. Review `FEATURES-AND-SETUP.md` and test in staging before production deployment.
