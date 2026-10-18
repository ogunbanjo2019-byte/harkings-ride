import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.DATABASE_PROVIDER = 'memory';

const { default: app } = await import('../src/app.js');
const { connectDatabase, closeDatabase, db } = await import('../src/database/store.js');

await connectDatabase();

const reset = () => Object.values(db).forEach((items) => (items.length = 0));
const auth = (token) => ({ Authorization: `Bearer ${token}` });

const driver = async () =>
  (await request(app).post('/api/v1/auth/register').send({
    name: 'Feature Driver', email: 'driver-features@example.com',
    phone: '+234800000714', password: 'Password123!', role: 'driver', vehiclePlateNumber: 'TST-001AA'
  })).body.data;
const rider = async () =>
  (
    await request(app).post('/api/v1/auth/register').send({
      name: 'Feature Rider',
      email: 'features@example.com',
      phone: '+234800000712',
      password: 'Password123!',
      role: 'rider'
    })
  ).body.data;

before(async () => {});
beforeEach(reset);
after(async () => closeDatabase());

test('pricing estimate ignores client price inputs and uses tariff config', async () => {
  const u = await rider();
  const r = await request(app)
    .post('/api/v1/rides/fare-estimate')
    .set(auth(u.accessToken))
    .send({
      pickup: { latitude: 6.5, longitude: 3.3 },
      destination: { latitude: 6.6, longitude: 3.4 },
      paymentMethod: 'cash'
    });

  assert.equal(r.status, 200);
  assert.equal(r.body.data.currency, 'NGN');
  assert.ok(r.body.data.totalFare >= 500);
  assert.equal(r.body.data.pricingConfigurationRequired, true);
});

