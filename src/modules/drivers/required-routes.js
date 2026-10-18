import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { db, findDriverByUser, findUser, id, timestamp, creditWallet } from '../../database/store.js';
import { asyncHandler, fail, ok } from '../../shared/core.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/errors.js';

const router = Router();
router.use(requireAuth, requireRole('driver'));
const walletFundingInitiateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  keyGenerator: (req) => req.user.id,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many wallet funding attempts. Try again later.',
    data: null,
    error: { code: 'WALLET_FUNDING_RATE_LIMITED', details: null },
  },
});
const walletFundingVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  keyGenerator: (req) => req.user.id,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many wallet funding verification attempts. Try again later.',
    data: null,
    error: { code: 'WALLET_VERIFY_RATE_LIMITED', details: null },
  },
});
const driverFor = (req) => findDriverByUser(req.user.id);

const fundSchema = z.object({
  amount: z.number().int().min(500).max(500000),
  method: z.enum(['card', 'bank_transfer']),
  client_reference: z.string().min(8).max(100),
});

const verifySchema = z.object({
  reference: z.string().min(4).max(150),
});

const closeSchema = z.object({
  password: z.string().min(1).max(128),
  reason: z.string().trim().max(500).optional(),
});

async function paystack(path, body, method = 'POST') {
  if (!env.paystackSecretKey) return null;

  const response = await fetch(`https://api.paystack.co/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.paystackSecretKey}`,
      'Content-Type': 'application/json',
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ) }),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok || !payload.status) {
    const error = new Error(payload.message || 'Payment provider request failed');
    error.status = 502;
    throw error;
  }

  return payload.data;
}

