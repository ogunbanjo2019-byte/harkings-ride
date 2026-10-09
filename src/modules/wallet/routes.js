import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { 
  db, 
  findRide, 
  id, 
  timestamp, 
  creditWallet, 
  creditRiderWallet 
} from '../../database/store.js';
import { fail, ok } from '../../shared/core.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/errors.js';

const router = Router();

// Middleware: Restrict access to authenticated riders only
router.use(requireAuth, requireRole('rider'));

// Validation Schemas
const topupSchema = z.object({
  amount: z.number().int().min(100).max(1000000)
});

const transferSchema = z.object({
  rideId: z.string().min(1)
});

// Helper: Calculate total wallet balance for a given rider
const balanceFor = (userId) =>
  db.walletTransactions
    .filter((t) => t.riderId === userId)
    .reduce((sum, t) => sum + Number(t.amount || 0), 0);

// GET /api/v1/wallet - Fetch rider wallet balance & transaction history
router.get('/', (req, res) =>
  ok(res, 'Rider wallet', {
    balance: balanceFor(req.user.id),
    transactions: db.walletTransactions
      .filter((t) => t.riderId === req.user.id)
      .map((t) => ({
        label: t.type,
        amount: Math.abs(t.amount),
        isCredit: t.amount > 0,
        date: t.createdAt
      }))
  })
);

// POST /api/v1/wallet/topup - Initialize Paystack wallet top-up transaction
router.post('/topup', validate(topupSchema), async (req, res) => {
  if (!env.paystackSecretKey) {
    return fail(res, 503, 'Paystack is not configured', 'PAYSTACK_NOT_CONFIGURED');
  }

  const payment = {
    id: id(),
    userId: req.user.id,
    type: 'wallet_topup',
    amount: req.body.amount,
    provider: 'paystack',
    status: 'pending',
    currency: 'NGN',
    reference: `wallet_${id()}`,
    createdAt: timestamp()
  };
  db.payments.push(payment);

  const user = db.users.find((u) => u.id === req.user.id);

  const response = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.paystackSecretKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      email: user?.email || `${user?.phone}@switchride.local`,
      amount: payment.amount * 100,
      reference: payment.reference,
      ...(env.paystackCallbackUrl ? { callback_url: env.paystackCallbackUrl } : {})
    })
  });

  const payload = await response.json();

  if (!response.ok || !payload.status) {
    payment.status = 'failed';
    return fail(
      res,
      502,
      payload.message || 'Wallet top-up initialization failed',
      'PAYMENT_INITIALIZATION_FAILED'
    );
  }

  payment.authorizationUrl = payload.data.authorization_url;
  payment.accessCode = payload.data.access_code;

  return ok(
    res,
    'Wallet top-up initialized',
    {
      paymentId: payment.id,
      authorizationUrl: payment.authorizationUrl,
      accessCode: payment.accessCode
    },
    201
  );
});

// POST /api/v1/wallet/transfer - Pay for a completed trip using wallet balance
router.post('/transfer', validate(transferSchema), (req, res) => {
  const ride = findRide(req.body.rideId);

  if (!ride || ride.riderId !== req.user.id || ride.status !== 'completed') {
    return fail(res, 400, 'Only your completed ride can be paid', 'PAYMENT_NOT_ALLOWED');
  }

  if (
    db.payments.some(
      (p) => p.rideId === ride.id && p.type === 'ride' && p.status === 'successful'
    )
  ) {
    return fail(res, 409, 'Ride is already paid', 'PAYMENT_ALREADY_SETTLED');
  }

  const balance = balanceFor(req.user.id);

  if (balance < ride.fare) {
    return fail(res, 409, 'Insufficient wallet balance', 'INSUFFICIENT_WALLET_BALANCE', {
      balance,
      required: ride.fare
    });
  }

  // Deduct fare from rider's wallet
  creditRiderWallet(req.user.id, -Number(ride.fare), ride.id, 'ride_payment');

  const payment = {
    id: id(),
    rideId: ride.id,
    userId: req.user.id,
    type: 'ride',
    amount: ride.fare,
    provider: 'wallet',
    status: 'successful',
    currency: 'NGN',
    verifiedAt: timestamp(),
    createdAt: timestamp()
  };
  db.payments.push(payment);

  // Credit driver's wallet if not already paid
  const driver = db.drivers.find((d) => d.id === ride.driverId);
  if (driver && !ride.driverPaidAt) {
    creditWallet(driver.id, ride.fare, ride.id);
    ride.driverPaidAt = timestamp();
  }

  return ok(res, 'Ride paid from wallet', {
    payment,
    balance: balanceFor(req.user.id)
  });
});

export default router;