test('admin can update tariff and audit version increments', async () => {
  const jwt = (await import('jsonwebtoken')).default;
  const { env } = await import('../src/config/env.js');

  db.users.push({ id: 'admin-feature', role: 'admin', status: 'active' });
  const token = jwt.sign({ sub: 'admin-feature', role: 'admin' }, env.jwtSecret);

  const response = await request(app)
    .put('/api/v1/admin/pricing')
    .set(auth(token))
    .send({
      baseFare: 400,
      perKm: 100,
      perMinute: 10,
      minimumFare: 600,
      cashSurcharge: 100,
      nightSurcharge: 50
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.data.pricing.cashSurcharge, 100);
  assert.equal(response.body.data.pricing.version, 1);
});

test('safety contacts and rider profile routes work', async () => {
  const u = await rider();
  const contact = await request(app)
    .post('/api/v1/safety/contacts')
    .set(auth(u.accessToken))
    .send({ name: 'Emergency Person', phone: '+234800000713' });

  assert.equal(contact.status, 201);

  const profile = await request(app)
    .patch('/api/v1/users/me')
    .set(auth(u.accessToken))
    .send({ name: 'Updated Name' });

  assert.equal(profile.status, 200);
  assert.equal(profile.body.data.user.name, 'Updated Name');
});

test('account deletion is recorded as a request, not a destructive delete', async () => {
  const u = await rider();
  const response = await request(app)
    .delete('/api/v1/account')
    .set(auth(u.accessToken));

  assert.equal(response.status, 200);
  assert.equal(response.body.data.status, 'deletion_requested');
});

test('driver verification refresh reports canonical state and account close keeps records while revoking access', async () => {
  const user = await driver();
  const profile = await request(app).get('/api/v1/drivers/profile').set(auth(user.accessToken));
  const driverId = profile.body.data.driver.id;

  const initialStatus = await request(app).get('/api/v1/drivers/verification/status').set(auth(user.accessToken));
  assert.deepEqual(initialStatus.body.data, { status: 'not_started' });

  db.documents.push({ id: 'verification-status-document', driverId, status: 'pending' });
  const pendingStatus = await request(app).get('/api/v1/drivers/verification/status').set(auth(user.accessToken));
  assert.deepEqual(pendingStatus.body.data, { status: 'pending' });
  const jwt = (await import('jsonwebtoken')).default;
  const { env } = await import('../src/config/env.js');
  const adminId = 'verification-status-admin';
  db.users.push({ id: adminId, role: 'admin', status: 'active' });
  const adminToken = jwt.sign({ sub: adminId, role: 'admin' }, env.jwtSecret);
  const approved = await request(app).put(`/api/v1/admin/drivers/${driverId}/approve`).set(auth(adminToken));
  assert.equal(approved.status, 200);
  const approvedStatus = await request(app).get('/api/v1/drivers/verification/status').set(auth(user.accessToken));
  assert.deepEqual(approvedStatus.body.data, { status: 'approved' });

  const activeRide = { id: 'account-close-active-ride', driverId, riderId: 'someone', status: 'in_progress' };
  db.rides.push(activeRide);
  const blocked = await request(app).post('/api/v1/drivers/account/close').set(auth(user.accessToken))
    .send({ password: 'Password123!', reason: 'Taking a break' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'ACTIVE_RIDE');
  db.rides.splice(db.rides.indexOf(activeRide), 1);

  const response = await request(app).post('/api/v1/drivers/account/close').set(auth(user.accessToken))
    .send({ password: 'Password123!', reason: 'Taking a break' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data.status, 'closed');
  assert.ok(db.users.some((item) => item.id === user.user.id && item.status === 'closed'));
  assert.ok(db.drivers.some((item) => item.id === driverId && item.status === 'closed'));
  const oldSession = await request(app).get('/api/v1/drivers/profile').set(auth(user.accessToken));
  assert.equal(oldSession.status, 403);
  assert.equal(oldSession.body.error.code, 'ACCOUNT_CLOSED');
  const login = await request(app).post('/api/v1/auth/login').send({ email: user.user.email, password: 'Password123!' });
  assert.equal(login.status, 403);
  assert.equal(login.body.error.code, 'ACCOUNT_CLOSED');
});

test('trip sharing returns a public read-only tracking URL', async () => {
  const u = await rider();
  const ride = await request(app)
    .post('/api/v1/rides')
    .set(auth(u.accessToken))
    .send({
      pickup: { latitude: 6.5, longitude: 3.3 },
      destination: { latitude: 6.6, longitude: 3.4 }
    });

  assert.equal(ride.status, 201);

  const shared = await request(app)
    .post(`/api/v1/rides/${ride.body.data.ride.id}/share`)
    .set(auth(u.accessToken));

  assert.equal(shared.status, 201);

  const url = new URL(shared.body.data.url);
  const token = url.pathname.split('/').pop();
  const tracked = await request(app).get(`/api/v1/public/trips/${token}`);

  assert.equal(tracked.status, 200);
  assert.equal(tracked.body.data.status, 'requested');
});

test('drivers see open requests, location accepts ride_id, ride details expose rider contact, and chat is idempotent and closes on cancellation', async () => {
  const driverUser = await driver();
  const riderUser = await rider();
  const driverProfile = await request(app).get('/api/v1/drivers/profile').set(auth(driverUser.accessToken));
  const driverId = driverProfile.body.data.driver.id;
  const driverRecord = db.drivers.find((item) => item.id === driverId);
  Object.assign(driverRecord, { status: 'active', verificationStatus: 'approved', vehicleVerificationStatus: 'verified', onlineStatus: true });
  db.subscriptions.push({ id: 'active-test-subscription', driverId, status: 'active', expiresAt: new Date(Date.now() + 86400000).toISOString() });

  const requested = await request(app).post('/api/v1/rides').set(auth(riderUser.accessToken)).send({
    pickup: { latitude: 6.5, longitude: 3.3 }, destination: { latitude: 6.6, longitude: 3.4 }, paymentMethod: 'cash',
  });
  assert.equal(requested.status, 201);
  const rideId = requested.body.data.ride.id;
  const listed = await request(app).get('/api/v1/rides').set(auth(driverUser.accessToken));
  assert.ok(listed.body.data.items.some((item) => item.id === rideId));

  const accepted = await request(app).post(`/api/v1/rides/${rideId}/accept`).set(auth(driverUser.accessToken));
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.data.ride.fare > 0, true);
  assert.equal(accepted.body.data.ride.payment_method, 'cash');
  assert.equal(accepted.body.data.ride.rider.name, riderUser.user.name);
  assert.equal(accepted.body.data.ride.rider.phone, riderUser.user.phone);

  const location = await request(app).post('/api/v1/drivers/location').set(auth(driverUser.accessToken))
    .send({ latitude: 6.51, longitude: 3.31, ride_id: rideId });
  assert.equal(location.status, 200);
  assert.equal(db.rideLocations.some((item) => item.rideId === rideId), true);

  const first = await request(app).post(`/api/v1/rides/${rideId}/messages`).set(auth(driverUser.accessToken))
    .send({ text: 'I am outside', client_id: 'message-client-0001' });
  const duplicate = await request(app).post(`/api/v1/rides/${rideId}/messages`).set(auth(driverUser.accessToken))
    .send({ text: 'I am outside', client_id: 'message-client-0001' });
  assert.equal(first.status, 201);
  assert.equal(duplicate.status, 200);
  assert.equal(first.body.data.id, duplicate.body.data.id);
  const read = await request(app).post(`/api/v1/rides/${rideId}/messages/read`).set(auth(riderUser.accessToken));
  assert.equal(read.status, 200);

  const cancelled = await request(app).post(`/api/v1/rides/${rideId}/cancel`).set(auth(riderUser.accessToken));
  assert.equal(cancelled.body.data.ride.status, 'cancelled');
  const refreshed = await request(app).get(`/api/v1/rides/${rideId}`).set(auth(riderUser.accessToken));
  assert.equal(refreshed.body.data.ride.status, 'cancelled');
  const closedChat = await request(app).post(`/api/v1/rides/${rideId}/messages`).set(auth(driverUser.accessToken))
    .send({ text: 'Are you there?', client_id: 'message-client-0002' });
  assert.equal(closedChat.status, 409);
  assert.equal(closedChat.body.error.code, 'CHAT_CLOSED');

  const trips = await request(app).get('/api/v1/drivers/trips').set(auth(driverUser.accessToken));
  assert.ok(trips.body.data.items.some((item) => item.id === rideId));
});

test('driver can decline only an offered open request', async () => {
  const driverUser = await driver();
  const riderUser = await rider();
  const driverProfile = await request(app).get('/api/v1/drivers/profile').set(auth(driverUser.accessToken));
  const driverId = driverProfile.body.data.driver.id;
  Object.assign(db.drivers.find((item) => item.id === driverId), { status: 'active', verificationStatus: 'approved', vehicleVerificationStatus: 'verified', onlineStatus: true });
  db.subscriptions.push({ id: 'active-decline-subscription', driverId, status: 'active', expiresAt: new Date(Date.now() + 86400000).toISOString() });
  const requested = await request(app).post('/api/v1/rides').set(auth(riderUser.accessToken)).send({
    pickup: { latitude: 6.5, longitude: 3.3 }, destination: { latitude: 6.6, longitude: 3.4 },
  });
  const rideId = requested.body.data.ride.id;
  const declined = await request(app).post(`/api/v1/rides/${rideId}/decline`).set(auth(driverUser.accessToken));
  assert.equal(declined.status, 200);
  assert.ok(db.rides.find((item) => item.id === rideId).declinedDriverIds.includes(driverId));
});

test('browser SSE receives a one-use, ride-scoped stream ticket', async () => {
  const u = await rider();
  const ride = await request(app)
    .post('/api/v1/rides')
    .set(auth(u.accessToken))
    .send({
      pickup: { latitude: 6.5, longitude: 3.3 },
      destination: { latitude: 6.6, longitude: 3.4 }
    });

  const response = await request(app)
    .post('/api/v1/realtime/stream-token')
    .set(auth(u.accessToken))
    .send({ rideId: ride.body.data.ride.id });

  assert.equal(response.status, 201);
  assert.equal(response.body.data.expiresInSeconds, 60);
  assert.ok(response.body.data.eventsUrl.includes('?token='));
  assert.ok(!JSON.stringify(db.sseTokens).includes(response.body.data.token));
});


test('driver can buy prepaid CNG by units or amount and duress PIN signals SOS discreetly', async () => {
  const jwt = (await import('jsonwebtoken')).default;
  const { env } = await import('../src/config/env.js');
  const { creditWallet } = await import('../src/database/store.js');
  db.users.push({ id: 'admin-cng-feature', role: 'admin', status: 'active' });
  const adminToken = jwt.sign({ sub: 'admin-cng-feature', role: 'admin' }, env.jwtSecret);
  const configured = await request(app).put('/api/v1/admin/cng-pricing')
    .set(auth(adminToken)).send({ unit: 'litre', pricePerUnit: 200 });
  assert.equal(configured.status, 200);
  const user = await driver();
  const profile = await request(app).get('/api/v1/drivers/profile').set(auth(user.accessToken));
  const driverId = profile.body.data.driver.id;
  assert.equal(JSON.stringify(profile.body).includes('walletPinHash'), false);
  const pins = await request(app).put('/api/v1/drivers/wallet/pin')
    .set(auth(user.accessToken)).send({ walletPin: '1234', duressPin: '9876' });
  assert.equal(pins.status, 200);
  creditWallet(driverId, 1000, 'test-credit', 'funding');
  const purchase = await request(app).post('/api/v1/drivers/cng/prepaid')
    .set(auth(user.accessToken)).send({ quantity: 1, pin: '1234', clientReference: 'cng-order-0001' });
  assert.equal(purchase.status, 201);
  assert.equal(purchase.body.data.order.amount, 200);
  assert.equal(purchase.body.data.order.status, 'paid_pending_redemption');
  assert.equal(purchase.body.data.walletBalance, 800);
  const duress = await request(app).post('/api/v1/drivers/cng/prepaid')
    .set(auth(user.accessToken)).send({ amount: 100, pin: '9876', clientReference: 'cng-duress-0001' });
  assert.equal(duress.status, 202);
  assert.equal(duress.body.data.status, 'processing');
  assert.equal(db.sosEvents.filter((event) => event.driverId === driverId).length, 1);
  assert.equal(db.wallets.find((wallet) => wallet.driverId === driverId).balance, 800);
});

test('driver wallet funding initiation is rate-limited', async () => {
  const user = await driver();
  const responses = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    responses.push(await request(app)
      .post('/api/v1/drivers/wallet/fund/initiate')
      .set(auth(user.accessToken))
      .send({}));
  }
  assert.equal(responses.slice(0, 5).every((response) => response.status === 400), true);
  assert.equal(responses[5].status, 429);
  assert.equal(responses[5].body.error.code, 'WALLET_FUNDING_RATE_LIMITED');
});

test('driver wallet fund endpoints use the published client_reference/reference contract', async () => {
  const { env } = await import('../src/config/env.js');
  const { creditWallet } = await import('../src/database/store.js');
  const user = await driver();
  const previousSecret = env.paystackSecretKey;
  const previousFetch = globalThis.fetch;
  let reference;
  env.paystackSecretKey = 'test-wallet-funding-secret';
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/transaction/initialize')) {
      const body = JSON.parse(options.body || '{}');
      reference = body.reference;
      return { ok: true, json: async () => ({ status: true, data: { authorization_url: 'https://checkout.example.test/fund', access_code: 'fund-access-code' } }) };
    }
    if (String(url).includes('/transaction/verify/')) {
      const verifiedReference = decodeURIComponent(String(url).split('/').at(-1));
      return { ok: true, json: async () => ({ status: true, data: { status: 'success', amount: 50000, currency: 'NGN', reference: verifiedReference } }) };
    }
    throw new Error(`Unexpected mocked provider request: ${url}`);
  };
  try {
    const initialized = await request(app).post('/api/v1/drivers/wallet/fund/initiate')
      .set(auth(user.accessToken))
      .send({ amount: 500, method: 'card', client_reference: 'client-ref-00001' });
    assert.equal(initialized.status, 201);
    assert.deepEqual(Object.keys(initialized.body.data).sort(), ['checkout_url', 'reference']);
    assert.equal(initialized.body.data.checkout_url, 'https://checkout.example.test/fund');
    assert.equal(initialized.body.data.reference, reference);

    const verified = await request(app).post('/api/v1/drivers/wallet/fund/verify')
      .set(auth(user.accessToken)).send({ reference });
    assert.equal(verified.status, 200);
    assert.deepEqual(verified.body.data, { status: 'success', amount: 500 });
    const driverId = db.drivers.find((item) => item.userId === user.user.id).id;
    assert.equal(db.wallets.find((item) => item.driverId === driverId).balance, 500);
    assert.equal((await request(app).post('/api/v1/drivers/wallet/fund/verify')
      .set(auth(user.accessToken)).send({ reference: 'bad' })).status, 400);
  } finally {
    env.paystackSecretKey = previousSecret;
    globalThis.fetch = previousFetch;
  }
});