const getWallet = (driver) => {
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

router.post(
  '/wallet/fund/initiate',
  walletFundingInitiateLimiter,
  validate(fundSchema),
  asyncHandler(async (req, res) => {
    const driver = driverFor(req);
    if (!driver) {
      return fail(res, 404, 'Driver profile not found', 'DRIVER_NOT_FOUND');
    }

    const user = findUser({ id: req.user.id });

    let payment = db.payments.find(
      (item) =>
        item.type === 'driver_wallet_funding' &&
        item.driverId === driver.id &&
        item.clientReference === req.body.client_reference
    );

    if (payment) {
      if (
        payment.amount !== req.body.amount ||
        payment.method !== req.body.method
      ) {
        return fail(
          res,
          409,
          'This client reference was already used for a different top-up.',
          'CLIENT_REFERENCE_REUSED'
        );
      }

      return ok(res, 'Wallet top-up already initialized', {
        reference: payment.reference,
        ...(payment.checkoutUrl
          ? { checkout_url: payment.checkoutUrl }
          : {}),
        ...(payment.bank ? { bank: payment.bank } : {}),
      });
    }

    if (!env.paystackSecretKey) {
      return fail(
        res,
        503,
        'Wallet top-up is not configured. Contact support.',
        'PAYMENT_PROVIDER_NOT_CONFIGURED'
      );
    }

    payment = {
      id: id(),
      driverId: driver.id,
      userId: req.user.id,
      type: 'driver_wallet_funding',
      amount: req.body.amount,
      method: req.body.method,
      provider: 'paystack',
      status: 'pending',
      currency: 'NGN',
      reference: `FUND_${id().replaceAll('-', '')}`,
      clientReference: req.body.client_reference,
      createdAt: timestamp(),
    };

    db.payments.push(payment);

    const email =
      user?.email || `${req.user.id}@driver.harkeyzride.invalid`;

    if (req.body.method === 'bank_transfer') {
      // One pending transfer per driver prevents an incoming deposit
      // from being matched ambiguously.
      const otherPending = db.payments.find(
        (item) =>
          item.type === 'driver_wallet_funding' &&
          item.driverId === driver.id &&
          item.method === 'bank_transfer' &&
          item.status === 'pending' &&
          item.clientReference !== payment.clientReference
      );

      if (otherPending) {
        db.payments.splice(db.payments.indexOf(payment), 1);
        return fail(
          res,
          409,
          'Finish or cancel your pending bank-transfer top-up first.',
          'TOPUP_PENDING'
        );
      }

      let customerCode = user?.paystackCustomerCode;

      if (!customerCode) {
        const customer = await paystack('customer', {
          email,
          first_name: user?.name || 'Driver',
          phone: user?.phone || undefined,
        });

        customerCode = customer?.customer_code;

        if (!customerCode) {
          throw new Error('Payment provider did not create a customer');
        }

        user.paystackCustomerCode = customerCode;
      }

      let bank = user.fundingBank;

      if (!bank?.account_number) {
        const account = await paystack('dedicated_account', {
          customer: customerCode,
          preferred_bank: 'wema-bank',
        });

        if (!account?.account_number || !account?.bank?.name) {
          throw new Error('Payment provider did not issue a bank account');
        }

        bank = {
          bank_name: account.bank.name,
          account_number: account.account_number,
          account_name: account.account_name || user?.name || 'Driver',
          customer_code: customerCode,
        };

        user.fundingBank = bank;
      }

      payment.bank = {
        bank_name: bank.bank_name,
        account_number: bank.account_number,
        account_name: `HarkeyzDrive / ${bank.account_name}`,
      };

      return ok(
        res,
        'Bank-transfer details ready',
        { reference: payment.reference, bank: payment.bank },
        201
      );
    }

    const data = await paystack('transaction/initialize', {
      email,
      amount: payment.amount * 100,
      reference: payment.reference,
      channels: ['card'],
      ...(env.paystackCallbackUrl
        ? { callback_url: env.paystackCallbackUrl }
        : {}),
      metadata: {
        driver_id: driver.id,
        purpose: 'driver_wallet_funding',
        client_reference: payment.clientReference,
      },
    });

    if (!data) {
      payment.status = 'failed';
      return fail(
        res,
        503,
        'Wallet top-up is not configured. Contact support.',
        'PAYMENT_PROVIDER_NOT_CONFIGURED'
      );
    }

    payment.checkoutUrl = data.authorization_url;
    payment.accessCode = data.access_code;

    return ok(
      res,
      'Wallet top-up initialized',
      {
        reference: payment.reference,
        checkout_url: payment.checkoutUrl,
      },
      201
    );
  })
);

router.post(
  '/wallet/fund/verify',
  walletFundingVerifyLimiter,
  validate(verifySchema),
  asyncHandler(async (req, res) => {
    const driver = driverFor(req);
    if (!driver) {
      return fail(res, 404, 'Driver profile not found', 'DRIVER_NOT_FOUND');
    }

    const payment = db.payments.find(
      (item) =>
        item.type === 'driver_wallet_funding' &&
        item.reference === req.body.reference
    );

    if (!payment) {
      return fail(res, 404, 'Top-up not found', 'TOPUP_NOT_FOUND');
    }

    if (payment.driverId !== driver.id) {
      return fail(
        res,
        403,
        'You cannot check another driver’s top-up.',
        'FORBIDDEN'
      );
    }

    if (payment.status === 'successful') {
      return ok(res, 'Top-up received', {
        status: 'success',
        amount: payment.amount,
      });
    }

    if (!env.paystackSecretKey) {
      return fail(
        res,
        503,
        'Wallet top-up is not configured. Contact support.',
        'PAYMENT_PROVIDER_NOT_CONFIGURED'
      );
    }

    if (payment.method === 'bank_transfer') {
      return ok(res, 'Bank transfer has not been received yet', {
        status: 'pending',
        amount: payment.amount,
      });
    }

    const providerData = await paystack(
      `transaction/verify/${encodeURIComponent(payment.reference)}`,
      undefined,
      'GET'
    );

    if (
      providerData?.status === 'success' &&
      Number(providerData.amount) === payment.amount * 100 &&
      providerData.reference === payment.reference &&
      providerData.currency === 'NGN'
    ) {
      payment.status = 'successful';
      payment.verifiedAt = timestamp();
      payment.providerResponse = providerData;

      if (!payment.walletCreditedAt) {
        creditWallet(driver.id, payment.amount, payment.reference, 'funding');
        payment.walletCreditedAt = timestamp();
      }

      return ok(res, 'Top-up received', {
        status: 'success',
        amount: payment.amount,
      });
    }

    if (providerData?.status === 'success') {
      payment.status = 'verification_mismatch';
      payment.providerResponse = providerData;
      payment.updatedAt = timestamp();
      return fail(res, 409, 'Provider payment details do not match this top-up.', 'PAYMENT_DETAILS_MISMATCH');
    }

    if (
      providerData?.status &&
      providerData.status !== 'success' &&
      ['failed', 'abandoned', 'reversed'].includes(providerData.status)
    ) {
      payment.status = 'failed';
      payment.providerResponse = providerData;

      return ok(res, 'Top-up was not completed', {
        status: 'failed',
        amount: payment.amount,
        message: 'The payment provider did not confirm this payment.',
      });
    }

    return ok(res, 'Top-up is still being processed', {
      status: 'pending',
      amount: payment.amount,
    });
  })
);

router.post(
  '/account/close',
  validate(closeSchema),
  asyncHandler(async (req, res) => {
    const user = findUser({ id: req.user.id });
    const driver = driverFor(req);

    if (!user || !driver) {
      return fail(res, 404, 'Driver profile not found', 'DRIVER_NOT_FOUND');
    }

    if (!(await bcrypt.compare(req.body.password, user.passwordHash || ''))) {
      return fail(res, 401, 'That password is not correct.', 'INVALID_PASSWORD');
    }

    const driverRides = db.rides.filter(
      (ride) => ride.driverId === driver.id
    );

    if (driverRides.some((ride) => ['accepted', 'arrived', 'in_progress'].includes(ride.status))) {
      return fail(res, 409, 'Finish your current trip first.', 'ACTIVE_RIDE');
    }

    const wallet = getWallet(driver);

    if (Number(wallet.balance) > 0) {
      return fail(
        res,
        409,
        'Withdraw your wallet balance first.',
        'BALANCE_REMAINING'
      );
    }

    if (
      db.withdrawals.some(
        (withdrawal) =>
          withdrawal.driverId === driver.id &&
          ['pending', 'processing'].includes(withdrawal.status)
      )
    ) {
      return fail(
        res,
        409,
        'Wait for your withdrawal to finish first.',
        'PAYOUT_PENDING'
      );
    }

    const unpaid = db.payments.some(
      (payment) =>
        (payment.driverId === driver.id || payment.userId === user.id) &&
        ['pending', 'unpaid'].includes(payment.status) &&
        ['subscription', 'driver_subscription', 'fee', 'driver_fee'].includes(payment.type)
    );

    const owed =
      Number(driver.amountOwed || 0) > 0 ||
      unpaid ||
      db.subscriptions.some(
        (subscription) =>
          subscription.driverId === driver.id &&
          Number(subscription.amountOwed || 0) > 0
      );

    if (owed) {
      return fail(res, 409, 'Clear what you owe first.', 'AMOUNT_OWED');
    }

    const closedAt = timestamp();

    user.statusBeforeClosure = user.status;
    user.status = 'closed';
    user.tokenVersion = Number(user.tokenVersion || 0) + 1;
    user.closedAt = closedAt;
    user.closeReason = req.body.reason || null;
    user.updatedAt = closedAt;

    driver.statusBeforeClosure = driver.status;
    driver.onlineStatus = false;
    driver.status = 'closed';
    driver.closedAt = closedAt;

    db.sseTokens = (db.sseTokens || []).filter(
      (ticket) => ticket.userId !== user.id
    );

    db.auditLogs.push({
      id: id(),
      actorUserId: user.id,
      targetUserId: user.id,
      action: 'driver.account.closed',
      reason: user.closeReason,
      createdAt: closedAt,
    });

    return ok(res, 'Account closed. Your records are kept.', {
      status: 'closed',
      closed_at: closedAt,
    });
  })
);

export default router;
