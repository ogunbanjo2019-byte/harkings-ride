import { Router } from 'express';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { z } from 'zod';

import { env } from '../../config/env.js';
import {
  createDriver,
  createRider,
  createUser,
  db,
  findUser,
  id,
  publicUser,
  timestamp,
} from '../../database/store.js';
import { asyncHandler, fail, ok } from '../../shared/core.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/errors.js';
import { otpEmail, passwordResetEmail, sendEmail } from '../../services/email.js';
import { storePrivateFile, validateUpload } from '../../services/storage.js';

const router = Router();
const identityUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.uploadMaxBytes, files: 1 },
});

const OTP_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

// --- Helper Functions ---

const secretHash = (value) => createHash('sha256').update(value).digest('hex');

const issue = (user) => ({
  accessToken: jwt.sign({ sub: user.id, role: user.role }, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn,
  }),
  user: publicUser(user),
});

const refreshTokenFor = (user) =>
  jwt.sign({ sub: user.id, role: user.role, type: 'refresh' }, env.jwtSecret, {
    expiresIn: '30d',
  });

const sendPhoneOtp = async (to, code, purpose) => {
  if (
    env.smsProvider !== 'twilio' ||
    !env.twilioAccountSid ||
    !env.twilioAuthToken ||
    !env.twilioFromNumber
  ) {
    return { configured: false };
  }

  const auth = Buffer.from(`${env.twilioAccountSid}:${env.twilioAuthToken}`).toString('base64');
  const body = new URLSearchParams({
    To: to,
    From: env.twilioFromNumber,
    Body: `Your SwitchRide ${purpose} code is ${code}. It expires in 5 minutes.`,
  });

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${env.twilioAccountSid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    }
  );

  if (!response.ok) return { configured: true, sent: false };
  return { configured: true, sent: true };
};

const otpDestination = (body) => {
  return body.email
    ? { channel: 'email', destination: body.email.trim().toLowerCase() }
    : { channel: 'phone', destination: body.phone.trim() };
};

// --- Rate Limiters ---

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.otpRateLimit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many OTP requests. Try again later.',
    error: { code: 'OTP_RATE_LIMITED' },
  },
});

const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.resetRateLimit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many password reset requests. Try again later.',
    error: { code: 'RESET_RATE_LIMITED' },
  },
});

// --- Validation Schemas ---

const registerSchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email().optional(),
  phone: z.string().min(7).max(30),
  password: z.string().min(8).max(128),
  role: z.enum(['rider', 'driver']).default('rider'),
});

const loginSchema = z
  .object({
    email: z.string().email().optional(),
    phone: z.string().max(30).optional(),
    password: z.string().min(1).max(128),
  })
  .refine((value) => value.email || value.phone, 'Email or phone is required');

const otpRequestSchema = z
  .object({
    email: z.string().email().optional(),
    phone: z
      .string()
      .regex(/^\+[1-9]\d{7,14}$/, 'Use E.164 international phone format')
      .optional(),
    purpose: z.enum(['login', 'verification', 'password_reset']).default('login'),
  })
  .refine((value) => value.email || value.phone, 'Email or phone is required');

const verifyOtpSchema = z
  .object({
    challengeId: z.string().uuid().optional(),
    email: z.string().email().optional(),
    phone: z.string().min(7).optional(),
    purpose: z.enum(['login', 'verification', 'password_reset']).default('login'),
    otp: z.string().regex(/^\d{6}$/),
  })
  .refine(
    (value) => value.challengeId || value.email || value.phone,
    'Challenge ID or email/phone is required'
  );

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8).max(128),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(8).max(128),
});

// --- Auth Routes ---

