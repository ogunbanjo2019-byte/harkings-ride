import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { db, findDriverByUser, findUser, id, timestamp } from '../../database/store.js';
import { asyncHandler, fail, ok, paginate } from '../../shared/core.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/errors.js';
import { storePrivateFile, validateUpload } from '../../services/storage.js';

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
  vehiclePlateNumber: z.string().min(2).max(30).optional(),
});

const updateStatusSchema = z.object({
  isOnline: z.boolean(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
});

const documentUploadSchema = z.object({
  documentType: z.string().min(2).max(60),
});

const identityVerificationSchema = z.object({
  verificationType: z.enum(['nin', 'biometric', 'facial']),
  providerReference: z.string().max(200).optional(),
});

const updateLocationSchema = z.object({
  latitude: z.number().gte(-90).lte(90),
  longitude: z.number().gte(-180).lte(180),
  rideId: z.string().optional(),
});


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

  Object.assign(user, req.body, { updatedAt: timestamp() });

  return ok(res, 'Driver profile updated', { user });
});


router.post('/status', validate(updateStatusSchema), (req, res) => {
  const driver = requireDriver(req, res);
  if (!driver) return;

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

  return ok(res, 'Driver earnings', {
    total,
    trips: rides.length,
  });
});

export default router;