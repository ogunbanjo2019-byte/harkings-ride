  import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { env } from './config/env.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { createPersistenceMiddleware } from './middleware/persistence.js';
import authRoutes from './modules/auth/routes.js';
import driverRoutes from './modules/drivers/routes.js';
import extendedDriverRoutes from './modules/drivers/extended-routes.js';
import requiredDriverRoutes from './modules/drivers/required-routes.js';
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
import {
  databaseProvider,
  isDatabaseConnected,
  persistToDatabase,
} from './database/store.js';
import { metricsSnapshot, requestMetrics } from './services/monitoring.js';
import { realtimeHealth } from './services/realtime.js';

const app = express();
const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const allowedOrigins = env.corsOrigins;
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes('*')) return callback(null, '*');
    return callback(null, allowedOrigins.includes(origin) ? origin : false);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
  optionsSuccessStatus: 204,
};
morgan.token('safe-url', (req) => String(req.originalUrl || req.url || '').split('?')[0]);
const requestLogFormat = env.isProduction
  ? ':remote-addr - :method :safe-url :status :res[content-length] :response-time ms'
  : ':method :safe-url :status :res[content-length] :response-time ms';

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(requestMetrics);
app.use(
  helmet({
    contentSecurityPolicy: env.isProduction ? undefined : false,
  })
);
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(
  express.json({
    limit: '1mb',
    verify: (req, _res, buffer) => {
      req.rawBody = Buffer.from(buffer);
    },
  })
);
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use(morgan(requestLogFormat));
app.use(createPersistenceMiddleware(persistToDatabase));

app.use(
  '/api/v1/auth',
  (_req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('Pragma', 'no-cache'); next(); },
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 100,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  }),
  authRoutes
);

app.get('/health', (_req, res) =>
  ok(res, 'Service healthy', {
    service: 'ride-platform-backend',
    environment: process.env.NODE_ENV || 'development',
    database: isDatabaseConnected() ? databaseProvider() : 'disconnected',
    realtime: realtimeHealth(),
    metrics: metricsSnapshot(),
    timestamp: new Date().toISOString(),
  })
);

app.get('/api/v1/app/version', (_req, res) =>
  ok(res, 'App version information', {
    minimumSupportedVersion:
      process.env.MINIMUM_SUPPORTED_APP_VERSION || '1.0.0',
    latestVersion: process.env.LATEST_APP_VERSION || '1.0.0',
    storeLink: process.env.APP_STORE_LINK || null,
  })
);

app.use('/admin', express.static(path.join(projectRoot, '../public/admin')));
app.get('/trip/:token', (_req, res) =>
  res.sendFile(path.join(projectRoot, '../public/trip/index.html'))
);

app.get('/reset-password', (_req, res) =>
  res.sendFile(path.join(projectRoot, '../public/reset-password/index.html'))
);
app.use(
  '/reset-password',
  express.static(path.join(projectRoot, '../public/reset-password'))
);

app.use('/api/v1/public', publicRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/safety', safetyRoutes);
app.use('/api/v1/wallet', walletRoutes);

app.use('/api/v1/drivers', requiredDriverRoutes);
app.use('/api/v1/drivers', extendedDriverRoutes);
app.use('/api/v1/drivers', driverRoutes);
app.use('/api/v1/rides', rideRoutes);
app.use('/api/v1/admin', adminRoutes);

app.use('/api/v1/payments', paymentRoutes);
app.use('/api/v1/realtime', realtimeRoutes);
app.use('/api/v1', operationsRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;