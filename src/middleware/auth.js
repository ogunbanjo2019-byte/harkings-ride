import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { fail } from '../shared/core.js';
import { findUser, publicUser } from '../database/store.js';

export const requireAuth = (req, res, next) => {
  const header = req.headers.authorization;

  if (!header?.startsWith('Bearer ')) {
    return fail(res, 401, 'Authentication required', 'AUTH_REQUIRED');
  }

  try {
    const payload = jwt.verify(header.slice(7), env.jwtSecret);

    if (payload.type === 'refresh') {
      return fail(res, 401, 'Use an access token', 'ACCESS_TOKEN_REQUIRED');
    }

    const user = findUser({ id: payload.sub });

    if (user?.status === 'closed') {
      return fail(
        res,
        403,
        'This account is closed. Contact support if you need your records.',
        'ACCOUNT_CLOSED'
      );
    }

    if (!user || ['suspended', 'deletion_requested'].includes(user.status)) {
      return fail(res, 401, 'Account is not active', 'ACCOUNT_INACTIVE');
    }

    if (env.emailVerificationRequired && user.email && !user.emailVerifiedAt) {
      return fail(res, 403, 'Verify your email address before using this account.', 'EMAIL_NOT_VERIFIED');
    }

    if (Number(payload.ver || 0) !== Number(user.tokenVersion || 0)) {
      return fail(res, 401, 'Session has been revoked. Please sign in again.', 'SESSION_REVOKED');
    }

    req.authPayload = payload;
    req.user = publicUser(user);
    next();
  } catch {
    return fail(res, 401, 'Invalid or expired token', 'INVALID_TOKEN');
  }
};

export const requireRole = (...roles) => (req, res, next) => {
  if (roles.includes(req.user?.role)) {
    return next();
  }

  return fail(
    res,
    403,
    'You do not have permission to perform this action',
    'FORBIDDEN'
  );
};

export const requireAdminMfa = (req, res, next) => {
  if (req.user?.role !== 'admin' || !env.adminMfaRequired) return next();
  const user = findUser({ id: req.user.id });
  if (!user?.adminMfaEnabled) {
    return fail(res, 403, 'Admin MFA enrollment is required before using admin operations.', 'ADMIN_MFA_ENROLLMENT_REQUIRED');
  }
  if (req.authPayload?.mfa !== true) {
    return fail(res, 401, 'Sign in with an authenticator code to continue.', 'ADMIN_MFA_REQUIRED');
  }
  return next();
};
