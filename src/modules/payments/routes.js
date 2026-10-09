import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { 
  db, 
  findRide, 
  findUser, 
  id, 
  timestamp, 
  creditWallet, 
  creditRiderWallet 
} from '../../database/store.js';
import { asyncHandler, fail, ok } from '../../shared/core.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/errors.js';
import { paymentReceiptEmail, sendEmail } from '../../services/email.js';

const router = Router();

// Helper: Paystack API Request Wrapper
const paystackRequest = async (path, body, method = 'POST') => {
  if (!env.paystackSecretKey) return { configured: false };

  const response = await fetch(`https://api.paystack.co/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.paystackSecretKey}`,
      'Content-Type': 'application/json',
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });

  const payload = await response.json();

  if (!response.ok || !payload.status) {
    const error = new Error(payload.message || 'Paystack request failed');
    error.status = response.status || 502;
    throw error;
  }

  return { configured: true, payload };
};

// Helper: Process and reconcile successful payments
const applySuccessfulPayment = async (payment, providerData) => {
  if (payment.status === 'successful') return false;

  const expectedKobo = Math.round(Number(payment.amount) * 100);

  if (Number(providerData.amount) !== expectedKobo) {
    payment.status = 'amount_mismatch';
    payment.providerResponse = providerData;
    payment.updatedAt = timestamp();
    return false;
  }

  payment.status = 'successful';
  payment.providerResponse = providerData;
  payment.verifiedAt = timestamp();

  if (payment.type === 'ride') {
    const ride = findRide(payment.rideId);
    const driver = ride?.driverId 
      ? db.drivers.find((item) => item.id === ride.driverId) 
      : null;

    if (ride && driver && !ride.driverPaidAt) {
      creditWallet(driver.id, ride.fare, ride.id);
      ride.driverPaidAt = timestamp();
    }
  } else if (payment.type === 'wallet_topup' && !payment.walletCreditedAt) {
    creditRiderWallet(payment.userId, payment.amount, payment.id, 'wallet_topup');
    payment.walletCreditedAt = timestamp();
  }

  const user = findUser({ id: payment.userId });

  if (user?.email) {
    sendEmail({
      to: user.email,
      ...paymentReceiptEmail({
        name: user.name,
        amount: payment.amount,
        reference: payment.reference,
      }),
    }).catch((error) => console.error('Payment receipt email failed:', error.message));
  }

  return true;
};

// Validation Schemas
const initializePaymentSchema = z.object({
  rideId: z.string(),
  provider: z.enum(['paystack', 'flutterwave']).default('paystack'),
});

const saveCardSchema = z.object({
  reference: z.string().min(3)
});

// POST /api/v1/payments/webhooks/paystack - Handle Paystack Webhook events
router.post('/webhooks/paystack', (req, res) => {
  if (!env.paystackSecretKey) {
    return fail(res, 503, 'Paystack is not configured', 'PAYSTACK_NOT_CONFIGURED');
  }

  const signature = req.headers['x-paystack-signature'];
  const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const expected = createHmac('sha512', env.paystackSecretKey).update(raw).digest('hex');

  const signatureBuffer = typeof signature === 'string' ? Buffer.from(signature) : null;
  const expectedBuffer = Buffer.from(expected);

  if (
    !signatureBuffer ||
    signatureBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return fail(res, 401, 'Invalid webhook signature', 'INVALID_WEBHOOK_SIGNATURE');
  }

  const event = req.body;

  if (event.event === 'charge.success' && event.data?.reference) {
    const payment = db.payments.find((item) => item.reference === event.data.reference);
    if (payment) {
      applySuccessfulPayment(payment, event.data).catch((error) =>
        console.error('Webhook reconciliation failed:', error.message)
      );
    }
  }

  return ok(res, 'Webhook accepted', { received: true });
});

// Require authentication for all subsequent endpoints
router.use(requireAuth);

// POST /api/v1/payments/initialize - Initialize a payment for a completed ride
router.post(
  '/initialize',
  requireRole('rider'),
  validate(initializePaymentSchema),
  asyncHandler(async (req, res) => {
    const ride = findRide(req.body.rideId);

    if (!ride || ride.riderId !== req.user.id || ride.status !== 'completed') {
      return fail(res, 400, 'Only your completed ride can be paid', 'PAYMENT_NOT_ALLOWED');
    }

    let payment = db.payments.find(
      (p) => p.rideId === ride.id && p.userId === req.user.id && p.type !== 'cancellation_fee'
    );

    if (!payment) {
      payment = {
        id: id(),
        rideId: ride.id,
        userId: req.user.id,
        type: 'ride',
        amount: ride.fare,
        provider: req.body.provider,
        status: 'pending',
        currency: 'NGN',
        createdAt: timestamp(),
      };
      db.payments.push(payment);
    }

    if (payment.status === 'successful') {
      return ok(res, 'Payment already settled', { payment });
    }

    if (req.body.provider !== 'paystack') {
      return ok(
        res,
        'Payment initialized; verify with the provider server-side',
        { payment, checkoutRequired: true, providerConfigured: false },
        201
      );
    }

    const user = findUser({ id: req.user.id });
    const reference = payment.reference || `ride_${payment.id}`;

    const result = await paystackRequest('transaction/initialize', {
      email: user?.email || `${user?.phone || payment.userId}@switchride.local`,
      amount: Math.round(Number(payment.amount) * 100),
      reference,
      ...(env.paystackCallbackUrl ? { callback_url: env.paystackCallbackUrl } : {}),
    });

    if (!result.configured) {
      return fail(
        res,
        503,
        'Paystack is not configured. Add PAYSTACK_SECRET_KEY to the server environment.',
        'PAYSTACK_NOT_CONFIGURED'
      );
    }

    Object.assign(payment, {
      provider: 'paystack',
      reference,
      accessCode: result.payload.data.access_code,
      authorizationUrl: result.payload.data.authorization_url,
      providerResponse: result.payload.data,
    });

    return ok(
      res,
      'Paystack checkout initialized',
      {
        payment,
        checkoutRequired: true,
        authorizationUrl: payment.authorizationUrl,
        accessCode: payment.accessCode,
      },
      201
    );
  })
);

