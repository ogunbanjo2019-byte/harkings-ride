import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import jwt from 'jsonwebtoken';
process.env.NODE_ENV = 'test';
process.env.DATABASE_PROVIDER = 'memory';
const { default: app } = await import('../src/app.js');
const { connectDatabase, closeDatabase, db, seed } = await import('../src/database/store.js');
const { env } = await import('../src/config/env.js');
before(async () => connectDatabase());
beforeEach(() => { for (const collection of Object.values(db)) collection.length = 0; });
after(async () => closeDatabase());

test('does not seed the demo administrator in a staging environment', async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'staging';
  try {
    await seed();
    assert.equal(db.users.some((user) => user.email === 'admin@example.com'), false);
  } finally {
    process.env.NODE_ENV = previous;
  }
});

test('admin CSV exports neutralize spreadsheet formulas', async () => {
  db.users.push({ id: 'admin-csv-test', email: 'admin-csv@example.com', role: 'admin', status: 'active' });
  db.rides.push({ id: 'ride-csv-test', riderName: '=1+1' });
  const token = jwt.sign({ sub: 'admin-csv-test', role: 'admin' }, env.jwtSecret);
  const response = await request(app).get('/api/v1/admin/exports/rides').set('Authorization', `Bearer ${token}`);
  assert.equal(response.status, 200);
  assert.match(response.text, /"'=1\+1"/);
});

test('password reset is single-use and does not expose token hashes', async () => {
  const registered = await request(app).post('/api/v1/auth/register').send({ name: 'Reset User', email: 'reset@example.com', phone: '+234800000111', password: 'Password123!', role: 'rider' });
  assert.equal(registered.status, 201);
  const sent = await request(app).post('/api/v1/auth/forgot-password').send({ email: 'reset@example.com' });
  assert.equal(sent.status, 202);
  const token = sent.body.data.developmentResetToken;
  assert.ok(token);
  assert.ok(!JSON.stringify(db.passwordResetTokens).includes(token));
  const emailLog = JSON.stringify(db.emailMessages);
  assert.ok(!emailLog.includes(token));
  assert.ok(!emailLog.includes('reset@example.com'));
  assert.equal((await request(app).post('/api/v1/auth/reset-password').send({ token, password: 'NewPassword123!' })).status, 200);
  assert.equal((await request(app).post('/api/v1/auth/reset-password').send({ token, password: 'OtherPassword123!' })).status, 400);
});

test('email OTP is preview-only and its recipient and code are not persisted', async () => {
  const response = await request(app).post('/api/v1/auth/send-otp').send({ email: 'email-otp@example.com', purpose: 'login' });
  assert.equal(response.status, 202);
  assert.equal(response.body.data.deliveryStatus, 'preview');
  const code = response.body.data.developmentOtp;
  assert.match(code, /^\d{6}$/);
  const emailLog = JSON.stringify(db.emailMessages);
  assert.ok(!emailLog.includes(code));
  assert.ok(!emailLog.includes('email-otp@example.com'));
});

test('phone OTP stays disabled until Twilio server credentials are configured', async () => {
  const response = await request(app).post('/api/v1/auth/send-otp').send({ phone: '+234800000119', purpose: 'login' });
  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, 'SMS_PROVIDER_NOT_CONFIGURED');
  assert.equal(db.otpChallenges.length, 0);
});

test('staging responses never reveal development OTPs or reset tokens', async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'staging';
  try {
    const registered = await request(app).post('/api/v1/auth/register').send({ name: 'Staging User', email: 'staging-user@example.com', phone: '+234800000113', password: 'Password123!', role: 'rider' });
    assert.equal(registered.status, 201);
    const otp = await request(app).post('/api/v1/auth/send-otp').send({ email: 'staging-user@example.com', purpose: 'login' });
    assert.equal(otp.status, 202);
    assert.equal(Object.hasOwn(otp.body.data, 'developmentOtp'), false);
    const reset = await request(app).post('/api/v1/auth/forgot-password').send({ email: 'staging-user@example.com' });
    assert.equal(reset.status, 202);
    assert.equal(Object.hasOwn(reset.body.data, 'developmentResetToken'), false);
    assert.equal(reset.body.data.deliveryStatus, 'preview');
  } finally {
    process.env.NODE_ENV = previous;
  }
});

