import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { db, findDriverByUser, id, timestamp } from '../../database/store.js';
import { fail, ok, paginate } from '../../shared/core.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/errors.js';

const router = Router();
router.use(requireAuth);

// Helper functions
const driverOf = (req) => findDriverByUser(req.user.id);

const requireDriver = (req, res) => {
  const driver = driverOf(req);
  if (!driver) {
    fail(res, 404, 'Driver profile not found', 'DRIVER_NOT_FOUND');
    return null;
  }
  return driver;
};

// Validation Schemas
const bankAccountSchema = z.object({
  bankName: z.string().min(2),
  accountNumber: z.string().min(6),
  accountName: z.string().min(2),
});

const withdrawalSchema = z.object({
  amount: z.number().positive(),
});

const cngLogSchema = z.object({
  quantity: z.number().positive(),
  cost: z.number().positive(),
  stationLocation: z.string().min(2),
  transactionReference: z.string().optional(),
});

const ratingSchema = z.object({
  rideId: z.string(),
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(500).optional(),
});

const complaintSchema = z.object({
  rideId: z.string().optional(),
  category: z.string().min(2),
  description: z.string().min(5),
});

const supportTicketSchema = z.object({
  subject: z.string().min(2),
  description: z.string().min(5),
});

const promoSchema = z.object({
  code: z.string().min(2).max(40),
  fareTotal: z.number().nonnegative(),
});

const fcmTokenSchema = z.object({
  token: z.string().min(10).max(4096),
});

const savedPlaceSchema = z.object({
  name: z.string().min(1).max(80),
  latitude: z.number().gte(-90).lte(90),
  longitude: z.number().gte(-180).lte(180),
  address: z.string().max(250).optional(),
});

const ticketMessageSchema = z.object({
  message: z.string().min(1).max(3000),
});

// --- Driver Subscription Routes ---

router.get('/subscriptions/status', requireRole('driver'), (req, res) => {
  const driver = requireDriver(req, res);
  if (!driver) return;

  const subscription = db.subscriptions.find(
    (x) => x.driverId === driver.id && x.status === 'active' && new Date(x.expiresAt) > new Date()
  );

  return ok(res, 'Subscription status', {
    status: subscription ? 'active' : 'expired',
    dailyFee: env.dailyFee,
    subscription: subscription || null,
  });
});

router.post('/subscriptions/pay', requireRole('driver'), (req, res) => {
  const driver = requireDriver(req, res);
  if (!driver) return;

  const startsAt = timestamp();
  const expiresAt = new Date(Date.now() + 86400000).toISOString();

  const subscription = {
    id: id(),
    driverId: driver.id,
    amount: env.dailyFee,
    status: 'active',
    startsAt,
    expiresAt,
    paymentReference: `demo_${id()}`,
    createdAt: startsAt,
  };

  db.subscriptions.push(subscription);
  db.walletTransactions.push({
    id: id(),
    driverId: driver.id,
    type: 'subscription_payment',
    amount: env.dailyFee,
    createdAt: startsAt,
  });

  return ok(res, 'Subscription activated', { subscription }, 201);
});

router.get('/subscriptions/history', requireRole('driver'), (req, res) => {
  const driver = requireDriver(req, res);
  if (!driver) return;

  const subscriptions = db.subscriptions.filter((s) => s.driverId === driver.id);
  return ok(res, 'Subscription history', { subscriptions });
});

// --- Driver Wallet Routes ---

router.get('/wallet/summary', requireRole('driver'), (req, res) => {
  const driver = requireDriver(req, res);
  if (!driver) return;

  const transactions = db.walletTransactions.filter((x) => x.driverId === driver.id);
  const balance = transactions.reduce((sum, x) => sum + Number(x.amount || 0), 0);

  return ok(res, 'Wallet summary', { balance, transactions });
});

router.get('/wallet/transactions', requireRole('driver'), (req, res) => {
  const driver = requireDriver(req, res);
  if (!driver) return;

  const transactions = db.walletTransactions.filter((x) => x.driverId === driver.id);
  return ok(res, 'Wallet transactions', paginate(transactions, req.query.page, req.query.limit));
});

