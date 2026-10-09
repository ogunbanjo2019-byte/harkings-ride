import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.DATABASE_PROVIDER = 'memory';

const { default: app } = await import('../src/app.js');
const { connectDatabase, closeDatabase, db } = await import('../src/database/store.js');
const { env } = await import('../src/config/env.js');
const {
  setRekognitionClientForTests,
  createLivenessSession,
  getLivenessResults,
  compareLivenessFaceToDocument
} = await import('../src/services/face-verification.js');

// --- Helpers ---
const auth = (token) => ({ Authorization: `Bearer ${token}` });

// --- Global Lifecycle Hooks ---
before(async () => connectDatabase());

beforeEach(() => {
  for (const collection of Object.values(db)) {
    collection.length = 0;
  }
});

after(async () => {
  setRekognitionClientForTests(undefined);
  await closeDatabase();
});

// --- Unit Tests: AWS Rekognition Integration ---

test('AWS liveness session command includes idempotency and movement-and-light challenge', async () => {
  let command;
  setRekognitionClientForTests({
    send: async (input) => {
      command = input;
      return { SessionId: 'session-1234567890' };
    }
  });

  assert.equal(await createLivenessSession('request-token-1'), 'session-1234567890');
  assert.equal(command.input.ClientRequestToken, 'request-token-1');
  assert.equal(command.input.Settings.ChallengePreferences[0].Type, 'FaceMovementAndLightChallenge');
});

test('AWS face comparison uses liveness reference bytes and configured threshold', async () => {
  let command;
  setRekognitionClientForTests({
    send: async (input) => {
      command = input;
      return { FaceMatches: [{ Similarity: 96.5 }] };
    }
  });

  const source = new Uint8Array([1, 2]);
  const target = new Uint8Array([3, 4]);
  const result = await compareLivenessFaceToDocument({
    livenessReferenceBytes: source,
    documentBytes: target
  });

  assert.equal(command.input.SourceImage.Bytes, source);
  assert.equal(command.input.TargetImage.Bytes, target);
  assert.equal(command.input.SimilarityThreshold, env.faceMatchSimilarityThreshold);
  assert.deepEqual(result, { similarity: 96.5, matched: true });
});

test('liveness result retrieval requests only the supplied session ID', async () => {
  let command;
  setRekognitionClientForTests({
    send: async (input) => {
      command = input;
      return { Status: 'SUCCEEDED', Confidence: 98 };
    }
  });

  const result = await getLivenessResults('session-1234567890');
  assert.equal(command.input.SessionId, 'session-1234567890');
  assert.equal(result.Confidence, 98);
});

// --- Integration Tests: Driver Face Verification API ---

test('driver face session requires explicit consent and rejects when provider is not configured', async () => {
  setRekognitionClientForTests(undefined);

  const registered = await request(app)
    .post('/api/v1/auth/register')
    .send({
      name: 'Face Test Driver',
      email: 'face-driver@example.com',
      phone: '+234800001222',
      password: 'Password123!',
      role: 'driver'
    });

  assert.equal(registered.status, 201);
  const token = registered.body.data.accessToken;

  const noConsent = await request(app)
    .post('/api/v1/drivers/verification/face/session')
    .set(auth(token))
    .send({
      documentId: 'doc-1',
      biometricConsent: false,
      consentVersion: 'test-v1'
    });
  assert.equal(noConsent.status, 400);

  const noProvider = await request(app)
    .post('/api/v1/drivers/verification/face/session')
    .set(auth(token))
    .send({
      documentId: 'doc-1',
      biometricConsent: true,
      consentVersion: 'test-v1'
    });
  assert.equal(noProvider.status, 503);
});

test('face session requires the deployed consent notice revision', async () => {
  const registered = await request(app)
    .post('/api/v1/auth/register')
    .send({
      name: 'Consent Test Driver',
      email: 'consent-face@example.com',
      phone: '+234800001226',
      password: 'Password123!',
      role: 'driver'
    });

  const previous = env.identityProvider;
  env.identityProvider = 'aws-rekognition';

  try {
    const response = await request(app)
      .post('/api/v1/drivers/verification/face/session')
      .set(auth(registered.body.data.accessToken))
      .send({
        documentId: 'doc-1',
        biometricConsent: true,
        consentVersion: 'old-notice-v0'
      });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'CONSENT_VERSION_UNSUPPORTED');
  } finally {
    env.identityProvider = previous;
  }
});

