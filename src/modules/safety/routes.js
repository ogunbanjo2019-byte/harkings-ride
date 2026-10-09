import { Router } from 'express';
import { z } from 'zod';
import { db, findRide, id, timestamp } from '../../database/store.js';
import { fail, ok } from '../../shared/core.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/errors.js';
import { emitRideEvent } from '../../services/realtime.js';

const router = Router();
router.use(requireAuth, requireRole('rider'));

const contactSchema = z.object({
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(7).max(30),
});

const sosSchema = z.object({
  rideId: z.string().min(1),
  latitude: z.number().gte(-90).lte(90).optional(),
  longitude: z.number().gte(-180).lte(180).optional(),
  note: z.string().max(500).optional(),
});

router.get('/contacts', (req, res) => {
  const contacts = db.safetyContacts
    .filter((contact) => contact.userId === req.user.id)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .map(({ userId, ...contact }) => contact);
  return ok(res, 'Safety contacts', { contacts });
});

router.post('/contacts', validate(contactSchema), (req, res) => {
  const duplicate = db.safetyContacts.some(
    (contact) => contact.userId === req.user.id && contact.phone === req.body.phone
  );
  if (duplicate) {
    return fail(res, 409, 'This safety contact already exists', 'CONTACT_ALREADY_EXISTS');
  }

  const contact = {
    id: id(),
    userId: req.user.id,
    name: req.body.name,
    phone: req.body.phone,
    createdAt: timestamp(),
  };
  db.safetyContacts.push(contact);
  return ok(res, 'Safety contact added', { contact: { id: contact.id, name: contact.name, phone: contact.phone } }, 201);
});

router.delete('/contacts/:id', (req, res) => {
  const index = db.safetyContacts.findIndex(
    (contact) => contact.id === req.params.id && contact.userId === req.user.id
  );
  if (index < 0) {
    return fail(res, 404, 'Safety contact not found', 'CONTACT_NOT_FOUND');
  }
  db.safetyContacts.splice(index, 1);
  return ok(res, 'Safety contact removed', { id: req.params.id });
});

router.post('/sos', validate(sosSchema), (req, res) => {
  const ride = findRide(req.body.rideId);
  if (!ride || ride.riderId !== req.user.id) {
    return fail(res, 404, 'Ride not found', 'RIDE_NOT_FOUND');
  }

  const sos = {
    id: id(),
    userId: req.user.id,
    rideId: ride.id,
    source: 'rider',
    latitude: req.body.latitude ?? null,
    longitude: req.body.longitude ?? null,
    note: req.body.note || null,
    status: 'open',
    createdAt: timestamp(),
  };
  db.sosEvents.push(sos);
  emitRideEvent(ride, 'sos', { sosEventId: sos.id, source: 'rider' });
  return ok(res, 'SOS alert created', { sos }, 201);
});

export default router;
