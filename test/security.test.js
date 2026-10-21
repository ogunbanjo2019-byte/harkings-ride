import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
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

test('staging mock OTP cannot start outside staging or with wildcard CORS', () => {
  const loadConfig = "import('./src/config/env.js')";
  const baseEnv = { ...process.env, STAGING_MOCK_OTP_ENABLED: 'true' };
  const outsideStaging = spawnSync(process.execPath, ['-e', loadConfig], {
    cwd: process.cwd(),
    env: { ...baseEnv, NODE_ENV: 'production', CORS_ORIGINS: 'https://staging.example.com' },
    encoding: 'utf8',
  });
  assert.notEqual(outsideStaging.status, 0);
  assert.match(outsideStaging.stderr, /may only be enabled when NODE_ENV=staging/);

  const wildcardCors = spawnSync(process.execPath, ['-e', loadConfig], {
    cwd: process.cwd(),
    env: { ...baseEnv, NODE_ENV: 'staging', CORS_ORIGINS: '*' },
    encoding: 'utf8',
  });
  assert.notEqual(wildcardCors.status, 0);
  assert.match(wildcardCors.stderr, /requires explicit, non-wildcard CORS_ORIGINS/);
});

test('registration validates email and international phone formats at the API boundary', async () => {
  const invalidEmail = await request(app).post('/api/v1/auth/register').send({
    name: 'Invalid Email', email: 'not-an-email', phone: '+447700900123', password: 'Password123!', role: 'rider',
  });
  assert.equal(invalidEmail.status, 400);
  assert.equal(invalidEmail.body.error.code, 'VALIDATION_ERROR');

  const invalidPhone = await request(app).post('/api/v1/auth/register').send({
    name: 'Invalid Phone', email: 'invalid-phone@example.com', phone: 'abc123', password: 'Password123!', role: 'rider',
  });
  assert.equal(invalidPhone.status, 400);
  assert.equal(invalidPhone.body.error.code, 'VALIDATION_ERROR');

  const registered = await request(app).post('/api/v1/auth/register').send({
    name: 'International Rider', email: 'international@example.com', phone: '+447700900123', password: 'Password123!', role: 'rider',
  });
  assert.equal(registered.status, 201);
  assert.equal(registered.body.data.user.phone, '+447700900123');
});

test('staging mock OTP supports driver phone login without SMS and remains single-use', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousEnabled = env.stagingMockOtpEnabled;
  const previousCode = env.stagingMockOtpCode;
  process.env.NODE_ENV = 'staging';
  env.stagingMockOtpEnabled = true;
  env.stagingMockOtpCode = '123456';
  try {
    const registered = await request(app).post('/api/v1/auth/register').send({
      name: 'International Driver', email: 'mock-driver@example.com', phone: '+447700900124',
      password: 'Password123!', role: 'driver', vehiclePlateNumber: 'TST-444AA',
    });
    assert.equal(registered.status, 201);

    const sent = await request(app).post('/api/v1/auth/send-otp').send({
      phone: '+447700900124', purpose: 'login',
    });
    assert.equal(sent.status, 202);
    assert.equal(sent.body.data.deliveryStatus, 'staging_mock');
    assert.equal(Object.hasOwn(sent.body.data, 'developmentOtp'), false);
    assert.notEqual(db.otpChallenges.at(-1).codeHash, '123456');

    const verified = await request(app).post('/api/v1/auth/verify-otp').send({
      challengeId: sent.body.data.challengeId, phone: '+447700900124', purpose: 'login', code: '123456',
    });
    assert.equal(verified.status, 200);
    assert.equal(verified.body.data.user.role, 'driver');

    const replay = await request(app).post('/api/v1/auth/verify-otp').send({
      challengeId: sent.body.data.challengeId, phone: '+447700900124', purpose: 'login', code: '123456',
    });
    assert.equal(replay.status, 400);

    const riderRegistered = await request(app).post('/api/v1/auth/register').send({
      name: 'International Rider', email: 'mock-rider@example.com', phone: '+447700900125',
      password: 'Password123!', role: 'rider',
    });
    assert.equal(riderRegistered.status, 201);
    const riderChallengeId = '00000000-0000-4000-8000-000000000125';
    db.otpChallenges.push({
      id: riderChallengeId,
      channel: 'phone',
      destination: '+447700900125',
      purpose: 'login',
      codeHash: createHash('sha256').update('123456').digest('hex'),
      attempts: 0,
      maxAttempts: 5,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
      usedAt: null,
    });
    const riderVerified = await request(app).post('/api/v1/auth/verify-otp').send({
      challengeId: riderChallengeId, phone: '+447700900125', purpose: 'login', code: '123456',
    });
    assert.equal(riderVerified.status, 200);
    assert.equal(riderVerified.body.data.user.role, 'rider');
  } finally {
    process.env.NODE_ENV = previousNodeEnv;
    env.stagingMockOtpEnabled = previousEnabled;
    env.stagingMockOtpCode = previousCode;
  }
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

test('NIN can be marked verified only after submission with an audit reference, and driver rejections retain reasons', async () => {
  const admin = { id: 'review-admin-test', email: 'review-admin@example.com', role: 'admin', status: 'active' };
  const driverUser = { id: 'review-driver-user', email: 'review-driver@example.com', role: 'driver', status: 'active' };
  const driver = { id: 'review-driver-test', userId: driverUser.id, verificationStatus: 'pending', verification: { nin: { status: 'pending' } } };
  db.users.push(admin, driverUser);
  db.drivers.push(driver);
  const token = jwt.sign({ sub: admin.id, role: 'admin' }, env.jwtSecret);
  const base = request(app).put(`/api/v1/admin/drivers/${driver.id}/nin-review`).set('Authorization', `Bearer ${token}`);
  const premature = await base.send({ status: 'verified', note: 'checked in approved source' });
  assert.equal(premature.status, 409);
  driver.verification.nin.submittedAt = new Date().toISOString();
  const approved = await request(app).put(`/api/v1/admin/drivers/${driver.id}/nin-review`).set('Authorization', `Bearer ${token}`).send({ status: 'verified', note: 'provider reference CASE-123' });
  assert.equal(approved.status, 200);
  assert.equal(driver.verification.nin.status, 'verified');
  assert.match(JSON.stringify(db.auditLogs), /CASE-123/);

  const missingReason = await request(app).put(`/api/v1/admin/drivers/${driver.id}/reject`).set('Authorization', `Bearer ${token}`).send({});
  assert.equal(missingReason.status, 400);
  const rejected = await request(app).put(`/api/v1/admin/drivers/${driver.id}/reject`).set('Authorization', `Bearer ${token}`).send({ note: 'Identity documents do not match the profile.' });
  assert.equal(rejected.status, 200);
  assert.equal(driver.reviewNote, 'Identity documents do not match the profile.');
  assert.ok(db.notifications.some((item) => item.userId === driverUser.id && item.body === driver.reviewNote));
});
