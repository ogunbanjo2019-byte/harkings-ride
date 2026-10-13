import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.DATABASE_PROVIDER = 'memory';
process.env.CORS_ORIGIN = 'https://switchride-driver-app.vercel.app,https://switchride-rider-app-sihq.vercel.app';

const { default: app } = await import('../src/app.js');
const { createPersistenceMiddleware } = await import('../src/middleware/persistence.js');

test('CORS reflects only the requesting allowlisted Vercel origin', async () => {
  for (const origin of [
    'https://switchride-driver-app.vercel.app',
    'https://switchride-rider-app-sihq.vercel.app',
  ]) {
    const response = await request(app)
      .options('/api/v1/auth/login')
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,authorization');

    assert.equal(response.status, 204);
    assert.equal(response.headers['access-control-allow-origin'], origin);
  }
});

test('read-only auth login is not blocked by a failed snapshot save', async () => {
  let persistenceCalls = 0;
  const appWithFailingPersistence = express();
  appWithFailingPersistence.use(express.json());
  appWithFailingPersistence.use(createPersistenceMiddleware(
    async () => {
      persistenceCalls += 1;
      throw new Error('simulated missing Supabase RPC');
    },
    { error() {} },
  ));
  appWithFailingPersistence.post('/api/v1/auth/login', (_req, res) => {
    res.status(200).json({ success: true, data: { accessToken: 'test-only' } });
  });

  const response = await request(appWithFailingPersistence)
    .post('/api/v1/auth/login')
    .send({ email: 'test@example.com', password: 'not-a-real-password' });

  assert.equal(response.status, 200);
  assert.equal(persistenceCalls, 0);
});

test('state-changing requests still return 503 when persistence fails', async () => {
  let persistenceCalls = 0;
  const appWithFailingPersistence = express();
  appWithFailingPersistence.use(express.json());
  appWithFailingPersistence.use(createPersistenceMiddleware(
    async () => {
      persistenceCalls += 1;
      throw new Error('simulated missing Supabase RPC');
    },
    { error() {} },
  ));
  appWithFailingPersistence.post('/api/v1/auth/register', (_req, res) => {
    res.status(201).json({ success: true });
  });

  const response = await request(appWithFailingPersistence)
    .post('/api/v1/auth/register')
    .send({});

  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, 'PERSISTENCE_FAILED');
  assert.equal(persistenceCalls, 1);
});