test('wallet PIN changes require reauthentication and emergency withdrawal silently alerts admins without moving money', async () => {
  const { creditWallet } = await import('../src/database/store.js');
  const user = await driver();
  const profile = await request(app).get('/api/v1/drivers/profile').set(auth(user.accessToken));
  const driverId = profile.body.data.driver.id;
  const admin = { id: 'wallet-duress-admin', email: 'wallet-admin@example.com', role: 'admin', status: 'active' };
  db.users.push(admin);
  const unconfigured = await request(app).get('/api/v1/drivers/wallet/pin/status').set(auth(user.accessToken));
  assert.deepEqual(unconfigured.body.data, { configured: false });

  const setup = await request(app).put('/api/v1/drivers/wallet/pin').set(auth(user.accessToken))
    .send({ walletPin: '1234', duressPin: '9876' });
  assert.equal(setup.status, 200);
  const blockedChange = await request(app).put('/api/v1/drivers/wallet/pin').set(auth(user.accessToken))
    .send({ walletPin: '2234', duressPin: '8876' });
  assert.equal(blockedChange.status, 401);
  assert.equal(blockedChange.body.error.code, 'PIN_REAUTHENTICATION_REQUIRED');
  const changed = await request(app).put('/api/v1/drivers/wallet/pin').set(auth(user.accessToken))
    .send({ walletPin: '2234', duressPin: '8876', currentPin: '1234' });
  assert.equal(changed.status, 200);
  const configured = await request(app).get('/api/v1/drivers/wallet/pin/status').set(auth(user.accessToken));
  assert.deepEqual(configured.body.data, { configured: true });

  creditWallet(driverId, 4000, 'wallet-pin-test-credit', 'funding');
  const wallet = db.wallets.find((item) => item.driverId === driverId);
  wallet.bankAccount = { bankCode: '044', accountNumber: '1234567890', accountName: 'Feature Driver' };
  db.drivers.find((item) => item.id === driverId).currentLocation = { latitude: 6.5, longitude: 3.3, recordedAt: new Date().toISOString() };
  const beforeTransactions = db.walletTransactions.length;
  const beforeBalance = wallet.balance;

  const duress = await request(app).post('/api/v1/drivers/wallet/withdraw').set(auth(user.accessToken))
    .send({ amount: 1000, pin: '8876' });
  assert.equal(duress.status, 201);
  assert.equal(duress.body.message, 'Withdrawal requested');
  assert.equal(wallet.balance, beforeBalance);
  assert.equal(db.withdrawals.length, 0);
  assert.equal(db.walletTransactions.length, beforeTransactions);
  const event = db.sosEvents.find((item) => item.alertType === 'wallet_duress' && item.action === 'withdrawal');
  assert.ok(event);
  assert.equal(event.latitude, 6.5);
  assert.equal(event.longitude, 3.3);
  assert.equal(db.notifications.some((item) => item.userId === admin.id && item.type === 'wallet_duress'), true);

  const normal = await request(app).post('/api/v1/drivers/wallet/withdraw').set(auth(user.accessToken))
    .send({ amount: 1000, pin: '2234' });
  assert.equal(normal.status, 201);
  assert.equal(wallet.balance, beforeBalance - 1000);
  assert.equal(db.withdrawals.length, 1);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const wrong = await request(app).post('/api/v1/drivers/wallet/withdraw').set(auth(user.accessToken))
      .send({ amount: 100, pin: '0000' });
    assert.equal(wrong.status, 401);
  }
  const fifth = await request(app).post('/api/v1/drivers/wallet/withdraw').set(auth(user.accessToken))
    .send({ amount: 100, pin: '0000' });
  assert.equal(fifth.status, 423);
  assert.equal(fifth.body.error.code, 'PIN_LOCKED');
});