// POST /api/v1/auth/register - Register a new rider or driver
router.post(
  '/register',
  validate(registerSchema),
  asyncHandler(async (req, res) => {
    const email = req.body.email?.trim().toLowerCase();

    if (findUser({ email }) || findUser({ phone: req.body.phone })) {
      return fail(res, 409, 'An account with these details already exists', 'ACCOUNT_EXISTS');
    }

    const user = createUser({
      ...req.body,
      email,
      passwordHash: await bcrypt.hash(req.body.password, 12),
    });

    delete user.password;

    if (user.role === 'driver') {
      createDriver(user.id);
    } else {
      createRider(user.id);
    }

    return ok(res, 'Registration successful', issue(user), 201);
  })
);

// POST /api/v1/auth/login - User authentication with email/phone & password
router.post(
  '/login',
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const email = req.body.email?.trim().toLowerCase();
    const user = findUser({ email, phone: req.body.phone });

    if (
      !user ||
      ['suspended', 'deletion_requested'].includes(user.status) ||
      !(await bcrypt.compare(req.body.password, user.passwordHash))
    ) {
      return fail(res, 401, 'Invalid credentials', 'INVALID_CREDENTIALS');
    }

    return ok(res, 'Login successful', issue(user));
  })
);

// POST /api/v1/auth/identity/nin - Submit rider NIN and selfie verification
router.post(
  '/identity/nin',
  requireAuth,
  identityUpload.single('selfie'),
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'rider') {
      return fail(res, 403, 'Rider identity submission only', 'FORBIDDEN');
    }

    const nin = String(req.body?.nin || '').trim();
    if (!/^\d{11}$/.test(nin)) {
      return fail(res, 400, 'NIN must contain 11 digits', 'INVALID_NIN');
    }

    if (!req.file) {
      return fail(res, 400, 'Selfie image is required', 'FILE_REQUIRED');
    }

    validateUpload(req.file);

    const existing = db.identityChecks.find(
      (x) =>
        x.userId === req.user.id &&
        x.type === 'rider_nin' &&
        ['pending', 'provider_pending', 'manual_review'].includes(x.status)
    );

    if (existing) {
      return ok(
        res,
        'Identity check already submitted',
        { status: existing.status, checkId: existing.id },
        202
      );
    }

    const checkId = id();
    const stored = await storePrivateFile({
      path: `riders/${req.user.id}/identity/${checkId}`,
      file: req.file,
    });

    const check = {
      id: checkId,
      userId: req.user.id,
      type: 'rider_nin',
      ninHash: secretHash(nin),
      selfieStorage: stored,
      provider: env.identityProvider || 'manual',
      status: 'manual_review',
      createdAt: timestamp(),
      updatedAt: timestamp(),
    };

    db.identityChecks.push(check);

    const user = findUser({ id: req.user.id });
    if (user) {
      user.ninVerified = false;
      user.ninVerificationStatus = 'pending';
    }

    return ok(
      res,
      'Identity submitted for manual review',
      { checkId: check.id, status: check.status, ninVerified: false },
      202
    );
  })
);

// GET /api/v1/auth/me - Get active authenticated user details
router.get('/me', requireAuth, (req, res) => {
  return ok(res, 'Authenticated user', { user: req.user });
});

// POST /api/v1/auth/logout - End active user session
router.post('/logout', requireAuth, (_req, res) => {
  return ok(res, 'Logout successful');
});

