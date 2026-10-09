import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { db, findDriverByUser, findRide, id, timestamp } from '../../database/store.js';
import { fail, ok, paginate, asyncHandler } from '../../shared/core.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/errors.js';
import {
  storePrivateFile,
  signedPrivateUrl,
  downloadPrivateFile,
  validateUpload,
} from '../../services/storage.js';
import {
  createLivenessSession,
  getLivenessResults,
  compareLivenessFaceToDocument,
} from '../../services/face-verification.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.uploadMaxBytes, files: 1 },
});

const faceSessionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  keyGenerator: (req) => req.user.id,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many face-verification sessions. Try again later.',
    data: null,
    error: { code: 'FACE_SESSION_RATE_LIMITED', details: null },
  },
});
router.use(requireAuth, requireRole('driver'));
const driverOf = (req) => findDriverByUser(req.user.id);
const requireDriver = (req, res) => {
  const driver = driverOf(req);
  if (!driver) {
    fail(res, 404, 'Driver profile not found', 'DRIVER_NOT_FOUND');
    return null;
  }
  return driver;
};

const walletFor = (driver) => {
  let wallet = db.wallets.find((item) => item.driverId === driver.id);
  if (!wallet) {
    wallet = {
      id: id(),
      driverId: driver.id,
      balance: 0,
      bankAccount: null,
      createdAt: timestamp(),
      updatedAt: timestamp(),
    };
    db.wallets.push(wallet);
  }
  return wallet;
};

const activeSubscription = (driver) => {
  return db.subscriptions.find(
    (s) => s.driverId === driver.id && s.status === 'active' && new Date(s.expiresAt) > new Date()
  );
};

const safeBank = (account) => {
  return account
    ? {
        bankCode: account.bankCode,
        accountName: account.accountName,
        accountNumberLast4: String(account.accountNumber).slice(-4),
        updatedAt: account.updatedAt,
      }
    : null;
};

const coordinateSchema = z.object({
  latitude: z.number().gte(-90).lte(90),
  longitude: z.number().gte(-180).lte(180),
});

const ninSchema = z.object({
  nin: z.string().min(5).max(30),
});

const faceSessionSchema = z.object({
  documentId: z.string().min(1),
  biometricConsent: z.literal(true),
  consentVersion: z.string().min(1).max(80),
});

const sessionOnlySchema = z.object({
  sessionId: z.string().min(10).max(200),
});

const sosTriggerSchema = z.object({
  tripId: z.string().min(1),
  latitude: z.number().gte(-90).lte(90),
  longitude: z.number().gte(-180).lte(180),
  note: z.string().max(500).optional(),
});

const subscriptionPaySchema = z.object({
  days: z.number().int().min(1).max(365).default(1),
  paymentReference: z.string().min(3).optional(),
});

const bankAccountSchema = z.object({
  bankCode: z.string().min(3).max(20),
  accountNumber: z.string().regex(/^\d{10}$/),
  accountName: z.string().min(2).max(120),
});

const withdrawSchema = z.object({
  amount: z.number().positive(),
  bankAccount: z
    .object({
      bankCode: z.string().min(3),
      accountNumber: z.string().regex(/^\d{10}$/),
      accountName: z.string().min(2),
    })
    .optional(),
});

const cngLogSchema = z.object({
  quantity: z.number().positive(),
  amount: z.number().nonnegative(),
  unit: z.string().min(1).max(20).optional(),
  station: z.string().max(120).optional(),
  odometer: z.number().nonnegative().optional(),
  filledAt: z.string().datetime().optional(),
});


router.get('/verification/status', (req, res) => {
  const driver = requireDriver(req, res);
  if (!driver) return;

  const documents = db.documents
    .filter((document) => document.driverId === driver.id)
    .map(({ storage, ...document }) => ({
      ...document,
      storage: storage ? { bucket: storage.bucket, path: storage.path } : null,
    }));

  return ok(res, 'Verification status', {
    driverStatus: driver.verificationStatus,
    identity: driver.verification
      ? {
          ...driver.verification,
          nin: driver.verification.nin ? { ...driver.verification.nin, value: undefined } : undefined,
        }
      : null,
    documents,
  });
});

router.post('/verification/nin', validate(ninSchema), (req, res) => {
  const driver = requireDriver(req, res);
  if (!driver) return;

  driver.verification = {
    ...(driver.verification || {}),
    nin: { value: req.body.nin, status: 'pending', submittedAt: timestamp() },
  };

  return ok(
    res,
    'NIN submitted for verification',
    { verification: { ...driver.verification.nin, value: undefined } },
    202
  );
});