test('CNG pricing response is normalized and logs compute cost on server while stale quotes return PRICE_CHANGED', async () => {
  const jwt = (await import('jsonwebtoken')).default;
  const user = await driver();
  const adminId = 'cng-pricing-admin-contract';
  db.users.push({ id: adminId, role: 'admin', status: 'active' });
  const adminToken = jwt.sign({ sub: adminId, role: 'admin' }, (await import('../src/config/env.js')).env.jwtSecret);

  const saved = await request(app).put('/api/v1/admin/cng-pricing').set(auth(adminToken))
    .send({ unit: 'litres', pricePerUnit: 215, presets: [500, 1000, 2500] });
  assert.equal(saved.status, 200);
  const quote = await request(app).get('/api/v1/drivers/cng/pricing').set(auth(user.accessToken));
  assert.deepEqual(Object.keys(quote.body.data).sort(), ['pricePerUnit', 'presets', 'unit', 'updatedAt'].sort());
  assert.deepEqual(quote.body.data, { pricePerUnit: 215, unit: 'litres', presets: [500, 1000, 2500], updatedAt: saved.body.data.pricing.updatedAt });

  const logged = await request(app).post('/api/v1/drivers/cng/log').set(auth(user.accessToken))
    .send({ quantity: 2.5, pricePerUnit: quote.body.data.pricePerUnit, unit: quote.body.data.unit, updatedAt: quote.body.data.updatedAt, station: 'Central Station' });
  assert.equal(logged.status, 201);
  assert.equal(logged.body.data.transaction.cost, 537.5);
  assert.equal(logged.body.data.transaction.price_per_unit, 215);
  assert.equal(logged.body.data.transaction.unit, 'litres');

  await request(app).put('/api/v1/admin/cng-pricing').set(auth(adminToken))
    .send({ unit: 'scm', pricePerUnit: 300, presets: [1000, 2000] });
  const stale = await request(app).post('/api/v1/drivers/cng/log').set(auth(user.accessToken))
    .send({ quantity: 1, pricePerUnit: 215, unit: 'litres', updatedAt: quote.body.data.updatedAt });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'PRICE_CHANGED');
  assert.equal(db.cngTransactions.length, 1);
});