// POST /api/v1/auth/send-otp - Dispatch OTP via Email or SMS
router.post(
  '/send-otp',
  otpLimiter,
  validate(otpRequestSchema),
  asyncHandler(async (req, res) => {
    const { channel, destination } = otpDestination(req.body);

    if (
      channel === 'phone' &&
      (env.smsProvider !== 'twilio' ||
        !env.twilioAccountSid ||
        !env.twilioAuthToken ||
        !env.twilioFromNumber)
    ) {
      return fail(
        res,
        503,
        'Phone OTP is not configured. Configure Twilio SMS credentials on the server.',
        'SMS_PROVIDER_NOT_CONFIGURED'
      );
    }

    const now = timestamp();

    // Invalidate existing active OTP challenges
    db.otpChallenges
      .filter(
        (challenge) =>
          challenge.channel === channel &&
          challenge.destination === destination &&
          challenge.purpose === req.body.purpose &&
          !challenge.usedAt
      )
      .forEach((challenge) => {
        challenge.usedAt = now;
      });

    const code = String(randomInt(0, 1000000)).padStart(6, '0');
    const challenge = {
      id: id(),
      channel,
      destination,
      purpose: req.body.purpose,
      codeHash: secretHash(code),
      attempts: 0,
      maxAttempts: 5,
      expiresAt: new Date(Date.now() + OTP_EXPIRY_MS).toISOString(),
      createdAt: now,
      usedAt: null,
    };

    db.otpChallenges.push(challenge);

    let deliveryStatus;
    if (channel === 'email') {
      const emailResult = await sendEmail({
        to: destination,
        ...otpEmail({ code, purpose: req.body.purpose }),
      });
      deliveryStatus = emailResult.status;
    } else {
      const smsResult = await sendPhoneOtp(destination, code, req.body.purpose);
      if (!smsResult.sent) {
        challenge.usedAt = timestamp();
        return fail(res, 502, 'Could not send the SMS code', 'SMS_DELIVERY_FAILED');
      }
      deliveryStatus = 'sent';
    }

    const data = {
      challengeId: challenge.id,
      channel,
      expiresAt: challenge.expiresAt,
      deliveryStatus,
    };

    if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
      data.developmentOtp = code;
    }

    return ok(res, 'OTP generated', data, 202);
  })
);

// POST /api/v1/auth/verify-otp - Verify active OTP challenge
router.post('/verify-otp', validate(verifyOtpSchema), (req, res) => {
  const destination = req.body.email
    ? req.body.email.trim().toLowerCase()
    : req.body.phone?.trim();

  const challenge = db.otpChallenges
    .slice()
    .reverse()
    .find(
      (item) =>
        !item.usedAt &&
        item.purpose === req.body.purpose &&
        (req.body.challengeId ? item.id === req.body.challengeId : item.destination === destination)
    );

  if (!challenge || new Date(challenge.expiresAt) <= new Date()) {
    return fail(res, 400, 'OTP is invalid or expired', 'OTP_INVALID');
  }

  if (challenge.attempts >= challenge.maxAttempts) {
    return fail(res, 429, 'Too many OTP attempts', 'OTP_ATTEMPTS_EXCEEDED');
  }

  challenge.attempts += 1;

  if (challenge.codeHash !== secretHash(req.body.otp)) {
    return fail(res, 400, 'OTP is invalid or expired', 'OTP_INVALID');
  }

  challenge.usedAt = timestamp();

  if (challenge.channel === 'phone' && challenge.purpose === 'login') {
    const user = findUser({ phone: challenge.destination });
    if (!user || ['suspended', 'deletion_requested'].includes(user.status)) {
      return fail(
        res,
        401,
        'No active account is registered to this phone number',
        'ACCOUNT_NOT_FOUND'
      );
    }
    user.phoneVerifiedAt = timestamp();
    return ok(res, 'Phone login successful', {
      ...issue(user),
      refreshToken: refreshTokenFor(user),
    });
  }

  if (challenge.channel === 'phone') {
    const user = findUser({ phone: challenge.destination });
    if (user) user.phoneVerifiedAt = timestamp();
  }

  return ok(res, 'OTP verified', {
    verified: true,
    challengeId: challenge.id,
    purpose: challenge.purpose,
  });
});