router.post(
  '/verification/document',
  upload.single('document'),
  asyncHandler(async (req, res) => {
    const driver = requireDriver(req, res);
    if (!driver) return;

    if (!req.file) return fail(res, 400, 'Document file is required', 'FILE_REQUIRED');

    validateUpload(req.file);

    const documentId = id();
    const stored = await storePrivateFile({
      path: `drivers/${driver.id}/documents/${documentId}`,
      file: req.file,
    });

    const document = {
      id: documentId,
      driverId: driver.id,
      documentType: req.body.documentType,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      storage: stored,
      status: 'pending',
      createdAt: timestamp(),
    };

    db.documents.push(document);
    return ok(res, 'Document submitted for review', { document }, 202);
  })
);

router.post(
  '/verification/selfie',
  upload.single('selfie'),
  asyncHandler(async (req, res) => {
    const driver = requireDriver(req, res);
    if (!driver) return;

    if (!req.file) return fail(res, 400, 'Selfie file is required', 'FILE_REQUIRED');

    validateUpload(req.file, ['image/jpeg', 'image/png']);

    const selfieId = id();
    const stored = await storePrivateFile({
      path: `drivers/${driver.id}/selfies/${selfieId}`,
      file: req.file,
    });

    driver.verification = {
      ...(driver.verification || {}),
      selfie: {
        id: selfieId,
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size,
        storage: stored,
        status: 'pending',
        submittedAt: timestamp(),
      },
    };

    return ok(res, 'Selfie submitted for verification', { verification: driver.verification.selfie }, 202);
  })
);

router.post(
  '/verification/face/session',
  faceSessionLimiter,
  validate(faceSessionSchema),
  asyncHandler(async (req, res) => {
    const driver = requireDriver(req, res);
    if (!driver) return;

    if (env.identityProvider !== 'aws-rekognition') {
      return fail(res, 503, 'AWS face verification is not configured', 'FACE_PROVIDER_NOT_CONFIGURED');
    }

    if (req.body.consentVersion !== env.faceConsentVersion) {
      return fail(
        res,
        400,
        'The consent notice version is outdated. Refresh the verification page and review the current notice.',
        'CONSENT_VERSION_UNSUPPORTED'
      );
    }

    const document = db.documents.find(
      (item) => item.id === req.body.documentId && item.driverId === driver.id
    );

    if (!document?.storage?.stored || !document.storage.path) {
      return fail(
        res,
        400,
        'Choose an identity document stored in private storage before starting face verification',
        'IDENTITY_DOCUMENT_REQUIRED'
      );
    }

    if (!['image/jpeg', 'image/png'].includes(document.mimeType)) {
      return fail(
        res,
        415,
        'Face comparison requires a JPEG or PNG identity document image',
        'UNSUPPORTED_IDENTITY_IMAGE'
      );
    }

    const pending = db.identityChecks.find(
      (item) =>
        item.driverId === driver.id &&
        item.type === 'aws_face_liveness' &&
        item.status === 'provider_pending'
    );
    const pendingAgeMs = pending ? Date.now() - new Date(pending.createdAt).getTime() : 0;

    if (pending && pending.metadata?.documentId === document.id && pendingAgeMs < 120 * 1000) {
      return ok(res, 'Resuming the pending face-liveness session', {
        sessionId: pending.providerReference,
        provider: 'aws-rekognition',
        region: env.awsRegion,
        expiresInSeconds: Math.max(0, 180 - Math.floor(pendingAgeMs / 1000)),
        resumed: true,
      });
    }

    if (pending) {
      Object.assign(pending, {
        status: 'failed',
        resultCode:
          pending.metadata?.documentId !== document.id
            ? 'SESSION_REPLACED'
            : pendingAgeMs >= 180 * 1000
            ? 'SESSION_EXPIRED'
            : 'SESSION_NEAR_EXPIRY',
        updatedAt: timestamp(),
      });
    }

    const requestToken = id();
    let sessionId;

    try {
      sessionId = await createLivenessSession(requestToken);
    } catch (error) {
      console.error('AWS Rekognition session creation failed:', error.name || 'ProviderError');
      return fail(res, 502, 'Could not start face verification. Please try again later.', 'FACE_PROVIDER_ERROR');
    }

    const check = {
      id: id(),
      driverId: driver.id,
      type: 'aws_face_liveness',
      provider: 'aws-rekognition',
      providerReference: sessionId,
      status: 'provider_pending',
      metadata: {
        documentId: document.id,
        consentVersion: req.body.consentVersion,
        consentedAt: timestamp(),
      },
      attempts: 1,
      createdAt: timestamp(),
      updatedAt: timestamp(),
    };

    db.identityChecks.push(check);

    return ok(
      res,
      'Face-liveness session created',
      {
        sessionId,
        provider: 'aws-rekognition',
        region: env.awsRegion,
        expiresInSeconds: 180,
        nextStep:
          'Complete the video-selfie capture using the AWS Amplify FaceLivenessDetector client, then call this endpoint to retrieve results.',
      },
      201
    );
  })
);

