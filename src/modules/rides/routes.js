import { Router } from 'express';
import { z } from 'zod';

import {
  creditWallet,
  db,
  eligibleDrivers,
  findDriverByUser,
  findRide,
  id,
  timestamp,
  transitionAllowed,
} from '../../database/store.js';
import { asyncHandler, fail, ok, paginate } from '../../shared/core.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/errors.js';
import { emitRideEvent } from '../../services/realtime.js';
import { calculateFare } from '../../services/pricing.js';
import { env } from '../../config/env.js';
import { createHash, randomBytes } from 'node:crypto';

const router = Router();
router.use(requireAuth);

// Return a rounded average, or null when there are no ratings yet.
const averageRating = (ratings) => {
  if (!ratings.length) return null;
  return Math.round((ratings.reduce((sum, item) => sum + Number(item.rating || 0), 0) / ratings.length) * 10) / 10;
};

const getDriverForRide = (ride) => {
  if (!ride.driverId) return null;

  const driver = db.drivers.find((item) => item.id === ride.driverId);
  if (!driver) return null;

  const user = db.users.find((item) => item.id === driver.userId);
  const vehicle = db.vehicles.find((item) => item.driverId === driver.id) || {};
  const driverRatings = db.ratings.filter((item) => {
    const ratedRide = db.rides.find((candidate) => candidate.id === item.rideId);
    return ratedRide?.driverId === driver.id;
  });

  return {
    id: driver.id,
    name: user?.name || null,
    phone: user?.phone || null,
    vehicleModel: vehicle.vehicleModel || vehicle.model || null,
    plateNumber:
      vehicle.plateNumber || vehicle.plate || vehicle.registrationNumber ||
      driver.vehiclePlateNumber || user?.vehiclePlateNumber || null,
    rating: averageRating(driverRatings),
  };
};

const getRiderForRide = (ride) => {
  const user = db.users.find((item) => item.id === ride.riderId);
  if (!user) return null;

  const rider = db.riders.find((item) => item.userId === ride.riderId) || {};
  const riderRatings = db.ratings.filter((item) => item.riderId === ride.riderId);

  return {
    name: user.name || null,
    phone: user.phone || null,
    rating: averageRating(riderRatings),
    photoUrl: rider.photoUrl || user.photoUrl || null,
  };
};

const rideForViewer = (ride, viewer) => {
  const isRideOwner = viewer.role === 'rider' && ride.riderId === viewer.id;
  const assignedDriver = findDriverByUser(viewer.id);
  const isAssignedDriver = viewer.role === 'driver' && ride.driverId === assignedDriver?.id;
  const isAdmin = viewer.role === 'admin';
  const canSeeDriver = isRideOwner || isAssignedDriver || isAdmin;
  const canSeeRider = isRideOwner || isAssignedDriver || isAdmin;
  const assignedDriverRecord = ride.driverId
    ? db.drivers.find((item) => item.id === ride.driverId)
    : null;
  const currentLocation = assignedDriverRecord?.currentLocation;
  const rideLocations = db.rideLocations
    .filter((item) => item.rideId === ride.id)
    .sort((a, b) => String(b.recordedAt || '').localeCompare(String(a.recordedAt || '')));
  const latestLocation = currentLocation || rideLocations[0] || null;

  return {
    ...ride,
    alreadyRated: db.ratings.some((rating) => rating.rideId === ride.id && rating.riderId === ride.riderId),
    driver: canSeeDriver ? getDriverForRide(ride) : null,
    rider: canSeeRider ? getRiderForRide(ride) : null,
    driverLocation:
      canSeeDriver && latestLocation
        ? {
            latitude: latestLocation.latitude,
            longitude: latestLocation.longitude,
            recordedAt: latestLocation.recordedAt || null,
          }
        : null,
  };
};

const coordinateSchema = z.object({
  latitude: z.number().gte(-90).lte(90),
  longitude: z.number().gte(-180).lte(180),
  address: z.string().optional(),
});

const createRideSchema = z.object({
  pickup: coordinateSchema,
  destination: coordinateSchema,
  estimatedFare: z.number().positive().optional(), // compatibility only; never used as the stored fare
  paymentMethod: z.enum(['cash','card','bank_transfer','ussd','wallet']).default('card'),
  notes: z.string().max(500).optional(),
});

const completeRideSchema = z
  .object({
    fare: z.number().positive().optional(),
  })
  .optional();

