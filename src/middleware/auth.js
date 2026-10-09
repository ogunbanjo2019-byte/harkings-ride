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

    if (!user || ['suspended', 'deletion_requested'].includes(user.status)) {
      return fail(res, 401, 'Account is not active', 'ACCOUNT_INACTIVE');
    }

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