router.post('/verification/face/cancel', validate(sessionOnlySchema), (req, res) => {
  const driver = requireDriver(req, res);
  if (!driver) return;

  const check = db.identityChecks.find(
    (item) =>
      item.driverId === driver.id &&
      item.type === 'aws_face_liveness' &&
      item.providerReference === req.body.sessionId
  );

  if (!check) return fail(res, 404, 'Face-verification session not found', 'FACE_SESSION_NOT_FOUND');

  if (check.status === 'provider_pending') {
    Object.assign(check, { status: 'failed', resultCode: 'CLIENT_CANCELLED', updatedAt: timestamp() });
  }

  return ok(res, 'Face-verification session closed', { status: check.status });
});

router.post(
  '/verification/face/complete',
  validate(sessionOnlySchema),
  asyncHandler(async (req, res) => {
    const driver = requireDriver(req, res);
    if (!driver) return;

    const check = db.identityChecks.find(
      (item) =>
        item.driverId === driver.id &&
        item.type === 'aws_face_liveness' &&
        item.providerReference === req.body.sessionId
    );

    if (!check) return fail(res, 404, 'Face-verification session not found', 'FACE_SESSION_NOT_FOUND');

    if (check.status !== 'provider_pending') {
      return ok(res, 'Face verification already processed', {
        status: check.status,
        reviewRequired: check.status !== 'approved',
      });
    }

    let result;
    try {
      result = await getLivenessResults(check.providerReference);
    } catch (error) {
      console.error('AWS Rekognition result retrieval failed:', error.name || 'ProviderError');
      return fail(res, 502, 'Could not retrieve face-verification results. Please retry.', 'FACE_PROVIDER_ERROR');
    }

    if (result.Status === 'IN_PROGRESS' || result.Status === 'CREATED') {
      return ok(res, 'Face-liveness capture is still processing', { status: result.Status }, 202);
    }

    if (result.Status !== 'SUCCEEDED') {
      Object.assign(check, {
        status: 'failed',
        resultCode: result.Status || 'UNKNOWN',
        updatedAt: timestamp(),
      });
      return fail(
        res,
        422,
        'Face-liveness capture did not complete. Start a new verification attempt.',
        'FACE_LIVENESS_INCOMPLETE',
        { status: result.Status || 'UNKNOWN' }
      );
    }

    const referenceBytes = result.ReferenceImage?.Bytes;
    const document = db.documents.find(
      (item) => item.id === check.metadata.documentId && item.driverId === driver.id
    );

    if (!referenceBytes || !document?.storage?.path) {
      Object.assign(check, {
        status: 'manual_review',
        livenessConfidence: Number(result.Confidence || 0),
        resultCode: 'IMAGE_OR_DOCUMENT_UNAVAILABLE',
        updatedAt: timestamp(),
      });
      return ok(res, 'Face verification requires manual review', { status: check.status, reviewRequired: true });
    }

    let comparison;
    try {
      const documentBytes = await downloadPrivateFile(document.storage.path);
      comparison = await compareLivenessFaceToDocument({ livenessReferenceBytes: referenceBytes, documentBytes });
    } catch (error) {
      console.error('AWS Rekognition face comparison failed:', error.name || 'ProviderError');
      Object.assign(check, {
        status: 'manual_review',
        livenessConfidence: Number(result.Confidence || 0),
        resultCode: 'FACE_COMPARISON_UNAVAILABLE',
        updatedAt: timestamp(),
      });
      return ok(
        res,
        'Face comparison could not be completed automatically and requires manual review',
        { status: check.status, reviewRequired: true }
      );
    }

    const livenessConfidence = Number(result.Confidence || 0);
    const passed = livenessConfidence >= env.faceLivenessThreshold && comparison.matched;

    Object.assign(check, {
      status: passed ? 'approved' : 'manual_review',
      livenessConfidence,
      faceSimilarity: comparison.similarity,
      livenessThreshold: env.faceLivenessThreshold,
      faceMatchThreshold: env.faceMatchSimilarityThreshold,
      reviewRequired: !passed,
      completedAt: timestamp(),
      updatedAt: timestamp(),
    });

    return ok(
      res,
      passed
        ? 'Automated face checks passed; driver documents still require their normal review'
        : 'Face verification requires manual review',
      { status: check.status, reviewRequired: !passed, driverApprovalChanged: false }
    );
  })
);

