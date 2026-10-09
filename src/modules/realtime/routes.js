import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { db, findRide, id, timestamp, publicUser } from '../../database/store.js';
import { fail, ok } from '../../shared/core.js';
import { requireAuth } from '../../middleware/auth.js';
import { canAccessRide, streamRideEvents, realtimeHealth } from '../../services/realtime.js';

const router = Router();

// Custom authentication middleware for SSE streams
const streamAuth = (req, res, next) => {
  if (req.headers.authorization?.startsWith('Bearer ')) {
    return requireAuth(req, res, next);
  }

  const raw = req.query.token;
  if (typeof raw !== 'string') {
    return fail(res, 401, 'Authentication required', 'AUTH_REQUIRED');
  }

  const hash = createHash('sha256').update(raw).digest('hex');
  const ticket = (db.sseTokens || []).find(
    (item) =>
      item.tokenHash === hash &&
      !item.usedAt &&
      new Date(item.expiresAt) > new Date()
  );

  const user = ticket && db.users.find((item) => item.id === ticket.userId);

  if (!ticket || !user) {
    return fail(
      res,
      401,
      'Stream ticket is invalid, expired, or already used',
      'INVALID_STREAM_TICKET'
    );
  }

  // Consume the single-use token and attach user metadata
  ticket.usedAt = timestamp();
  req.user = publicUser(user);
  req.sseTicketRideId = ticket.rideId;
  next();
};

// GET /api/v1/realtime/health - Real-time service health monitoring
router.get('/health', requireAuth, (_req, res) => {
  return res.json({
    success: true,
    data: realtimeHealth(),
    error: null,
  });
});

// POST /api/v1/realtime/stream-token - Generate single-use token for SSE streaming
router.post('/stream-token', requireAuth, (req, res) => {
  const ride = findRide(req.body?.rideId);

  if (!canAccessRide(req, ride)) {
    return fail(
      res,
      ride ? 403 : 404,
      ride ? 'Ride access denied' : 'Ride not found',
      ride ? 'FORBIDDEN' : 'RIDE_NOT_FOUND'
    );
  }

  const raw = randomBytes(32).toString('hex');

  // Clean up expired or already-used stream tickets
  db.sseTokens = db.sseTokens || [];
  db.sseTokens = db.sseTokens.filter(
    (t) => new Date(t.expiresAt) > new Date() && !t.usedAt
  );

  db.sseTokens.push({
    id: id(),
    userId: req.user.id,
    tokenHash: createHash('sha256').update(raw).digest('hex'),
    rideId: ride.id,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: timestamp(),
    usedAt: null,
  });

  return ok(
    res,
    'One-use stream ticket created',
    {
      token: raw,
      expiresInSeconds: 60,
      eventsUrl: `/api/v1/realtime/rides/${ride.id}/events?token=${raw}`,
    },
    201
  );
});

// GET /api/v1/realtime/rides/:id/events - Establish Server-Sent Events (SSE) connection
router.get('/rides/:id/events', streamAuth, (req, res) => {
  const ride = findRide(req.params.id);

  if (req.sseTicketRideId && req.sseTicketRideId !== ride?.id) {
    return fail(res, 403, 'Stream ticket is scoped to a different ride', 'FORBIDDEN');
  }

  if (!canAccessRide(req, ride)) {
    return fail(
      res,
      ride ? 403 : 404,
      ride ? 'Ride access denied' : 'Ride not found',
      ride ? 'FORBIDDEN' : 'RIDE_NOT_FOUND'
    );
  }

  return streamRideEvents(req, res, ride);
});

export default router;