const transition = (expectedRole, nextStatus) => (req, res) => {
  const ride = findRide(req.params.id);
  const driver = findDriverByUser(req.user.id);

  if (!ride) {
    return fail(res, 404, 'Ride not found', 'RIDE_NOT_FOUND');
  }

  if (expectedRole === 'driver' && ride.driverId !== driver?.id) {
    return fail(res, 403, 'Ride is not assigned to this driver', 'FORBIDDEN');
  }

  if (!transitionAllowed[ride.status]?.includes(nextStatus)) {
    return fail(
      res,
      409,
      `Cannot move ride from ${ride.status} to ${nextStatus}`,
      'INVALID_RIDE_TRANSITION'
    );
  }

  ride.status = nextStatus;
  ride.updatedAt = timestamp();
  ride[`${nextStatus}At`] = timestamp();

  if (nextStatus === 'completed' && !db.payments.some((p) => p.rideId === ride.id && p.type === 'ride')) {
    db.payments.push({id:id(),rideId:ride.id,userId:ride.riderId,type:'ride',amount:ride.fare,provider:'pending',status:'pending',currency:ride.fareBreakdown?.currency||'NGN',createdAt:timestamp()});
  }

  emitRideEvent(ride, nextStatus);

  return ok(res, `Ride marked ${nextStatus}`, { ride });
};

router.get('/', requireRole('rider', 'driver', 'admin'), (req, res) => {
  const driver = req.user.role === 'driver' ? findDriverByUser(req.user.id) : null;

  let rides = db.rides;
  if (req.user.role === 'rider') {
    rides = db.rides.filter((ride) => ride.riderId === req.user.id);
  } else if (req.user.role === 'driver') {
    if (!driver) {
      return fail(res, 404, 'Driver profile not found', 'DRIVER_NOT_FOUND');
    }

    rides = db.rides.filter((ride) => {
      const alreadyAssigned = ride.driverId === driver.id;
      const offeredToThisDriver =
        ride.status === 'requested' &&
        ride.driverId == null &&
        Array.isArray(ride.candidateDriverIds) &&
        ride.candidateDriverIds.includes(driver.id) &&
        !(ride.declinedDriverIds || []).includes(driver.id);

      return alreadyAssigned || offeredToThisDriver;
    });
  }

  const visibleRides = rides.map((ride) => rideForViewer(ride, req.user));
  return ok(res, 'Rides', paginate(visibleRides, req.query.page, req.query.limit));
});

const fareEstimateSchema=z.object({pickup:coordinateSchema,destination:coordinateSchema,paymentMethod:z.enum(['cash','card','bank_transfer','ussd','wallet']).default('card')});
router.post('/fare-estimate',requireRole('rider'),validate(fareEstimateSchema),(req,res)=>ok(res,'Fare estimate',calculateFare(req.body)));

router.post('/', requireRole('rider'), validate(createRideSchema), (req, res) => {
  const outstanding=db.payments.some(p=>p.userId===req.user.id&&p.status==='pending'&&['ride','cancellation_fee'].includes(p.type));
  if(outstanding)return fail(res,409,'Settle your outstanding balance before requesting another ride','OUTSTANDING_PAYMENT');
  const fareBreakdown=calculateFare(req.body);
  if (env.isProduction && fareBreakdown.pricingConfigurationRequired) return fail(res, 503, 'Admin must configure the live tariff before bookings are enabled', 'PRICING_NOT_CONFIGURED');
  const ride = {
    id: id(), riderId: req.user.id, driverId: null,
    pickup:req.body.pickup,destination:req.body.destination,notes:req.body.notes,
    paymentMethod:req.body.paymentMethod||'card',fare:fareBreakdown.totalFare,fareBreakdown,tariffVersion:fareBreakdown.tariffVersion,
    status: 'requested',
    requestedAt: timestamp(),
    createdAt: timestamp(),
    updatedAt: timestamp(),
  };

  ride.candidateDriverIds = eligibleDrivers().map((d) => d.id);
  db.rides.push(ride);

  return ok(
    res,
    'Ride created successfully',
    { ride: rideForViewer(ride, req.user), matchedDrivers: ride.candidateDriverIds.length },
    201
  );
});