router.get('/verification/daily-status', (req, res) => {
  const driver = requireDriver(req, res);
  if (!driver) return;

  const check = driver.dailyVerification || null;
  const today = new Date().toISOString().slice(0, 10);

  return ok(res, 'Daily verification status', { required: !check || check.date !== today, check });
});

router.post(
  '/verification/daily-check',
  upload.single('selfie'),
  asyncHandler(async (req, res) => {
    const driver = requireDriver(req, res);
    if (!driver) return;

    if (!req.file) return fail(res, 400, 'Selfie file is required', 'FILE_REQUIRED');

    validateUpload(req.file, ['image/jpeg', 'image/png']);

    const checkId = id();
    const stored = await storePrivateFile({
      path: `drivers/${driver.id}/daily/${checkId}`,
      file: req.file,
    });

    const check = {
      id: checkId,
      date: new Date().toISOString().slice(0, 10),
      status: 'pending_manual_review',
      submittedAt: timestamp(),
      storage: stored,
    };

    driver.dailyVerification = check;
    return ok(res, 'Daily verification submitted for review', { check }, 202);
  })
);

router.get(
  '/verification/file/:documentId',
  asyncHandler(async (req, res) => {
    const driver = requireDriver(req, res);
    if (!driver) return;

    const document = db.documents.find(
      (item) => item.id === req.params.documentId && item.driverId === driver.id
    );

    if (!document?.storage?.path) return fail(res, 404, 'File not found', 'FILE_NOT_FOUND');

    const url = await signedPrivateUrl(document.storage.path);
    if (!url) return fail(res, 503, 'Private storage is not configured', 'STORAGE_NOT_CONFIGURED');

    return ok(res, 'Signed file URL', { url, expiresIn: env.signedUrlTtlSeconds });
  })
);

router.get('/subscription/status', (req, res) => {
  const driver = requireDriver(req, res);
  if (!driver) return;

  const subscription = activeSubscription(driver);
  return ok(res, 'Subscription status', {
    active: Boolean(subscription),
    subscription: subscription || null,
    fee: env.dailyFee,
    currency: 'NGN',
  });
});

