import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { env } from './config/env.js';
import { errorHandler, notFound } from './middleware/errors.js';
import authRoutes from './modules/auth/routes.js';
import driverRoutes from './modules/drivers/routes.js';
import extendedDriverRoutes from './modules/drivers/extended-routes.js';
import rideRoutes from './modules/rides/routes.js';
import adminRoutes from './modules/admin/routes.js';
import operationsRoutes from './modules/operations/routes.js';
import safetyRoutes from './modules/safety/routes.js';
import userRoutes from './modules/users/routes.js';
import walletRoutes from './modules/wallet/routes.js';
import publicRoutes from './modules/public/routes.js';
import paymentRoutes from './modules/payments/routes.js';
import realtimeRoutes from './modules/realtime/routes.js';
import { ok } from './shared/core.js';
import { databaseProvider, isDatabaseConnected, persistToDatabase } from './database/store.js';
import { metricsSnapshot, requestMetrics } from './services/monitoring.js';
import { realtimeHealth } from './services/realtime.js';

const app = express();
const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const allowedOrigins = env.corsOrigin.split(',').map((origin) => origin.trim()).filter(Boolean);
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(requestMetrics);
app.use(helmet({ contentSecurityPolicy: env.isProduction ? undefined : false }));
app.use(cors({ origin: allowedOrigins.length === 1 ? allowedOrigins[0] : allowedOrigins, credentials: false }));
app.use(express.json({ limit: '1mb', verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use(morgan(env.isProduction ? 'combined' : 'dev'));
app.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const sendJson = res.json.bind(res);
  let persistenceStarted = false;
  res.json = (body) => {
    if (persistenceStarted) return res;
    persistenceStarted = true;
    persistToDatabase().then(() => sendJson(body)).catch((error) => {
      console.error('Database persistence failed:', error.message);
      if (res.headersSent) return;
      res.status(503);
      return sendJson({ success: false, message: 'The request could not be durably saved. Please retry safely.', data: null, error: { code: 'PERSISTENCE_FAILED', details: null } });
    });
    return res;
  };
  next();
});

app.use('/api/v1/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: 'draft-7', legacyHeaders: false }), authRoutes);

app.get('/health', (_req, res) => ok(res, 'Service healthy', { service: 'ride-platform-backend', environment: process.env.NODE_ENV || 'development', database: isDatabaseConnected() ? databaseProvider() : 'disconnected', realtime: realtimeHealth(), metrics: metricsSnapshot(), timestamp: new Date().toISOString() }));

app.get('/api/v1/app/version', (_req, res) => ok(res, 'App version information', { minimumSupportedVersion: process.env.MINIMUM_SUPPORTED_APP_VERSION || '1.0.0', latestVersion: process.env.LATEST_APP_VERSION || '1.0.0', storeLink: process.env.APP_STORE_LINK || null }));

app.use('/admin', express.static(path.join(projectRoot, '../public/admin')));
app.get('/trip/:token', (_req,res)=>res.sendFile(path.join(projectRoot,'../public/trip/index.html')));

app.get('/reset-password', (_req, res) => res.sendFile(path.join(projectRoot, '../public/reset-password/index.html')));

app.use('/reset-password', express.static(path.join(projectRoot, '../public/reset-password')));

app.use('/api/v1/public', publicRoutes);
app.use('/api/v1/users', userRoutes); app.use('/api/v1/safety', safetyRoutes); app.use('/api/v1/wallet', walletRoutes);
app.use('/api/v1/drivers', extendedDriverRoutes); app.use('/api/v1/drivers', driverRoutes); app.use('/api/v1/rides', rideRoutes); app.use('/api/v1/admin', adminRoutes); 

app.use('/api/v1', operationsRoutes); app.use('/api/v1/payments', paymentRoutes); app.use('/api/v1/realtime', realtimeRoutes);

app.use(notFound); app.use(errorHandler);

export default app;