// POST /api/v1/payments/verify/:id - Verify a payment by ID
router.post(
  '/verify/:id',
  requireRole('rider'),
  asyncHandler(async (req, res) => {
    const payment = db.payments.find(
      (p) => p.id === req.params.id && p.userId === req.user.id
    );

    if (!payment) {
      return fail(res, 404, 'Payment not found', 'PAYMENT_NOT_FOUND');
    }

    if (payment.status === 'successful') {
      return ok(res, 'Payment already verified', { payment });
    }

    if (payment.provider !== 'paystack') {
      return ok(res, 'Payment verification endpoint ready for provider integration', {
        payment,
        providerVerificationRequired: true,
      });
    }

    if (!payment.reference) {
      return fail(res, 400, 'Payment reference is missing', 'PAYMENT_REFERENCE_MISSING');
    }

    const result = await paystackRequest(
      `transaction/verify/${encodeURIComponent(payment.reference)}`,
      undefined,
      'GET'
    );

    if (!result.configured) {
      return fail(res, 503, 'Paystack is not configured', 'PAYSTACK_NOT_CONFIGURED');
    }

    const successful = result.payload.data?.status === 'success';

    if (successful) {
      await applySuccessfulPayment(payment, result.payload.data);
    } else {
      Object.assign(payment, {
        status: 'failed',
        providerResponse: result.payload.data,
        verifiedAt: timestamp(),
      });
    }

    return successful
      ? ok(res, 'Payment verified successfully', { payment })
      : fail(res, 400, 'Paystack payment was not successful', 'PAYMENT_NOT_SUCCESSFUL', {
          payment,
        });
  })
);

// GET /api/v1/payments/cards - List rider's saved payment cards
router.get('/cards', requireRole('rider'), (req, res) =>
  ok(res, 'Saved cards', {
    cards: db.savedCards
      .filter((c) => c.userId === req.user.id)
      .map(({ authorizationCode, ...card }) => card),
  })
);

// POST /api/v1/payments/cards - Save a reusable payment card authorization
router.post(
  '/cards',
  requireRole('rider'),
  validate(saveCardSchema),
  asyncHandler(async (req, res) => {
    const verified = await paystackRequest(
      `transaction/verify/${encodeURIComponent(req.body.reference)}`,
      undefined,
      'GET'
    );

    if (!verified.configured) {
      return fail(res, 503, 'Paystack is not configured', 'PAYSTACK_NOT_CONFIGURED');
    }

    const data = verified.payload.data;
    const authorization = data?.authorization;

    if (
      data?.status !== 'success' ||
      !authorization?.reusable ||
      !authorization?.authorization_code
    ) {
      return fail(
        res,
        400,
        'This transaction did not provide a reusable card authorization',
        'CARD_NOT_REUSABLE'
      );
    }

    const card = {
      id: id(),
      userId: req.user.id,
      provider: 'paystack',
      authorizationCode: authorization.authorization_code,
      last4: authorization.last4 || null,
      brand: authorization.brand || null,
      signature: authorization.signature || null,
      createdAt: timestamp(),
    };
    db.savedCards.push(card);

    return ok(
      res,
      'Card saved',
      {
        card: {
          id: card.id,
          last4: card.last4,
          brand: card.brand,
          createdAt: card.createdAt,
        },
      },
      201
    );
  })
);

// DELETE /api/v1/payments/cards/:id - Remove a saved payment card
router.delete('/cards/:id', requireRole('rider'), (req, res) => {
  const i = db.savedCards.findIndex(
    (c) => c.id === req.params.id && c.userId === req.user.id
  );

  if (i < 0) {
    return fail(res, 404, 'Saved card not found', 'CARD_NOT_FOUND');
  }

  db.savedCards.splice(i, 1);
  return ok(res, 'Saved card removed', { id: req.params.id });
});

// GET /api/v1/payments/ride/:rideId - Get payment details for a specific ride
router.get('/ride/:rideId', requireRole('rider', 'driver', 'admin'), (req, res) => {
  const ride = findRide(req.params.rideId);

  if (!ride) {
    return fail(res, 404, 'Ride not found', 'RIDE_NOT_FOUND');
  }

  const driver =
    req.user.role === 'driver'
      ? db.drivers.find((d) => d.userId === req.user.id)
      : null;

  if (req.user.role === 'rider' && ride.riderId !== req.user.id) {
    return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  }

  if (req.user.role === 'driver' && ride.driverId !== driver?.id) {
    return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  }

  const payment = db.payments.find((p) => p.rideId === ride.id && p.type === 'ride') || null;

  return ok(res, 'Ride payment', { payment });
});

// GET /api/v1/payments - Admin view all payments
router.get('/', requireRole('admin'), (_req, res) => {
  return ok(res, 'Payments', { payments: db.payments });
});

export default router;