// POST /api/v1/auth/refresh-token - Refresh expired access token using a refresh token
router.post('/refresh-token', (req, res) => {
  try {
    const payload = jwt.verify(req.body?.refreshToken, env.jwtSecret);
    if (payload.type !== 'refresh') {
      return fail(res, 401, 'Refresh token required', 'INVALID_REFRESH_TOKEN');
    }

    const user = findUser({ id: payload.sub });
    if (!user || ['suspended', 'deletion_requested'].includes(user.status)) {
      return fail(res, 401, 'Account is not active', 'ACCOUNT_INACTIVE');
    }

    return ok(res, 'Access token refreshed', issue(user));
  } catch {
    return fail(res, 401, 'Refresh token is invalid or expired', 'INVALID_REFRESH_TOKEN');
  }
});

// POST /api/v1/auth/change-password - Change current user password
router.post(
  '/change-password',
  requireAuth,
  validate(changePasswordSchema),
  asyncHandler(async (req, res) => {
    const user = findUser({ id: req.user.id });

    if (!user || !(await bcrypt.compare(req.body.currentPassword, user.passwordHash))) {
      return fail(res, 400, 'Current password is incorrect', 'INVALID_CURRENT_PASSWORD');
    }

    if (req.body.currentPassword === req.body.newPassword) {
      return fail(res, 400, 'New password must be different', 'PASSWORD_UNCHANGED');
    }

    user.passwordHash = await bcrypt.hash(req.body.newPassword, 12);
    user.updatedAt = timestamp();

    return ok(res, 'Password changed successfully');
  })
);

// POST /api/v1/auth/forgot-password - Request password reset email token
router.post(
  '/forgot-password',
  resetLimiter,
  validate(forgotPasswordSchema),
  asyncHandler(async (req, res) => {
    const user = findUser({ email: req.body.email.trim().toLowerCase() });
    const data = { sent: true };

    if (user?.email) {
      const rawToken = randomBytes(32).toString('hex');

      // Invalidate existing active reset tokens
      db.passwordResetTokens
        .filter((item) => item.userId === user.id && !item.usedAt)
        .forEach((item) => {
          item.usedAt = timestamp();
        });

      db.passwordResetTokens.push({
        id: id(),
        userId: user.id,
        tokenHash: secretHash(rawToken),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        createdAt: timestamp(),
        usedAt: null,
      });

      const emailResult = await sendEmail({
        to: user.email,
        ...passwordResetEmail({ name: user.name, token: rawToken }),
      });

      data.deliveryStatus = emailResult.status;

      if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
        data.developmentResetToken = rawToken;
      }
    }

    return ok(res, 'If the account exists, reset instructions have been sent', data, 202);
  })
);

// POST /api/v1/auth/reset-password - Reset password using valid reset token
router.post(
  '/reset-password',
  resetLimiter,
  validate(resetPasswordSchema),
  asyncHandler(async (req, res) => {
    const reset = db.passwordResetTokens.find(
      (item) => item.tokenHash === secretHash(req.body.token) && !item.usedAt
    );

    if (!reset || new Date(reset.expiresAt) <= new Date()) {
      return fail(res, 400, 'Reset token is invalid or expired', 'RESET_TOKEN_INVALID');
    }

    const user = findUser({ id: reset.userId });
    if (!user) {
      return fail(res, 400, 'Reset token is invalid or expired', 'RESET_TOKEN_INVALID');
    }

    user.passwordHash = await bcrypt.hash(req.body.password, 12);
    user.updatedAt = timestamp();
    reset.usedAt = timestamp();

    // Invalidate any other active reset tokens for this user
    db.passwordResetTokens
      .filter((item) => item.userId === user.id && !item.usedAt)
      .forEach((item) => {
        item.usedAt = timestamp();
      });

    if (user.email) {
      sendEmail({
        to: user.email,
        subject: 'Your SwitchRide password was changed',
        text: 'Your SwitchRide password was changed successfully. If this was not you, contact support immediately.',
        html: '<p>Your SwitchRide password was changed successfully. If this was not you, contact support immediately.</p>',
      }).catch((error) => console.error('Password-change email failed:', error.message));
    }

    return ok(res, 'Password reset successfully');
  })
);

export default router;