import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { validate } from '../../middleware/errors.js';
import { getPricing, savePricing } from '../../services/pricing.js';
import { db, findRide, findUser, id, notifyUser, timestamp } from '../../database/store.js';
import { asyncHandler, fail, ok, paginate } from '../../shared/core.js';
import { requireAuth, requireRole, requireAdminMfa } from '../../middleware/auth.js';
import { sendEmail } from '../../services/email.js';
import { submitIdentityCheck, updateIdentityCheck } from '../../services/identity.js';
import { enqueueJob } from '../../services/jobs.js';
import { isValidVehiclePlate, normalizeVehiclePlate } from '../../services/vehicle-plate.js';
import { signedPrivateUrl } from '../../services/storage.js';

const router = Router();
router.use(requireAuth, requireRole('admin'), requireAdminMfa);

// --- Validation Schemas ---

const pricingSchema = z.object({
  baseFare: z.number().nonnegative(),
  perKm: z.number().nonnegative(),
  perMinute: z.number().nonnegative(),
  minimumFare: z.number().nonnegative(),
  cashSurcharge: z.number().nonnegative(),
  nightSurcharge: z.number().nonnegative().optional().default(0),
});

const cngPricingSchema = z.object({
  unit: z.enum(['litres', 'litre', 'kg', 'scm']).transform((unit) => unit === 'litre' ? 'litres' : unit),
  pricePerUnit: z.number().positive().max(100000),
  presets: z.array(z.number().int().positive().max(1000000)).max(12).optional(),
  currency: z.literal('NGN').default('NGN'),
});
const vehicleReviewSchema = z.object({
  status: z.enum(['verified', 'rejected']),
  note: z.string().max(500).optional(),
});
const driverVerificationReviewSchema = z.object({
  status: z.enum(['approved', 'rejected', 'pending']),
  note: z.string().trim().max(500).optional(),
  reviewDocuments: z.boolean().optional(),
}).superRefine((value, ctx) => {
  if (value.status === 'rejected' && (!value.note || value.note.length < 3)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['note'], message: 'A rejection reason of at least 3 characters is required.' });
  }
});
const driverRejectSchema = z.object({ note: z.string().trim().min(3).max(500) });
const ninReviewSchema = z.object({
  status: z.enum(['verified', 'rejected', 'pending']),
  note: z.string().trim().max(500).optional(),
}).superRefine((value, ctx) => {
  if (['verified', 'rejected'].includes(value.status) && (!value.note || value.note.length < 3)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['note'], message: 'Record the authorized verification reference or rejection reason.' });
  }
});

const promotionSchema = z.object({
  code: z.string().min(2).max(40),
  type: z.enum(['percent', 'fixed']),
  value: z.number().positive(),
  active: z.boolean().default(true),
  expiresAt: z.string().datetime().optional(),
});

// --- Helper Functions ---

const audit = (req, action, resource, resourceId, metadata = {}) => {
  return db.auditLogs.push({
    id: id(),
    actorId: req.user.id,
    action,
    resource,
    resourceId,
    metadata,
    createdAt: timestamp(),
  });
};

const safeUser = (user) => {
  if (!user) return null;
  const { passwordHash, tokenVersion, adminMfaSecret, adminMfaPendingSecret, adminMfaPendingExpiresAt, adminMfaLastCounter, ...publicRecord } = user;
  return publicRecord;
};

const productionIdentityReady = (driver, res) => {
  if (!env.isProduction) return true;
  if (driver.verification?.nin?.status !== 'verified') {
    fail(res, 409, 'NIN must be verified before approving a driver.', 'NIN_NOT_VERIFIED');
    return false;
  }
  const faceApproved = db.identityChecks.some(
    (item) => item.driverId === driver.id && item.type === 'aws_face_liveness' && item.status === 'approved'
  );
  if (!faceApproved) {
    fail(res, 409, 'Face verification must pass before approving a driver.', 'FACE_NOT_VERIFIED');
    return false;
  }
  return true;
};

const driverView = (driver) => ({
  ...driver,
  user: safeUser(findUser({ id: driver.userId })),
});

