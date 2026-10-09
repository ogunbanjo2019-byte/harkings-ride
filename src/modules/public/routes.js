import { Router } from 'express';
import { createHash } from 'node:crypto';
import { db, findRide } from '../../database/store.js';
import { fail, ok } from '../../shared/core.js';

const router = Router();

// GET /api/v1/public/trips/:token - Retrieve live public trip status using a secure share token
router.get('/trips/:token', (req, res) => {
  const tokenHash = createHash('sha256').update(req.params.token).digest('hex');
  const record = (db.shareTokens || []).find((item) => item.tokenHash === tokenHash);
  const ride = record && findRide(record.rideId);

  if (!ride) {
    return fail(res, 404, 'Share link not found', 'SHARE_LINK_NOT_FOUND');
  }

  if (['completed', 'cancelled'].includes(ride.status)) {
    return fail(res, 410, 'Trip sharing has ended', 'SHARE_LINK_EXPIRED');
  }

  const driver = ride.driverId ? db.drivers.find((item) => item.id === ride.driverId) : null;
  const user = driver ? db.users.find((item) => item.id === driver.userId) : null;
  const vehicle = driver ? db.vehicles.find((item) => item.driverId === driver.id) : null;

  return ok(res, 'Shared trip status', {
    status: ride.status,
    driver: driver
      ? {
          firstName: (user?.name || '').split(' ')[0] || null,
          plateNumber:
            vehicle?.plateNumber ||
            vehicle?.plate ||
            vehicle?.registrationNumber ||
            driver.vehiclePlateNumber ||
            user?.vehiclePlateNumber ||
            null,
        }
      : null,
    position: driver?.currentLocation
      ? {
          latitude: driver.currentLocation.latitude,
          longitude: driver.currentLocation.longitude,
          recordedAt: driver.currentLocation.recordedAt,
        }
      : null,
  });
});

export default router;