router.get('/subscription/history', (req, res) => {
  const driver = requireDriver(req, res);
  if (!driver) return;

  const subscriptions = db.subscriptions
    .filter((s) => s.driverId === driver.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return ok(res, 'Subscription history', {
    subscriptions: paginate(subscriptions, req.query.page, req.query.limit),
  });
});

router.post('/subscription/pay', validate(subscriptionPaySchema), (req, res) => {
  const driver = requireDriver(req, res);
  if (!driver) return;

  if (env.isProduction) {
    return fail(
      res,
      503,
      'Driver subscription settlement is not integrated with a verified payment provider yet.',
      'SUBSCRIPTION_PAYMENT_NOT_CONFIGURED'
    );
  }

  const days = req.body.days || 1;
  const now = new Date();
  const current = activeSubscription(driver);
  const startsAt = current ? new Date(current.expiresAt) : now;
  const expiresAt = new Date(startsAt.getTime() + days * 86400000);
  const reference = req.body.paymentReference || `manual-${id()}`;

  if (db.payments.some((p) => p.reference === reference && p.status === 'successful')) {
    return fail(res, 409, 'Payment reference already processed', 'DUPLICATE_PAYMENT');
  }

  const subscription = {
    id: id(),
    driverId: driver.id,
    status: 'active',
    days,
    amount: env.dailyFee * days,
    currency: 'NGN',
    paymentReference: reference,
    startsAt: startsAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    createdAt: timestamp(),
  };

  db.subscriptions.push(subscription);
  db.payments.push({
    id: id(),
    driverId: driver.id,
    type: 'subscription',
    amount: subscription.amount,
    currency: 'NGN',
    status: 'successful',
    reference,
    createdAt: timestamp(),
  });

  return ok(res, 'Subscription activated', { subscription }, 201);
});

router.get('/wallet/transactions', (req, res) => {
  const driver = requireDriver(req, res);
  if (!driver) return;

  const wallet = walletFor(driver);
  const transactions = db.walletTransactions
    .filter((t) => t.driverId === driver.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return ok(res, 'Wallet transactions', {
    balance: wallet.balance,
    currency: 'NGN',
    transactions: paginate(transactions, req.query.page, req.query.limit),
  });
});

router.post('/wallet/bank-account', validate(bankAccountSchema), (req, res) => {
  const driver = requireDriver(req, res);
  if (!driver) return;

  const wallet = walletFor(driver);
  wallet.bankAccount = { ...req.body, updatedAt: timestamp() };
  wallet.updatedAt = timestamp();

  return ok(res, 'Bank account saved', { bankAccount: safeBank(wallet.bankAccount) });
});

router.post('/wallet/withdraw', validate(withdrawSchema), (req, res) => {
  const driver = requireDriver(req, res);
  if (!driver) return;

  const wallet = walletFor(driver);
  if (req.body.bankAccount) {
    wallet.bankAccount = { ...req.body.bankAccount, updatedAt: timestamp() };
  }

  if (!wallet.bankAccount) {
    return fail(res, 400, 'Bank account is required before withdrawal', 'BANK_ACCOUNT_REQUIRED');
  }

  if (wallet.balance < req.body.amount) {
    return fail(res, 400, 'Insufficient wallet balance', 'INSUFFICIENT_BALANCE');
  }

  wallet.balance -= req.body.amount;
  wallet.updatedAt = timestamp();

  const withdrawal = {
    id: id(),
    driverId: driver.id,
    amount: req.body.amount,
    currency: 'NGN',
    status: 'pending',
    bankAccount: wallet.bankAccount,
    createdAt: timestamp(),
  };

  db.withdrawals.push(withdrawal);
  db.walletTransactions.push({
    id: id(),
    driverId: driver.id,
    type: 'withdrawal',
    amount: -req.body.amount,
    balanceAfter: wallet.balance,
    reference: withdrawal.id,
    createdAt: withdrawal.createdAt,
  });

  return ok(
    res,
    'Withdrawal requested',
    { withdrawal: { ...withdrawal, bankAccount: safeBank(withdrawal.bankAccount) }, balance: wallet.balance },
    201
  );
});

router.get('/wallet/withdrawals', (req, res) => {
  const driver = requireDriver(req, res);
  if (!driver) return;

  const withdrawals = db.withdrawals
    .filter((w) => w.driverId === driver.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((w) => ({ ...w, bankAccount: safeBank(w.bankAccount) }));

  return ok(res, 'Wallet withdrawals', {
    withdrawals: paginate(withdrawals, req.query.page, req.query.limit),
  });
});


router.get('/cng/unit-config', (_req, res) => {
  return ok(res, 'CNG unit configuration', { unit: env.cngUnit });
});

router.post('/cng/log', validate(cngLogSchema), (req, res) => {
  const driver = requireDriver(req, res);
  if (!driver) return;

  const transaction = {
    id: id(),
    driverId: driver.id,
    quantity: req.body.quantity,
    amount: req.body.amount,
    unit: req.body.unit || env.cngUnit,
    station: req.body.station || null,
    odometer: req.body.odometer ?? null,
    filledAt: req.body.filledAt || timestamp(),
    createdAt: timestamp(),
  };

  db.cngTransactions.push(transaction);
  return ok(res, 'CNG refueling logged', { transaction }, 201);
});

router.get('/cng/history', (req, res) => {
  const driver = requireDriver(req, res);
  if (!driver) return;

  const transactions = db.cngTransactions
    .filter((t) => t.driverId === driver.id)
    .sort((a, b) => b.filledAt.localeCompare(a.filledAt));

  return ok(res, 'CNG refueling history', {
    transactions: paginate(transactions, req.query.page, req.query.limit),
  });
});

router.get('/cng/summary', (req, res) => {
  const driver = requireDriver(req, res);
  if (!driver) return;

  const transactions = db.cngTransactions.filter((t) => t.driverId === driver.id);
  return ok(res, 'CNG refueling summary', {
    totalRefuels: transactions.length,
    totalQuantity: transactions.reduce((sum, t) => sum + Number(t.quantity), 0),
    totalAmount: transactions.reduce((sum, t) => sum + Number(t.amount), 0),
    unit: transactions[0]?.unit || env.cngUnit,
  });
});

router.post('/sos/trigger', validate(sosTriggerSchema), (req, res) => {
  const driver = requireDriver(req, res);
  if (!driver) return;

  const ride = findRide(req.body.tripId);
  if (!ride || ride.driverId !== driver.id) {
    return fail(res, 404, 'Trip not found for this driver', 'TRIP_NOT_FOUND');
  }

  const event = {
    id: id(),
    driverId: driver.id,
    tripId: req.body.tripId,
    latitude: req.body.latitude,
    longitude: req.body.longitude,
    note: req.body.note || null,
    status: 'open',
    createdAt: timestamp(),
  };

  db.sosEvents.push(event);
  driver.lastSosAt = event.createdAt;

  return ok(res, 'SOS alert triggered', { sos: event }, 201);
});

export default router;