const csv = (rows) => {
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const quote = (value) => {
    const text = String(value ?? '');
    const safe = /^[\u0000-\u0020]*[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  };

  return [
    keys.join(','),
    ...rows.map((row) =>
      keys
        .map((key) =>
          quote(typeof row[key] === 'object' ? JSON.stringify(row[key]) : row[key])
        )
        .join(',')
    ),
  ].join('\n');
};

function reviewDriver(req, res, status) {
  const driver = db.drivers.find((d) => d.id === req.params.id);
  if (!driver) return fail(res, 404, 'Driver not found', 'DRIVER_NOT_FOUND');
  if (status === 'approved' && !productionIdentityReady(driver, res)) return;

  driver.verificationStatus = status;
  driver.status = status === 'approved' ? 'active' : 'pending';
  driver.reviewedAt = timestamp();
  driver.reviewNote = req.body.note || null;
  notifyUser(driver.userId, {
    title: status === 'approved' ? 'Driver application approved' : 'Driver application rejected',
    body: status === 'approved' ? 'Your driver account has been approved.' : (driver.reviewNote || 'Your driver application was rejected.'),
    kind: status === 'approved' ? 'driver_approved' : 'driver_rejected',
    data: { driverId: driver.id, note: driver.reviewNote },
  });

  audit(req, status, 'driver', driver.id, { note: driver.reviewNote });
  return ok(res, `Driver ${status}`, { driver });
}

// --- Pricing Routes ---

router.get('/pricing', (req, res) =>
  ok(res, 'Current ride pricing', {
    pricing: getPricing(),
    audit: db.auditLogs.filter((x) => x.resource === 'pricing').slice(-50).reverse(),
  })
);

router.put('/pricing', validate(pricingSchema), (req, res) => {
  const pricing = savePricing(req.body, req.user.id);
  audit(req, 'update', 'pricing', pricing.id, { version: pricing.version, values: req.body });
  return ok(res, 'Pricing updated for new rides', { pricing });
});

router.get('/pricing/report', (req, res) => {
  const rows = db.rides
    .filter((r) => r.status === 'completed')
    .map((ride) => {
      const payment = db.payments.find((p) => p.rideId === ride.id && p.type === 'ride') || null;
      const paidInCash = payment?.status === 'successful' && payment.provider === 'cash';
      return {
        rideId: ride.id,
        tariffVersion: ride.tariffVersion ?? ride.fareBreakdown?.tariffVersion ?? null,
        paymentMethod: ride.paymentMethod || null,
        basePrice: ride.fareBreakdown?.appFare ?? ride.fare ?? 0,
        cashSurchargeCollected: paidInCash
          ? Math.max(0, Number(payment.amount) - Number(ride.fareBreakdown?.appFare ?? ride.fare ?? 0))
          : 0,
        paymentStatus: payment?.status || 'unpaid',
        provider: payment?.provider || null,
      };
    });

  return ok(res, 'Fare and payment report', {
    trips: rows,
    totals: {
      inApp: rows.filter((x) => x.paymentStatus === 'successful' && x.provider !== 'cash').length,
      cash: rows.filter((x) => x.paymentStatus === 'successful' && x.provider === 'cash').length,
      unpaid: rows.filter((x) => x.paymentStatus !== 'successful').length,
      cashSurchargeCollected: rows.reduce((n, x) => n + x.cashSurchargeCollected, 0),
    },
  });
});

// --- CNG price configuration ---
router.get('/cng-pricing', (_req, res) => {
  const pricing = db.cngPricingConfigs[0] || null;
  return ok(res, 'CNG pricing', {
    pricing: pricing ? { ...pricing, presets: pricing.presets || [] } : null,
    configured: Boolean(pricing),
  });
});
router.put('/cng-pricing', validate(cngPricingSchema), (req, res) => {
  const old = db.cngPricingConfigs[0];
  const pricing = {
    id: old?.id || id(),
    ...req.body,
    presets: req.body.presets || old?.presets || [],
    currency: 'NGN',
    version: Number(old?.version || 0) + 1,
    updatedAt: timestamp(),
    updatedBy: req.user.id,
    createdAt: old?.createdAt || timestamp(),
  };
  if (old) Object.assign(old, pricing);
  else db.cngPricingConfigs.push(pricing);
  audit(req, 'update', 'cng-pricing', pricing.id, { unit: pricing.unit, pricePerUnit: pricing.pricePerUnit, version: pricing.version });
  return ok(res, 'CNG price updated for new prepaid orders', { pricing });
});

// --- Promotions Routes ---

router.get('/promotions', (_req, res) => ok(res, 'Promotions', { promotions: db.promotions }));

router.post('/promotions', validate(promotionSchema), (req, res) => {
  const code = req.body.code.trim().toUpperCase();
  if (db.promotions.some((p) => p.code === code)) {
    return fail(res, 409, 'Promo code already exists', 'PROMO_EXISTS');
  }

  const promo = {
    id: id(),
    ...req.body,
    code,
    createdAt: timestamp(),
    updatedAt: timestamp(),
  };

  db.promotions.push(promo);
  audit(req, 'create', 'promotion', promo.id, { code });
  return ok(res, 'Promotion created', { promotion: promo }, 201);
});

router.delete('/promotions/:id', (req, res) => {
  const i = db.promotions.findIndex((p) => p.id === req.params.id);
  if (i < 0) return fail(res, 404, 'Promotion not found', 'PROMO_NOT_FOUND');

  const [promo] = db.promotions.splice(i, 1);
  audit(req, 'delete', 'promotion', promo.id, { code: promo.code });
  return ok(res, 'Promotion deleted', { id: promo.id });
});

// --- Dashboard & Analytics Routes ---

router.get('/dashboard', (_req, res) => {
  return ok(res, 'Admin dashboard', {
    users: db.users.length,
    riders: db.riders.length,
    drivers: db.drivers.length,
    rides: db.rides.length,
    activeDrivers: db.drivers.filter((d) => d.onlineStatus && d.status === 'active').length,
    completedRides: db.rides.filter((r) => r.status === 'completed').length,
    pendingDrivers: db.drivers.filter((d) => d.verificationStatus !== 'approved').length,
    openSos: db.sosEvents.filter((s) => ['open', 'acknowledged', 'dispatched'].includes(s.status)).length,
    pendingWithdrawals: db.withdrawals.filter((w) => w.status === 'pending').length,
    pendingDocuments: db.documents.filter((d) => d.status === 'pending').length,
    activeSubscriptions: db.subscriptions.filter(
      (s) => s.status === 'active' && new Date(s.expiresAt) > new Date()
    ).length,
    totalRevenue: db.payments
      .filter((p) => p.status === 'successful')
      .reduce((sum, p) => sum + Number(p.amount || 0), 0),
    totalPayouts: db.withdrawals
      .filter((w) => w.status === 'paid')
      .reduce((sum, w) => sum + Number(w.amount || 0), 0),
  });
});

router.get('/analytics', (req, res) => {
  const from = req.query.from
    ? new Date(req.query.from)
    : new Date(Date.now() - 30 * 86400000);
  const to = req.query.to ? new Date(req.query.to) : new Date();

  const inRange = (row) => {
    const value = new Date(row.createdAt || row.requestedAt || row.recordedAt || 0);
    return value >= from && value <= to;
  };

  const rides = db.rides.filter(inRange);
  const payments = db.payments.filter(inRange);
  const subs = db.subscriptions.filter(inRange);
  const cng = db.cngTransactions.filter(inRange);

  const byDay = (rows, amountKey) =>
    Object.entries(
      Object.groupBy(
        rows,
        (row) => (row.createdAt || row.requestedAt || row.recordedAt || '').slice(0, 10)
      )
    ).map(([date, values]) => ({
      date,
      count: values.length,
      amount: amountKey
        ? values.reduce((sum, row) => sum + Number(row[amountKey] || 0), 0)
        : undefined,
    }));

  return ok(res, 'Analytics', {
    range: { from: from.toISOString(), to: to.toISOString() },
    rides: {
      total: rides.length,
      completed: rides.filter((r) => r.status === 'completed').length,
      cancelled: rides.filter((r) => r.status === 'cancelled').length,
      byDay: byDay(rides),
    },
    revenue: {
      total: payments
        .filter((p) => p.status === 'successful')
        .reduce((sum, p) => sum + Number(p.amount || 0), 0),
      byDay: byDay(payments.filter((p) => p.status === 'successful'), 'amount'),
    },
    subscriptions: {
      total: subs.length,
      amount: subs.reduce((sum, s) => sum + Number(s.amount || 0), 0),
      byDay: byDay(subs, 'amount'),
    },
    cng: {
      total: cng.length,
      quantity: cng.reduce((sum, row) => sum + Number(row.quantity || 0), 0),
      amount: cng.reduce((sum, row) => sum + Number(row.amount || row.cost || 0), 0),
    },
  });
});

router.get('/reports', (_req, res) => {
  return ok(res, 'Reports', {
    ridesByStatus: Object.fromEntries(
      [...new Set(db.rides.map((r) => r.status))].map((s) => [
        s,
        db.rides.filter((r) => r.status === s).length,
      ])
    ),
    totalPayments: db.payments.reduce((sum, p) => sum + Number(p.amount || 0), 0),
  });
});


router.get('/users/search', (req, res) => {
  const query = String(req.query.q || '').trim().toLowerCase();
  const rows = db.users
    .filter((user) =>
      !query ||
      [user.name, user.email, user.phone, user.role].some((value) =>
        String(value || '').toLowerCase().includes(query)
      )
    )
    .map(safeUser);

  return ok(res, 'User search', paginate(rows, req.query.page, req.query.limit));
});

router.get('/riders', (req, res) => {
  const riders = db.users.filter((u) => u.role === 'rider').map(safeUser);
  return ok(res, 'Riders', paginate(riders, req.query.page, req.query.limit));
});

router.get('/drivers', (req, res) => {
  const drivers = db.drivers.map(driverView);
  return ok(res, 'Drivers', paginate(drivers, req.query.page, req.query.limit));
});

router.get('/rides/:id/messages', (req, res) => {
  const ride = findRide(req.params.id);
  if (!ride) return fail(res, 404, 'Ride not found', 'RIDE_NOT_FOUND');
  const messages = (db.chatMessages || []).filter((message) => message.rideId === ride.id)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return ok(res, 'Ride messages', { rideId: ride.id, messages });
});

router.get('/support/tickets', (req, res) =>
  ok(res, 'Support tickets', paginate(db.supportTickets, req.query.page, req.query.limit))
);

router.post('/support/tickets/:id/messages', (req, res) => {
  const ticket = db.supportTickets.find((item) => item.id === req.params.id);
  const message = String(req.body.message || '').trim();
  if (!ticket) return fail(res, 404, 'Support ticket not found', 'TICKET_NOT_FOUND');
  if (!message || message.length > 3000) return fail(res, 400, 'Message is required and must be at most 3000 characters.', 'INVALID_MESSAGE');
  ticket.messages ||= [];
  const reply = { id: id(), userId: req.user.id, senderRole: 'admin', message, createdAt: timestamp() };
  ticket.messages.push(reply);
  ticket.updatedAt = reply.createdAt;
  notifyUser(ticket.userId, { title: 'Support replied', body: message, kind: 'support_reply', data: { ticketId: ticket.id } });
  return ok(res, 'Support reply sent', { message: reply }, 201);
});

router.put('/support/tickets/:id/close', (req, res) => {
  const ticket = db.supportTickets.find((item) => item.id === req.params.id);
  if (!ticket) return fail(res, 404, 'Support ticket not found', 'TICKET_NOT_FOUND');
  ticket.status = 'closed';
  ticket.closedAt = timestamp();
  ticket.closedBy = req.user.id;
  notifyUser(ticket.userId, { title: 'Support ticket closed', body: 'Your support ticket has been closed.', kind: 'support_closed', data: { ticketId: ticket.id } });
  return ok(res, 'Support ticket closed', { ticket });
});

router.put('/drivers/:id/approve', (req, res) => reviewDriver(req, res, 'approved'));
router.put('/drivers/:id/reject', validate(driverRejectSchema), (req, res) => reviewDriver(req, res, 'rejected'));

router.put('/drivers/:id/suspend', (req, res) => {
  const driver = db.drivers.find((d) => d.id === req.params.id);
  if (!driver) return fail(res, 404, 'Driver not found', 'DRIVER_NOT_FOUND');

  driver.status = 'suspended';
  driver.onlineStatus = false;
  notifyUser(driver.userId, {
    title: 'Driver account suspended',
    body: 'Your driver account has been suspended. Contact support for help.',
    kind: 'driver_suspended', data: { driverId: driver.id },
  });
  audit(req, 'suspend', 'driver', driver.id);

  return ok(res, 'Driver suspended', { driver });
});


router.get('/verification/queue', (req, res) => {
  const rows = db.drivers
    .filter(
      (driver) =>
        driver.verificationStatus !== 'approved' ||
        (driver.verification?.nin?.submittedAt && driver.verification.nin.status !== 'verified') ||
        db.documents.some((doc) => doc.driverId === driver.id && doc.status === 'pending')
    )
    .map((driver) => ({
      driver: driverView(driver),
      documents: db.documents
        .filter((doc) => doc.driverId === driver.id)
        .map(({ contentBase64, ...doc }) => doc),
      identity: driver.verification || null,
    }));

  return ok(res, 'Driver verification queue', paginate(rows, req.query.page, req.query.limit));
});

router.put('/drivers/:id/nin-review', validate(ninReviewSchema), (req, res) => {
  const driver = db.drivers.find((item) => item.id === req.params.id);
  if (!driver) return fail(res, 404, 'Driver not found', 'DRIVER_NOT_FOUND');
  const status = ['verified', 'rejected', 'pending'].includes(req.body.status) ? req.body.status : null;
  if (!status) return fail(res, 400, 'Status must be verified, rejected, or pending', 'INVALID_STATUS');
  if (!driver.verification?.nin?.submittedAt) return fail(res, 409, 'The driver must submit a NIN before it can be reviewed.', 'NIN_NOT_SUBMITTED');
  driver.verification ||= {};
  driver.verification.nin = {
    ...(driver.verification.nin || {}),
    status,
    reviewedAt: timestamp(),
    reviewedBy: req.user.id,
    reviewNote: req.body.note || null,
  };
  audit(req, 'review', 'driver_nin', driver.id, { status, note: req.body.note || null });
  notifyUser(driver.userId, {
    title: status === 'verified' ? 'NIN verified' : status === 'rejected' ? 'NIN verification rejected' : 'NIN review updated',
    body: req.body.note || (status === 'verified' ? 'Your NIN has been verified.' : status === 'rejected' ? 'Your NIN could not be verified. Please resubmit.' : 'Your NIN is still under review.'),
    kind: `nin_${status}`, data: { driverId: driver.id, note: req.body.note || null },
  });
  return ok(res, 'NIN review saved', { verification: { nin: driver.verification.nin } });
});
router.put('/drivers/:id/verification-review', validate(driverVerificationReviewSchema), (req, res) => {
  const driver = db.drivers.find((item) => item.id === req.params.id);
  if (!driver) return fail(res, 404, 'Driver not found', 'DRIVER_NOT_FOUND');

  const status = ['approved', 'rejected', 'pending'].includes(req.body.status)
    ? req.body.status
    : null;
  if (!status) return fail(res, 400, 'Status must be approved, rejected, or pending', 'INVALID_STATUS');
  if (status === 'approved' && !productionIdentityReady(driver, res)) return;

  driver.verificationStatus = status;
  driver.status = status === 'approved' ? 'active' : 'pending';
  driver.reviewedAt = timestamp();
  driver.reviewNote = req.body.note || null;
  notifyUser(driver.userId, {
    title: status === 'approved' ? 'Driver application approved' : status === 'rejected' ? 'Driver application rejected' : 'Driver review updated',
    body: status === 'approved' ? 'Your driver account has been approved.' : status === 'rejected' ? (req.body.note || 'Your driver application was rejected.') : 'Your driver verification is still under review.',
    kind: `driver_${status}`, data: { driverId: driver.id, note: req.body.note || null },
  });

  db.documents
    .filter((doc) => doc.driverId === driver.id && req.body.reviewDocuments !== false)
    .forEach((doc) => {
      doc.status = status;
      doc.reviewedAt = timestamp();
      doc.reviewNote = req.body.note || null;
    });

  audit(req, 'review', 'driver_verification', driver.id, { status, note: req.body.note || null });
  return ok(res, 'Driver verification reviewed', { driver: driverView(driver) });
});

router.put('/documents/:id/review', (req, res) => {
  const document = db.documents.find((item) => item.id === req.params.id);
  if (!document) return fail(res, 404, 'Document not found', 'DOCUMENT_NOT_FOUND');

  if (!['approved', 'rejected', 'pending'].includes(req.body.status)) {
    return fail(res, 400, 'Invalid document status', 'INVALID_STATUS');
  }

  Object.assign(document, {
    status: req.body.status,
    reviewNote: req.body.note || null,
    reviewedAt: timestamp(),
  });

  audit(req, 'review', 'document', document.id, req.body);
  return ok(res, 'Document reviewed', { document: { ...document, contentBase64: undefined } });
});

router.get('/documents/:id/signed-url', asyncHandler(async (req, res) => {
  const document = db.documents.find((item) => item.id === req.params.id);
  if (!document) return fail(res, 404, 'Document not found', 'DOCUMENT_NOT_FOUND');
  if (!document.storage?.stored || !document.storage.path) {
    return fail(res, 503, 'This document is not available in private storage.', 'DOCUMENT_STORAGE_UNAVAILABLE');
  }
  const url = await signedPrivateUrl(document.storage.path, 300);
  if (!url) return fail(res, 503, 'Private document storage is not configured.', 'STORAGE_NOT_CONFIGURED');
  return ok(res, 'Short-lived document URL created', { url, expiresInSeconds: 300 });
}));

router.get('/vehicle-verification/queue', (req, res) => {
  const rows = db.drivers
    .filter((driver) => driver.vehicleVerificationStatus !== 'verified')
    .map((driver) => ({
      driver: driverView(driver),
      registrationDocuments: db.documents
        .filter((document) => document.driverId === driver.id && document.documentType === 'vehicle_registration')
        .map(({ contentBase64, ...document }) => document),
    }));
  return ok(res, 'Vehicle verification queue', paginate(rows, req.query.page, req.query.limit));
});

router.put('/drivers/:id/vehicle-review', validate(vehicleReviewSchema), (req, res) => {
  const driver = db.drivers.find((item) => item.id === req.params.id);
  if (!driver) return fail(res, 404, 'Driver not found', 'DRIVER_NOT_FOUND');
  if (!driver.vehiclePlateNumber || !isValidVehiclePlate(driver.vehiclePlateNumber)) {
    return fail(res, 409, 'Driver must submit a valid vehicle plate before review.', 'VEHICLE_PLATE_REQUIRED');
  }
  if (req.body.status === 'verified') {
    const approvedDocument = db.documents.some(
      (document) => document.driverId === driver.id && document.documentType === 'vehicle_registration' && document.status === 'approved'
    );
    if (!approvedDocument) {
      return fail(res, 409, 'Approve a vehicle registration document before verifying this plate.', 'VEHICLE_DOCUMENT_NOT_APPROVED');
    }
    const duplicate = db.drivers.some(
      (other) => other.id !== driver.id && other.vehicleVerificationStatus === 'verified' && normalizeVehiclePlate(other.vehiclePlateNumber) === normalizeVehiclePlate(driver.vehiclePlateNumber)
    );
    if (duplicate) return fail(res, 409, 'This plate is already verified on another driver account.', 'VEHICLE_PLATE_IN_USE');
  }
  driver.vehicleVerificationStatus = req.body.status;
  driver.vehicleVerifiedAt = req.body.status === 'verified' ? timestamp() : null;
  driver.vehicleReviewedBy = req.user.id;
  driver.vehicleReviewNote = req.body.note || null;
  driver.vehicleReviewedAt = timestamp();
  if (req.body.status === 'rejected') driver.onlineStatus = false;
  audit(req, req.body.status, 'driver_vehicle', driver.id, {
    plateNumber: driver.vehiclePlateNumber,
    note: req.body.note || null,
  });
  return ok(res, 'Vehicle review saved', {
    driver: driverView(driver),
    vehicleVerificationStatus: driver.vehicleVerificationStatus,
  });
});

router.post('/identity/checks', (req, res) => {
  const check = submitIdentityCheck({
    driverId: req.body.driverId,
    type: req.body.type,
    reference: req.body.reference,
    metadata: req.body.metadata,
  });
  return ok(res, 'Identity check queued', { check }, 202);
});

router.get('/identity/checks', (req, res) => {
  const checks = db.identityChecks
    .map(({ ninHash, selfieStorage, ...check }) => check)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return ok(res, 'Identity checks', { checks });
});

router.put('/identity/checks/:id', (req, res) => {
  if (!['approved', 'rejected', 'manual_review', 'provider_pending', 'failed'].includes(req.body.status)) {
    return fail(res, 400, 'Invalid identity status', 'INVALID_STATUS');
  }

  const check = updateIdentityCheck(req.params.id, req.body.status, {
    note: req.body.note || null,
  });
  if (!check) return fail(res, 404, 'Identity check not found', 'IDENTITY_CHECK_NOT_FOUND');

  if (check.userId) {
    const user = db.users.find((u) => u.id === check.userId);
    if (user) {
      user.ninVerificationStatus = check.status;
      user.ninVerified = check.status === 'approved';
      user.updatedAt = timestamp();
    }
  }

  audit(req, 'update', 'identity_check', check.id, { status: check.status });
  const safeCheck = { ...check, ninHash: undefined, selfieStorage: undefined };
  return ok(res, 'Identity check updated', { check: safeCheck });
});

router.get('/rides', (req, res) => {
  const newestFirst = [...db.rides].sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  return ok(res, 'Rides', paginate(newestFirst, req.query.page, req.query.limit));
});

router.get('/rides/:id', (req, res) => {
  const ride = findRide(req.params.id);
  return ride
    ? ok(res, 'Ride', { ride })
    : fail(res, 404, 'Ride not found', 'RIDE_NOT_FOUND');
});

router.get('/dispatch/radar', (_req, res) => {
  return ok(res, 'Dispatch radar', {
    drivers: db.drivers
      .filter((d) => d.currentLocation)
      .map((driver) => ({
        driverId: driver.id,
        name: findUser({ id: driver.userId })?.name,
        status: driver.status,
        onlineStatus: driver.onlineStatus,
        location: driver.currentLocation,
      })),
    rides: db.rides.filter((ride) => !['completed', 'cancelled'].includes(ride.status)),
  });
});

router.get('/payments', (_req, res) => ok(res, 'Payments', { payments: db.payments }));

router.get('/subscriptions', (_req, res) => ok(res, 'Subscriptions', { subscriptions: db.subscriptions }));

router.get('/subscription-ledger', (req, res) => {
  const subscriptions = db.subscriptions
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return ok(res, 'Subscription ledger', {
    subscriptions: paginate(subscriptions, req.query.page, req.query.limit),
    fee: Number(process.env.DAILY_DRIVER_SUBSCRIPTION_FEE || 1500),
    currency: 'NGN',
  });
});

router.get('/wallet/withdrawals', (req, res) => {
  const withdrawals = db.withdrawals
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((withdrawal) => ({
      ...withdrawal,
      driver: driverView(db.drivers.find((d) => d.id === withdrawal.driverId)),
    }));

  return ok(res, 'Wallet withdrawals', {
    withdrawals: paginate(withdrawals, req.query.page, req.query.limit),
  });
});

router.put('/wallet/withdrawals/:id', (req, res) => {
  const withdrawal = db.withdrawals.find((item) => item.id === req.params.id);
  if (!withdrawal) return fail(res, 404, 'Withdrawal not found', 'WITHDRAWAL_NOT_FOUND');

  if (!['pending', 'approved', 'paid', 'rejected'].includes(req.body.status)) {
    return fail(res, 400, 'Invalid withdrawal status', 'INVALID_STATUS');
  }

  Object.assign(withdrawal, {
    status: req.body.status,
    adminNote: req.body.note || null,
    reviewedAt: timestamp(),
  });

  const driver = db.drivers.find((item) => item.id === withdrawal.driverId);
  const user = findUser({ id: driver?.userId });

  if (user?.email) {
    sendEmail({
      to: user.email,
      subject: `SwitchRide withdrawal ${withdrawal.status}`,
      text: `Your withdrawal of NGN ${Number(withdrawal.amount).toLocaleString()} is now ${withdrawal.status}.`,
      html: `<p>Your withdrawal of <strong>NGN ${Number(withdrawal.amount).toLocaleString()}</strong> is now <strong>${withdrawal.status}</strong>.</p>`,
    }).catch((error) => console.error('Withdrawal email failed:', error.message));
  }

  audit(req, 'update', 'withdrawal', withdrawal.id, req.body);
  return ok(res, 'Withdrawal updated', { withdrawal });
});

router.post('/wallet/withdrawals/:id/process', (req, res) => {
  const withdrawal = db.withdrawals.find((item) => item.id === req.params.id);
  if (!withdrawal) return fail(res, 404, 'Withdrawal not found', 'WITHDRAWAL_NOT_FOUND');
  if (withdrawal.status !== 'approved') {
    return fail(res, 409, 'Withdrawal must be approved before payout processing.', 'WITHDRAWAL_NOT_APPROVED');
  }

  const job = enqueueJob(
    'payout.process',
    { withdrawalId: withdrawal.id },
    { dedupeKey: `payout:${withdrawal.id}` }
  );

  return ok(res, 'Payout queued for provider processing', { withdrawal, job }, 202);
});


router.get('/cng-transactions', (_req, res) => ok(res, 'CNG transactions', { transactions: db.cngTransactions }));

router.get('/cng/summary', (_req, res) => {
  const transactions = db.cngTransactions;
  return ok(res, 'CNG summary', {
    totalRefuels: transactions.length,
    totalQuantity: transactions.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
    totalAmount: transactions.reduce((sum, item) => sum + Number(item.amount || 0), 0),
    byStation: Object.entries(
      Object.groupBy(transactions, (item) => item.station || 'Unknown')
    ).map(([station, rows]) => ({
      station,
      refuels: rows.length,
      amount: rows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
      quantity: rows.reduce((sum, row) => sum + Number(row.quantity || 0), 0),
    })),
  });
});


router.get('/complaints', (_req, res) => ok(res, 'Complaints', { complaints: db.complaints }));

router.put('/complaints/:id', (req, res) => {
  const complaint = db.complaints.find((c) => c.id === req.params.id);
  if (!complaint) return fail(res, 404, 'Complaint not found', 'COMPLAINT_NOT_FOUND');

  Object.assign(complaint, req.body, {
    updatedAt: timestamp(),
    resolvedAt: req.body.status === 'resolved' ? timestamp() : complaint.resolvedAt,
  });

  audit(req, 'update', 'complaint', complaint.id, req.body);
  return ok(res, 'Complaint updated', { complaint });
});

router.get('/sos', (req, res) => {
  const alerts = db.sosEvents.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return ok(res, 'SOS alerts', { alerts: paginate(alerts, req.query.page, req.query.limit) });
});

router.put('/sos/:id', (req, res) => {
  const event = db.sosEvents.find((item) => item.id === req.params.id);
  if (!event) return fail(res, 404, 'SOS alert not found', 'SOS_NOT_FOUND');

  if (!['open', 'acknowledged', 'dispatched', 'resolved', 'false_alarm'].includes(req.body.status)) {
    return fail(res, 400, 'Invalid SOS status', 'INVALID_STATUS');
  }

  Object.assign(event, {
    status: req.body.status,
    responderNote: req.body.note || event.responderNote || null,
    updatedAt: timestamp(),
  });

  audit(req, 'update', 'sos', event.id, req.body);
  return ok(res, 'SOS alert updated', { sos: event });
});


router.get('/penalties', (req, res) => {
  const penalties = db.auditLogs.filter((log) => ['cancel', 'penalty'].includes(log.action));
  return ok(res, 'Cancellation and penalty audit', {
    penalties: paginate(penalties, req.query.page, req.query.limit),
  });
});

router.post('/penalties', (req, res) => {
  const penalty = {
    id: id(),
    driverId: req.body.driverId || null,
    rideId: req.body.rideId || null,
    amount: Number(req.body.amount || 0),
    reason: req.body.reason || 'Manual admin penalty',
    status: 'recorded',
    createdAt: timestamp(),
  };

  db.auditLogs.push({
    id: id(),
    actorId: req.user.id,
    action: 'penalty',
    resource: 'penalty',
    resourceId: penalty.id,
    metadata: penalty,
    createdAt: penalty.createdAt,
  });

  return ok(res, 'Penalty recorded', { penalty }, 201);
});


router.get('/audit-logs', (req, res) => {
  const logs = db.auditLogs.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return ok(res, 'Audit logs', { logs: paginate(logs, req.query.page, req.query.limit) });
});

router.get('/exports/:resource', (req, res) => {
  const sources = {
    drivers: db.drivers.map(driverView),
    rides: db.rides,
    payments: db.payments,
    withdrawals: db.withdrawals,
    subscriptions: db.subscriptions,
    cng: db.cngTransactions,
    audit: db.auditLogs,
  };

  const rows = sources[req.params.resource];
  if (!rows) return fail(res, 404, 'Export resource not found', 'EXPORT_NOT_FOUND');

  res
    .type('text/csv')
    .set('Content-Disposition', `attachment; filename=${req.params.resource}.csv`)
    .send(csv(rows));
});

const reopenAccountSchema = z.object({ reason: z.string().min(5).max(300) });
router.post('/drivers/:id/reopen-account', validate(reopenAccountSchema), (req, res) => {
  const driver = db.drivers.find((item) => item.id === req.params.id);
  if (!driver) return fail(res, 404, 'Driver not found', 'DRIVER_NOT_FOUND');
  const user = findUser({ id: driver.userId });
  if (!user || user.status !== 'closed') return fail(res, 409, 'This driver account is not closed.', 'ACCOUNT_NOT_CLOSED');
  user.status = ['active', 'pending'].includes(user.statusBeforeClosure) ? user.statusBeforeClosure : 'active';
  user.reopenedAt = timestamp(); user.reopenReason = req.body.reason; user.updatedAt = user.reopenedAt;
  driver.status = 'pending'; driver.onlineStatus = false; driver.reopenedAt = user.reopenedAt;
  audit(req, 'reopen', 'driver_account', driver.id, { reason: req.body.reason, approvalRequired: true });
  return ok(res, 'Driver account reopened. Fresh approval is required before dispatch.', { status: user.status, driver_status: driver.status, online: false });
});

export default router;