test('a pending face session is never resumed for a different identity document', async () => {
  const registered = await request(app)
    .post('/api/v1/auth/register')
    .send({
      name: 'Document Switch Driver',
      email: 'document-switch@example.com',
      phone: '+234800001227',
      password: 'Password123!',
      role: 'driver'
    });

  const driver = db.drivers.find((item) => item.userId === registered.body.data.user.id);
  db.documents.push(
    {
      id: 'document-old',
      driverId: driver.id,
      mimeType: 'image/jpeg',
      storage: { stored: true, path: 'drivers/old.jpg' }
    },
    {
      id: 'document-new',
      driverId: driver.id,
      mimeType: 'image/png',
      storage: { stored: true, path: 'drivers/new.png' }
    }
  );

  db.identityChecks.push({
    id: 'old-check',
    driverId: driver.id,
    type: 'aws_face_liveness',
    providerReference: 'old-session-123456',
    status: 'provider_pending',
    metadata: { documentId: 'document-old' },
    createdAt: new Date().toISOString()
  });

  const previous = env.identityProvider;
  env.identityProvider = 'aws-rekognition';
  setRekognitionClientForTests({
    send: async (command) =>
      command.constructor.name === 'CreateFaceLivenessSessionCommand'
        ? { SessionId: 'new-session-123456' }
        : {}
  });

  try {
    const response = await request(app)
      .post('/api/v1/drivers/verification/face/session')
      .set(auth(registered.body.data.accessToken))
      .send({
        documentId: 'document-new',
        biometricConsent: true,
        consentVersion: env.faceConsentVersion
      });

    assert.equal(response.status, 201);
    assert.equal(db.identityChecks[0].resultCode, 'SESSION_REPLACED');
    assert.equal(db.identityChecks[1].metadata.documentId, 'document-new');
  } finally {
    env.identityProvider = previous;
    setRekognitionClientForTests(undefined);
  }
});

test('driver can cancel only their own pending face-verification session', async () => {
  const registered = await request(app)
    .post('/api/v1/auth/register')
    .send({
      name: 'Cancel Test Driver',
      email: 'cancel-face@example.com',
      phone: '+234800001223',
      password: 'Password123!',
      role: 'driver'
    });

  assert.equal(registered.status, 201);
  const driver = db.drivers.find((item) => item.userId === registered.body.data.user.id);

  db.identityChecks.push({
    id: 'face-check-1',
    driverId: driver.id,
    type: 'aws_face_liveness',
    providerReference: 'session-cancel-123456',
    status: 'provider_pending',
    metadata: {},
    createdAt: new Date().toISOString()
  });

  const cancelled = await request(app)
    .post('/api/v1/drivers/verification/face/cancel')
    .set(auth(registered.body.data.accessToken))
    .send({ sessionId: 'session-cancel-123456' });

  assert.equal(cancelled.status, 200);
  assert.equal(db.identityChecks[0].status, 'failed');

  const otherDriver = await request(app)
    .post('/api/v1/auth/register')
    .send({
      name: 'Other Driver',
      email: 'other-face@example.com',
      phone: '+234800001224',
      password: 'Password123!',
      role: 'driver'
    });

  const denied = await request(app)
    .post('/api/v1/drivers/verification/face/cancel')
    .set(auth(otherDriver.body.data.accessToken))
    .send({ sessionId: 'session-cancel-123456' });

  assert.equal(denied.status, 404);
});

// --- Integration Tests: Subscription & Production Safety Guards ---

test('production refuses a driver-submitted subscription reference without provider verification', async () => {
  const registered = await request(app)
    .post('/api/v1/auth/register')
    .send({
      name: 'Subscription Test Driver',
      email: 'subscription-face@example.com',
      phone: '+234800001225',
      password: 'Password123!',
      role: 'driver'
    });

  const previous = env.isProduction;
  env.isProduction = true;

  try {
    const response = await request(app)
      .post('/api/v1/drivers/subscription/pay')
      .set(auth(registered.body.data.accessToken))
      .send({
        days: 1,
        paymentReference: 'fake-unverified-reference'
      });

    assert.equal(response.status, 503);
    assert.equal(db.subscriptions.length, 0);
  } finally {
    env.isProduction = previous;
  }
});