router.post('/:id/share',requireRole('rider'),(req,res)=>{
 const ride=findRide(req.params.id);if(!ride||ride.riderId!==req.user.id)return fail(res,404,'Ride not found','RIDE_NOT_FOUND');
 if(['completed','cancelled'].includes(ride.status))return fail(res,409,'Trip sharing is unavailable after the ride ends','RIDE_ENDED');
 const rawToken=randomBytes(32).toString('hex'),tokenHash=createHash('sha256').update(rawToken).digest('hex');
 db.shareTokens=db.shareTokens||[];db.shareTokens=db.shareTokens.filter(x=>x.rideId!==ride.id);db.shareTokens.push({id:id(),rideId:ride.id,tokenHash,createdAt:timestamp()});
 return ok(res,'Trip share link created',{url:`${env.appPublicUrl}/trip/${rawToken}`},201);
});

router.get('/:id', (req, res) => {
  const ride = findRide(req.params.id);

  if (!ride) {
    return fail(res, 404, 'Ride not found', 'RIDE_NOT_FOUND');
  }

  const isRiderOwner = req.user.role === 'rider' && ride.riderId === req.user.id;
  const isDriverOwner =
    req.user.role === 'driver' &&
    ride.driverId &&
    ride.driverId === findDriverByUser(req.user.id)?.id;
  const isAdmin = req.user.role === 'admin';

  if (!isRiderOwner && !isDriverOwner && !isAdmin) {
    return fail(res, 403, 'Ride access denied', 'FORBIDDEN');
  }

  const locations = db.rideLocations
    .filter((location) => location.rideId === ride.id)
    .sort((a, b) => String(a.recordedAt || '').localeCompare(String(b.recordedAt || '')));

  return ok(res, 'Ride details', { ride: rideForViewer(ride, req.user), locations });
});



router.post('/:id/accept', requireRole('driver'), (req, res) => {
  const ride = findRide(req.params.id);
  const driver = findDriverByUser(req.user.id);

  if (!ride) {
    return fail(res, 404, 'Ride not found', 'RIDE_NOT_FOUND');
  }

  if (!driver || !eligibleDrivers().some((d) => d.id === driver.id)) {
    return fail(res, 403, 'Driver is not eligible to accept rides', 'DRIVER_NOT_ELIGIBLE');
  }

  if (ride.status !== 'requested' || ride.driverId) {
    return fail(res, 409, 'Ride is no longer available', 'RIDE_UNAVAILABLE');
  }

  if (
    !(ride.candidateDriverIds || []).includes(driver.id) ||
    (ride.declinedDriverIds || []).includes(driver.id)
  ) {
    return fail(
      res,
      403,
      'This ride was not offered to this driver',
      'RIDE_NOT_OFFERED_TO_DRIVER'
    );
  }

  ride.driverId = driver.id;
  ride.status = 'accepted';
  ride.acceptedAt = timestamp();
  ride.updatedAt = timestamp();

  emitRideEvent(ride, 'accepted');

  return ok(res, 'Ride accepted successfully', { ride: rideForViewer(ride, req.user) });
});

router.post('/:id/decline', requireRole('driver'), (req, res) => {
  const ride = findRide(req.params.id);
  const driver = findDriverByUser(req.user.id);

  if (!ride || ride.status !== 'requested') {
    return fail(res, 409, 'Ride is no longer available', 'RIDE_UNAVAILABLE');
  }

  if (driver?.id) {
    ride.declinedDriverIds = [...(ride.declinedDriverIds || []), driver.id];
  }

  return ok(res, 'Ride declined');
});

router.post('/:id/arrived', requireRole('driver'), transition('driver', 'arrived'));

router.post('/:id/start', requireRole('driver'), transition('driver', 'in_progress'));

router.post(
  '/:id/complete',
  requireRole('driver'),
  validate(completeRideSchema),
  transition('driver', 'completed')
);