test('driver plate must match basic format and vehicle must be admin-verified with approved registration document', async () => {
  const jwt = (await import('jsonwebtoken')).default;
  const { env } = await import('../src/config/env.js');
  const adminId = 'admin-vehicle-review';
  db.users.push({ id: adminId, role: 'admin', status: 'active' });
  const adminToken = jwt.sign({ sub: adminId, role: 'admin' }, env.jwtSecret);
  const invalid = await request(app).post('/api/v1/auth/register').send({
    name: 'Bad Plate Driver', email: 'bad-plate@example.com', phone: '+234800000715',
    password: 'Password123!', role: 'driver', vehiclePlateNumber: 'NOT-A-PLATE'
  });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.message, /Validation failed/);

  const registered = await request(app).post('/api/v1/auth/register').send({
    name: 'Review Driver', email: 'review-plate@example.com', phone: '+234800000716',
    password: 'Password123!', role: 'driver', plateNumber: 'ABC123XY'
  });
  assert.equal(registered.status, 201);
  const driver = db.drivers.find((item) => item.userId === registered.body.data.user.id);
  assert.equal(driver.vehiclePlateNumber, 'ABC-123XY');
  assert.equal(driver.vehicleVerificationStatus, 'pending');
  driver.status = 'active';
  driver.verificationStatus = 'approved';
  const driverToken = registered.body.data.accessToken;
  const blocked = await request(app).post('/api/v1/drivers/status')
    .set(auth(driverToken)).send({ isOnline: true });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'VEHICLE_NOT_VERIFIED');

  const missingDocument = await request(app).put(`/api/v1/admin/drivers/${driver.id}/vehicle-review`)
    .set(auth(adminToken)).send({ status: 'verified' });
  assert.equal(missingDocument.status, 409);
  assert.equal(missingDocument.body.error.code, 'VEHICLE_DOCUMENT_NOT_APPROVED');
  db.documents.push({
    id: 'vehicle-registration-test', driverId: driver.id,
    documentType: 'vehicle_registration', status: 'approved',
  });
  const reviewed = await request(app).put(`/api/v1/admin/drivers/${driver.id}/vehicle-review`)
    .set(auth(adminToken)).send({ status: 'verified', note: 'Plate matches registration document' });
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.body.data.vehicleVerificationStatus, 'verified');
  const online = await request(app).post('/api/v1/drivers/status')
    .set(auth(driverToken)).send({ isOnline: true });
  assert.equal(online.status, 200);
});
