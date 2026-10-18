import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { db, findDriverByUser, findUser, id, timestamp } from '../../database/store.js';
import { asyncHandler, fail, ok, paginate } from '../../shared/core.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/errors.js';
import { storePrivateFile, validateUpload } from '../../services/storage.js';
import { isValidVehiclePlate, normalizeVehiclePlate } from '../../services/vehicle-plate.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.uploadMaxBytes, files: 1 },
});

router.use(requireAuth, requireRole('driver'));
const driverOf = (req) => findDriverByUser(req.user.id);

const requireDriver = (req, res) => {
  const driver = driverOf(req);
  if (!driver) {
    fail(res, 404, 'Driver profile not found', 'DRIVER_NOT_FOUND');
    return null;
  }
  return driver;
};

const updateProfileSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  email: z.string().email().optional(),
  phone: z.string().min(7).max(30).optional(),
  vehiclePlateNumber: z.string().trim().min(7).max(10).optional().refine((value) => !value || isValidVehiclePlate(value), 'Enter a valid plate in the format ABC-123XY'),
});

const updateStatusSchema = z.object({
  isOnline: z.boolean(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
});

const documentUploadSchema = z.object({ documentType: z.string().min(2).max(60).optional(), document_type: z.string().min(2).max(60).optional() }).transform((v) => ({ documentType: v.documentType || v.document_type })).pipe(z.object({ documentType: z.string().min(2).max(60) }));

const identityVerificationSchema = z.object({
  verificationType: z.enum(['nin', 'biometric', 'facial']),
  providerReference: z.string().max(200).optional(),
});

const updateLocationSchema = z.object({
  latitude: z.number().gte(-90).lte(90),
  longitude: z.number().gte(-180).lte(180),
  rideId: z.string().optional(),
  ride_id: z.string().optional(),
}).transform(({ ride_id, ...v }) => ({ ...v, rideId: v.rideId || ride_id }));


router.get('/profile', (req, res) => {
  const driver = driverOf(req);
  const vehicle = driver ? db.vehicles.find((v) => v.driverId === driver.id) || null : null;

  return ok(res, 'Driver profile', {
    user: req.user,
    driver,
    vehicle,
  });
});

router.put('/profile', validate(updateProfileSchema), (req, res) => {
  const user = findUser({ id: req.user.id });
  if (!user) return fail(res, 404, 'User not found', 'USER_NOT_FOUND');
  const { vehiclePlateNumber: submittedPlate, ...profile } = req.body;
  let driver;
  let plate;
  if (submittedPlate) {
    driver = driverOf(req);
    if (!driver) return fail(res, 404, 'Driver profile not found', 'DRIVER_NOT_FOUND');
    plate = normalizeVehiclePlate(submittedPlate);
    const duplicate = db.drivers.some((item) => item.id !== driver.id && normalizeVehiclePlate(item.vehiclePlateNumber) === plate);
    if (duplicate) return fail(res, 409, 'This vehicle plate is already registered.', 'VEHICLE_PLATE_IN_USE');
  }
  Object.assign(user, profile, { updatedAt: timestamp() });
  if (submittedPlate) {
    if (driver.vehiclePlateNumber !== plate) {
      driver.vehiclePlateNumber = plate;
      driver.vehicleVerificationStatus = 'pending';
      driver.vehicleVerifiedAt = null;
      driver.vehicleReviewNote = null;
      driver.updatedAt = timestamp();
      user.vehiclePlateNumber = plate;
    }
  }

  return ok(res, 'Driver profile updated', { user });
});


router.post('/status', validate(updateStatusSchema), (req, res) => {
  const driver = requireDriver(req, res);
  if (!driver) return;

  if (req.body.isOnline && driver.status === 'suspended') {
    return fail(res, 403, 'This driver account is suspended.', 'DRIVER_SUSPENDED');
  }
  if (
    req.body.isOnline &&
    (driver.status !== 'active' || driver.verificationStatus !== 'approved')
  ) {
    return fail(
      res,
      403,
      'Driver must be approved before going online',
      'DRIVER_NOT_APPROVED'
    );
  }
  if (req.body.isOnline && driver.vehicleVerificationStatus !== 'verified') {
    return fail(res, 403, 'Vehicle plate and registration document must be verified before going online.', 'VEHICLE_NOT_VERIFIED');
  }
  if (req.body.isOnline && env.isProduction && driver.verification?.nin?.status !== 'verified') {
    return fail(res, 403, 'NIN must be verified before going online.', 'NIN_NOT_VERIFIED');
  }
  if (
    req.body.isOnline &&
    env.isProduction &&
    !db.identityChecks.some(
      (check) => check.driverId === driver.id && check.type === 'aws_face_liveness' && check.status === 'approved'
    )
  ) {
    return fail(res, 403, 'Face verification must pass before going online.', 'FACE_NOT_VERIFIED');
  }

  driver.onlineStatus = req.body.isOnline;

  if (req.body.latitude !== undefined) {
    driver.currentLocation = {
      latitude: req.body.latitude,
      longitude: req.body.longitude,
      recordedAt: timestamp(),
    };
  }

  return ok(res, `Driver is now ${driver.onlineStatus ? 'online' : 'offline'}`, { driver });
});

router.post('/location', validate(updateLocationSchema), (req, res) => {
  const driver = requireDriver(req, res);
  if (!driver) return;

  if (req.body.rideId) {
    const ride = db.rides.find((item) => item.id === req.body.rideId);
    if (!ride || ride.driverId !== driver.id || !['accepted', 'arrived', 'in_progress'].includes(ride.status)) {
      return fail(res, 404, 'Active ride not found for this driver', 'RIDE_NOT_FOUND');
    }
  }

  driver.currentLocation = {
    ...req.body,
    recordedAt: timestamp(),
  };

  if (req.body.rideId) {
    db.rideLocations.push({
      id: id(),
      driverId: driver.id,
      ...req.body,
      recordedAt: timestamp(),
    });
  }

  return ok(res, 'Location updated', { location: driver.currentLocation });
});

router.get('/verification-status', (req, res) => {
  const driver = requireDriver(req, res);
  if (!driver) return;

  const documents = db.documents
    .filter((d) => d.driverId === driver.id)
    .map(({ storage, ...d }) => d);

  return ok(res, 'Verification status', {
    status: driver.verificationStatus,
    documents,
  });
});

router.post(
  '/documents',
  upload.single('document'),
  validate(documentUploadSchema),
  asyncHandler(async (req, res) => {
    const driver = requireDriver(req, res);
    if (!driver) return;

    if (!req.file) {
      return fail(res, 400, 'Document file is required', 'FILE_REQUIRED');
    }

    validateUpload(req.file);

    const documentId = id();
    const stored = await storePrivateFile({
      path: `drivers/${driver.id}/documents/${documentId}`,
      file: req.file,
    });

    const document = {
      id: documentId,
      driverId: driver.id,
      documentType: req.body.documentType,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      storage: stored,
      status: 'pending',
      createdAt: timestamp(),
    };

    db.documents.push(document);

    return ok(res, 'Document submitted for review', { document }, 201);
  })
);

router.post('/identity-verification', validate(identityVerificationSchema), (req, res) => {
  const driver = requireDriver(req, res);
  if (!driver) return;

  driver.identityVerification = {
    ...req.body,
    status: 'pending_manual_review',
    submittedAt: timestamp(),
  };

  return ok(
    res,
    'Identity verification submitted',
    { verification: driver.identityVerification },
    202
  );
});


router.get('/trips', (req, res) => {
  const driver = requireDriver(req, res);
  if (!driver) return;

  const rides = db.rides.filter((r) => r.driverId === driver.id);

  return ok(res, 'Driver trips', paginate(rides, req.query.page, req.query.limit));
});

router.get('/earnings', (req, res) => {
  const driver = requireDriver(req, res);
  if (!driver) return;

  const rides = db.rides.filter(
    (r) => r.driverId === driver.id && r.status === 'completed'
  );

  const total = rides.reduce((sum, r) => sum + Number(r.fare || 0), 0);
  const wallet = db.wallets.find((item) => item.driverId === driver.id);
  const todayKey = new Date().toISOString().slice(0, 10);
  const today = rides.filter((ride) => String(ride.completedAt || ride.updatedAt || '').slice(0, 10) === todayKey);
  const sevenDayThreshold = Date.now() - 7 * 86400000;
  const sevenDays = rides.filter((ride) => new Date(ride.completedAt || ride.updatedAt || 0).getTime() >= sevenDayThreshold);
  const sumFare = (list) => list.reduce((sum, ride) => sum + Number(ride.fare || 0), 0);
  return ok(res, 'Driver earnings', { total, trips: rides.length, available_balance: Number(wallet?.balance || 0), today: sumFare(today), last_7_days: sumFare(sevenDays), average: rides.length ? Math.round(total / rides.length) : 0, streak: driver.earningsStreak || 0, level: driver.earningsLevel || 'starter' });
});

export default router;
  