test('Paystack webhook rejects invalid signatures', async () => {
  const response = await request(app).post('/api/v1/payments/webhooks/paystack').send({ event: 'charge.success', data: { reference: 'ref' } });
  assert.ok([401, 503].includes(response.status));
});

test('document upload stores metadata without base64 payload', async () => {
  const registered = await request(app).post('/api/v1/auth/register').send({ name: 'Driver User', email: 'driver-upload@example.com', phone: '+234800000112', password: 'Password123!', role: 'driver', vehiclePlateNumber: 'TST-001AA' });
  const response = await request(app).post('/api/v1/drivers/verification/document').set('Authorization', `Bearer ${registered.body.data.accessToken}`).field('documentType', 'license').attach('document', Buffer.from('fake-image'), { filename: 'license.jpg', contentType: 'image/jpeg' });
  assert.equal(response.status, 202);
  assert.equal(Object.hasOwn(db.documents[0], 'contentBase64'), false);
});

test('admin MFA enrollment enables TOTP-protected short-lived admin access without exposing secrets', async () => {
  const bcrypt = (await import('bcryptjs')).default;
  const { publicUser } = await import('../src/database/store.js');
  const { generateTotpCode } = await import('../src/services/admin-mfa.js');
  const previousRequired = env.adminMfaRequired;
  const previousEmailVerification = env.emailVerificationRequired;
  env.adminMfaRequired = true;
  env.emailVerificationRequired = true;
  try {
    const admin = {
      id: 'mfa-admin-test', email: 'mfa-admin@example.com', phone: '+234800000771',
      name: 'MFA Admin', role: 'admin', status: 'active', tokenVersion: 0,
      passwordHash: await bcrypt.hash('VerySecurePassword123!', 4),
    };
    db.users.push(admin);
    const signedIn = await request(app).post('/api/v1/auth/login').send({
      email: admin.email, password: 'VerySecurePassword123!',
    });
    assert.equal(signedIn.status, 200);
    assert.equal(signedIn.body.data.requiresEmailVerification, true);
    assert.equal(signedIn.body.data.user.adminMfaEnabled, undefined);
    assert.equal(JSON.stringify(signedIn.body).includes('passwordHash'), false);
    let token = signedIn.body.data.accessToken;
    assert.equal((await request(app).get('/api/v1/admin/pricing').set('Authorization', `Bearer ${token}`)).status, 403);
    const emailed = await request(app).post('/api/v1/auth/send-otp').send({ email: admin.email, purpose: 'verification' });
    assert.equal(emailed.status, 202);
    const verified = await request(app).post('/api/v1/auth/verify-otp').send({ email: admin.email, purpose: 'verification', code: emailed.body.data.developmentOtp });
    assert.equal(verified.status, 200);
    assert.ok(admin.emailVerifiedAt);

    const setup = await request(app).post('/api/v1/auth/admin-mfa/enroll')
      .set('Authorization', `Bearer ${token}`).send({ password: 'VerySecurePassword123!' });
    assert.equal(setup.status, 200);
    const code = generateTotpCode(setup.body.data.secret);
    const confirmed = await request(app).post('/api/v1/auth/admin-mfa/confirm')
      .set('Authorization', `Bearer ${token}`).send({ code });
    assert.equal(confirmed.status, 200);
    token = confirmed.body.data.accessToken;
    assert.equal(admin.adminMfaEnabled, true);
    assert.equal((await request(app).get('/api/v1/admin/pricing').set('Authorization', `Bearer ${token}`)).status, 200);
    const safe = publicUser(admin);
    for (const key of ['passwordHash', 'adminMfaSecret', 'adminMfaPendingSecret', 'adminMfaLastCounter', 'tokenVersion']) {
      assert.equal(Object.hasOwn(safe, key), false);
    }
    const noMfa = await request(app).post('/api/v1/auth/login').send({
      email: admin.email, password: 'VerySecurePassword123!',
    });
    assert.equal(noMfa.status, 401);
    assert.equal(noMfa.body.error.code, 'ADMIN_MFA_REQUIRED');
  } finally {
    env.adminMfaRequired = previousRequired;
    env.emailVerificationRequired = previousEmailVerification;
  }
});