const cashReceivedSchema=z.object({amount:z.number().positive()});
router.post('/:id/cash-received',requireRole('driver'),validate(cashReceivedSchema),(req,res)=>{
  const ride=findRide(req.params.id),driver=findDriverByUser(req.user.id);
  if(!ride||!driver||ride.driverId!==driver.id||ride.status!=='completed')return fail(res,404,'Completed ride not found for this driver','RIDE_NOT_FOUND');
  const payment=db.payments.find(p=>p.rideId===ride.id&&p.type==='ride');
  if(!payment)return fail(res,404,'Ride payment record not found','PAYMENT_NOT_FOUND');
  if(payment.status==='successful')return ok(res,'Ride payment already settled',{payment});
  const expected=ride.paymentMethod==='cash'?ride.fare:ride.fare+Number(ride.fareBreakdown?.cashSurcharge||0);
  if(Math.round(req.body.amount)!==Math.round(expected))return fail(res,400,'Collected cash does not match the ride cash fare','CASH_AMOUNT_MISMATCH',{expectedAmount:expected});
  payment.amount=expected;payment.provider='cash';payment.status='successful';payment.verifiedAt=timestamp();
  if(!ride.driverPaidAt){creditWallet(driver.id,ride.fare,ride.id);ride.driverPaidAt=timestamp();}
  emitRideEvent(ride,'payment_successful',{paymentMethod:'cash',amount:expected});
  return ok(res,'Cash received and ride payment settled',{payment,driverEarning:ride.fare});
});

const CANCELLATION_GRACE_MS = 4 * 60 * 1000;
const RIDER_CANCELLATION_FEE_NGN = 200;

router.post('/:id/cancel', requireRole('rider', 'driver'), (req, res) => {
  const ride = findRide(req.params.id);
  const driver = findDriverByUser(req.user.id);

  if (!ride) {
    return fail(res, 404, 'Ride not found', 'RIDE_NOT_FOUND');
  }

  const isRiderOwner = req.user.role === 'rider' && ride.riderId === req.user.id;
  const isDriverOwner = req.user.role === 'driver' && ride.driverId === driver?.id;

  if (!isRiderOwner && !isDriverOwner) {
    return fail(res, 404, 'Ride not found', 'RIDE_NOT_FOUND');
  }

  if (ride.status === 'in_progress') {
    return fail(res, 409, 'An in-progress ride cannot be cancelled', 'RIDE_CANNOT_BE_CANCELLED');
  }

  // If the assigned driver cancels before the trip starts, return the ride to matching.
  if (isDriverOwner) {
    if (!['accepted', 'arrived'].includes(ride.status)) {
      return fail(res, 409, 'Driver cannot cancel this ride at its current stage', 'INVALID_RIDE_TRANSITION');
    }

    const previousStatus = ride.status;
    const cancelledAt = timestamp();
    ride.declinedDriverIds = [...new Set([...(ride.declinedDriverIds || []), driver.id])];
    ride.driverId = null;
    ride.status = 'requested';
    ride.driverCancelledAt = cancelledAt;
    ride.updatedAt = cancelledAt;

    emitRideEvent(ride, 'cancelled', {
      cancelledBy: 'driver',
      previousStatus,
      reopenedForMatching: true,
    });
    emitRideEvent(ride, 'requested', {
      reason: 'driver_cancelled_reopened',
      excludedDriverId: driver.id,
    });

    return ok(res, 'Driver cancelled; ride reopened for matching', {
      ride: rideForViewer(ride, req.user),
      cancellationFee: 0,
      reopenedForMatching: true,
    });
  }

  if (!transitionAllowed[ride.status]?.includes('cancelled')) {
    return fail(res, 409, 'Ride cannot be cancelled now', 'INVALID_RIDE_TRANSITION');
  }

  let cancellationFee = 0;
  if (ride.status !== 'requested' && ride.acceptedAt) {
    const acceptedAtMs = new Date(ride.acceptedAt).getTime();
    if (Number.isFinite(acceptedAtMs) && Date.now() - acceptedAtMs > CANCELLATION_GRACE_MS) {
      cancellationFee = RIDER_CANCELLATION_FEE_NGN;
    }
  }

  ride.status = 'cancelled';
  ride.cancelledBy = 'rider';
  ride.cancelledAt = timestamp();
  ride.cancellationFee = cancellationFee;
  ride.updatedAt = ride.cancelledAt;

  if (cancellationFee > 0) {
    db.payments.push({
      id: id(),
      rideId: ride.id,
      userId: ride.riderId,
      type: 'cancellation_fee',
      amount: cancellationFee,
      currency: 'NGN',
      provider: 'pending',
      status: 'pending',
      createdAt: ride.cancelledAt,
    });
  }

  emitRideEvent(ride, 'cancelled', {
    cancelledBy: 'rider',
    cancellationFee,
  });

  return ok(res, 'Ride cancelled', {
    ride: rideForViewer(ride, req.user),
    cancellationFee,
  });
});

export default router;