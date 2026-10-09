import { db, id, timestamp } from '../database/store.js';
import { env } from '../config/env.js';

export const submitIdentityCheck = ({ driverId, type, reference, metadata = {} }) => {
  const existing = db.identityChecks.find((item) => 
    item.driverId === driverId && 
    item.type === type && 
    ['pending', 'provider_pending', 'manual_review'].includes(item.status)
  );

  if (existing) {
    return existing;
  }
  const check = {
    id: id(),
    driverId,
    type,
    provider: env.identityProvider || 'manual',
    providerReference: reference || null,
    status: env.identityProvider ? 'provider_pending' : 'manual_review',
    metadata,
    attempts: 0,
    createdAt: timestamp(),
    updatedAt: timestamp(),
  };

  db.identityChecks.push(check);
  return check;
};

export const updateIdentityCheck = (checkId, status, details = {}) => {
  const check = db.identityChecks.find((item) => item.id === checkId);
  
  if (!check) {
    return null;
  }

  Object.assign(check, {
    status,
    ...details,
    updatedAt: timestamp(),
  });

  return check;
};