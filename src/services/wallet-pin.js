import bcrypt from 'bcryptjs';
import { db, id, timestamp } from '../database/store.js';

const LOCK_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

export const verifyDriverWalletPin = async ({ driver, security, pin }) => {
  const lockedUntil = security?.pinLockedUntil ? new Date(security.pinLockedUntil).getTime() : 0;
  if (lockedUntil > Date.now()) {
    return { result: 'locked', retryAfterSeconds: Math.ceil((lockedUntil - Date.now()) / 1000) };
  }
  if (security?.pinLockedUntil && lockedUntil <= Date.now()) {
    security.pinLockedUntil = null;
    security.pinFailedAttempts = 0;
    security.updatedAt = timestamp();
  }
  if (!security?.walletPinHash || !security?.duressPinHash) return { result: 'not_configured' };

  if (await bcrypt.compare(pin, security.duressPinHash)) {
    security.pinFailedAttempts = 0;
    security.pinLockedUntil = null;
    security.updatedAt = timestamp();
    return { result: 'duress' };
  }
  if (await bcrypt.compare(pin, security.walletPinHash)) {
    security.pinFailedAttempts = 0;
    security.pinLockedUntil = null;
    security.updatedAt = timestamp();
    return { result: 'valid' };
  }

  security.pinFailedAttempts = Number(security.pinFailedAttempts || 0) + 1;
  security.lastPinFailureAt = timestamp();
  if (security.pinFailedAttempts >= MAX_ATTEMPTS) {
    security.pinLockedUntil = new Date(Date.now() + LOCK_MS).toISOString();
    security.updatedAt = timestamp();
    return { result: 'locked', retryAfterSeconds: LOCK_MS / 1000 };
  }
  security.updatedAt = timestamp();
  return { result: 'invalid', attemptsRemaining: MAX_ATTEMPTS - security.pinFailedAttempts };
};

export const recordWalletDuressAlert = (driver, reference, action) => {
  const alreadySignalled = db.sosEvents.some(
    (event) => event.duressReference === reference && event.driverId === driver.id
  );
  if (alreadySignalled) return;
  const location = driver.currentLocation || {};
  const createdAt = timestamp();
  const event = {
    id: id(),
    driverId: driver.id,
    duressReference: reference,
    alertType: 'wallet_duress',
    action,
    latitude: Number.isFinite(Number(location.latitude)) ? Number(location.latitude) : null,
    longitude: Number.isFinite(Number(location.longitude)) ? Number(location.longitude) : null,
    locationRecordedAt: location.recordedAt || null,
    note: 'Wallet duress PIN entered',
    status: 'open',
    createdAt,
  };
  db.sosEvents.push(event);
  driver.lastSosAt = createdAt;
  const adminUsers = db.users.filter((user) => user.role === 'admin' && user.status !== 'closed');
  for (const admin of adminUsers) {
    db.notifications.push({
      id: id(),
      userId: admin.id,
      type: 'wallet_duress',
      title: 'Urgent wallet security alert',
      body: 'A wallet security event requires review.',
      data: {
        sosId: event.id,
        driverId: driver.id,
        action,
        latitude: event.latitude,
        longitude: event.longitude,
        locationRecordedAt: event.locationRecordedAt,
      },
      isRead: false,
      createdAt,
    });
  }
};