router.post(
  '/wallet/bank-account',
  requireRole('driver'),
  validate(bankAccountSchema),
  (req, res) => {
    const driver = requireDriver(req, res);
    if (!driver) return;

    driver.bankAccount = { ...req.body, updatedAt: timestamp() };
    return ok(res, 'Bank account saved', { bankAccount: driver.bankAccount });
  }
);

router.post(
  '/wallet/withdraw',
  requireRole('driver'),
  validate(withdrawalSchema),
  (req, res) => {
    const driver = requireDriver(req, res);
    if (!driver) return;

    const withdrawal = {
      id: id(),
      driverId: driver.id,
      amount: req.body.amount,
      status: 'pending',
      createdAt: timestamp(),
    };

    db.withdrawals.push(withdrawal);
    return ok(res, 'Withdrawal request submitted', { withdrawal }, 201);
  }
);

router.get('/wallet/withdrawals', requireRole('driver'), (req, res) => {
  const driver = requireDriver(req, res);
  if (!driver) return;

  const withdrawals = db.withdrawals.filter((w) => w.driverId === driver.id);
  return ok(res, 'Withdrawal history', { withdrawals });
});

// --- CNG Operations Routes ---

router.get('/cng/unitconfig', (_req, res) => {
  return ok(res, 'CNG unit configuration', { unit: env.cngUnit });
});

router.post('/cng/log', requireRole('driver'), validate(cngLogSchema), (req, res) => {
  const driver = requireDriver(req, res);
  if (!driver) return;

  const transaction = {
    id: id(),
    driverId: driver.id,
    ...req.body,
    recordedAt: timestamp(),
  };

  db.cngTransactions.push(transaction);
  return ok(res, 'CNG transaction recorded', { transaction }, 201);
});

router.get('/cng/history', requireRole('driver'), (req, res) => {
  const driver = requireDriver(req, res);
  if (!driver) return;

  const history = db.cngTransactions.filter((x) => x.driverId === driver.id);
  return ok(res, 'CNG history', paginate(history, req.query.page, req.query.limit));
});

router.get('/cng/summary', requireRole('driver'), (req, res) => {
  const driver = requireDriver(req, res);
  if (!driver) return;

  const rows = db.cngTransactions.filter((x) => x.driverId === driver.id);
  const totalQuantity = rows.reduce((sum, x) => sum + (x.quantity || 0), 0);
  const totalCost = rows.reduce((sum, x) => sum + (x.cost || 0), 0);

  return ok(res, 'CNG summary', {
    quantity: totalQuantity,
    cost: totalCost,
    unit: env.cngUnit,
  });
});

// --- Ratings & Complaints Routes ---

router.post('/ratings', requireRole('rider'), validate(ratingSchema), (req, res) => {
  const existing = db.ratings.some(
    (r) => r.rideId === req.body.rideId && r.riderId === req.user.id
  );

  if (existing) {
    return fail(res, 409, 'Ride already rated', 'ALREADY_RATED');
  }

  const rating = {
    id: id(),
    riderId: req.user.id,
    ...req.body,
    createdAt: timestamp(),
  };

  db.ratings.push(rating);
  return ok(res, 'Rating submitted', { rating }, 201);
});

router.post(
  '/complaints',
  requireRole('rider', 'driver'),
  validate(complaintSchema),
  (req, res) => {
    const complaint = {
      id: id(),
      userId: req.user.id,
      ...req.body,
      status: 'open',
      createdAt: timestamp(),
    };

    db.complaints.push(complaint);
    return ok(res, 'Complaint submitted', { complaint }, 201);
  }
);

// --- Promotions & Notifications Routes ---

