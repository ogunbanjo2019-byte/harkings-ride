import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.DATABASE_PROVIDER = 'memory';
process.env.CORS_ORIGINS = 'https://switchride-driver-app.vercel.app,https://switchride-rider-app-sihq.vercel.app,http://localhost:5173';

const { default: app } = await import('../src/app.js');
const { createPersistenceMiddleware } = await import('../src/middleware/persistence.js');

test('CORS preflight reflects allowed origins and permits app methods and headers before auth', async () => {
  for (const origin of [
    'https://switchride-driver-app.vercel.app',
    'https://switchride-rider-app-sihq.vercel.app',
    'http://localhost:5173',
  ]) {
    const response = await request(app)
      .options('/api/v1/auth/login')
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,authorization');

    assert.equal(response.status, 204);
    assert.equal(response.headers['access-control-allow-origin'], origin);
    assert.match(response.headers['access-control-allow-methods'], /GET/);
    assert.match(response.headers['access-control-allow-methods'], /POST/);
    assert.match(response.headers['access-control-allow-methods'], /PUT/);
    assert.match(response.headers['access-control-allow-methods'], /PATCH/);
    assert.match(response.headers['access-control-allow-methods'], /DELETE/);
    assert.match(response.headers['access-control-allow-methods'], /OPTIONS/);
    assert.match(response.headers['access-control-allow-headers'].toLowerCase(), /content-type/);
    assert.match(response.headers['access-control-allow-headers'].toLowerCase(), /authorization/);
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
