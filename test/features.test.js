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
    phone: '+234800000714', password: 'Password123!', role: 'driver'
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