router.post('/promo/validate', validate(promoSchema), (req, res) => {
  const promo = db.promotions.find(
    (p) =>
      p.code.toLowerCase() === req.body.code.trim().toLowerCase() &&
      p.active !== false &&
      (!p.expiresAt || new Date(p.expiresAt) > new Date())
  );

  if (!promo) {
    return fail(res, 404, 'Promo code is invalid or expired', 'PROMO_INVALID');
  }

  const discount =
    promo.type === 'percent'
      ? Math.round((req.body.fareTotal * Math.min(100, promo.value)) / 100)
      : Math.min(req.body.fareTotal, Number(promo.value));

  return ok(res, 'Promo validated', { discount });
});

router.post('/users/fcm-token', validate(fcmTokenSchema), (req, res) => {
  const user = db.users.find((u) => u.id === req.user.id);
  if (!user) return fail(res, 404, 'User not found', 'USER_NOT_FOUND');

  user.fcmToken = req.body.token;
  user.updatedAt = timestamp();
  return ok(res, 'Notification token saved');
});

router.get('/notifications', (req, res) => {
  const notifications = db.notifications.filter((n) => n.userId === req.user.id);
  return ok(res, 'Notifications', { notifications });
});

router.post('/notifications/:id/read', (req, res) => {
  const notification = db.notifications.find(
    (n) => n.id === req.params.id && n.userId === req.user.id
  );

  if (!notification) {
    return fail(res, 404, 'Notification not found', 'NOTIFICATION_NOT_FOUND');
  }

  notification.readAt = timestamp();
  notification.isRead = true;
  return ok(res, 'Notification marked read', { notification });
});

// --- Saved Places Routes ---

router.get('/places/saved', (req, res) => {
  return ok(res, 'Saved places', {
    places: db.savedPlaces.filter((p) => p.userId === req.user.id),
  });
});

router.post('/places/saved', validate(savedPlaceSchema), (req, res) => {
  const place = {
    id: id(),
    userId: req.user.id,
    ...req.body,
    createdAt: timestamp(),
  };

  db.savedPlaces.push(place);
  return ok(res, 'Saved place created', { place }, 201);
});

router.delete('/places/saved/:id', (req, res) => {
  const i = db.savedPlaces.findIndex(
    (p) => p.id === req.params.id && p.userId === req.user.id
  );

  if (i < 0) {
    return fail(res, 404, 'Saved place not found', 'SAVED_PLACE_NOT_FOUND');
  }

  db.savedPlaces.splice(i, 1);
  return ok(res, 'Saved place removed');
});

// --- Support Ticket Routes ---

router.get('/support/tickets', (req, res) => {
  const tickets = db.supportTickets.filter((t) => t.userId === req.user.id);
  return ok(res, 'Support tickets', { tickets });
});

router.post('/support/tickets', validate(supportTicketSchema), (req, res) => {
  const ticket = {
    id: id(),
    userId: req.user.id,
    ...req.body,
    status: 'open',
    createdAt: timestamp(),
  };

  db.supportTickets.push(ticket);
  return ok(res, 'Support ticket created', { ticket }, 201);
});

router.post('/support/tickets/:id/messages', validate(ticketMessageSchema), (req, res) => {
  const ticket = db.supportTickets.find(
    (t) => t.id === req.params.id && t.userId === req.user.id
  );

  if (!ticket) {
    return fail(res, 404, 'Support ticket not found', 'TICKET_NOT_FOUND');
  }

  ticket.messages = ticket.messages || [];
  const message = {
    id: id(),
    userId: req.user.id,
    message: req.body.message,
    createdAt: timestamp(),
  };

  ticket.messages.push(message);
  return ok(res, 'Support message sent', { message }, 201);
});

// --- Account Management Routes ---

router.delete('/account', (req, res) => {
  const user = db.users.find((u) => u.id === req.user.id);
  if (!user) return fail(res, 404, 'User not found', 'USER_NOT_FOUND');

  user.status = 'deletion_requested';
  user.deletionRequestedAt = timestamp();
  user.updatedAt = user.deletionRequestedAt;

  return ok(res, 'Account deletion request recorded', {
    status: user.status,
    requestedAt: user.deletionRequestedAt,
  });
});

export default router;

