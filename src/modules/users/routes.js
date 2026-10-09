import { Router } from 'express';
import { z } from 'zod';
import { db, findUser, publicUser, timestamp } from '../../database/store.js';
import { fail, ok } from '../../shared/core.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/errors.js';

const router = Router();
router.use(requireAuth);

const updateProfileSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    email: z.string().email().optional(),
  })
  .refine((value) => value.name !== undefined || value.email !== undefined, {
    message: 'Provide a name or email to update',
  });

router.patch('/me', validate(updateProfileSchema), (req, res) => {
  const user = findUser({ id: req.user.id });
  if (!user) return fail(res, 404, 'User not found', 'USER_NOT_FOUND');

  const updates = {};
  if (req.body.name !== undefined) updates.name = req.body.name;
  if (req.body.email !== undefined) {
    const email = req.body.email.trim().toLowerCase();
    const alreadyUsed = db.users.some((candidate) => candidate.id !== user.id && candidate.email === email);
    if (alreadyUsed) {
      return fail(res, 409, 'That email address is already in use', 'EMAIL_ALREADY_EXISTS');
    }
    updates.email = email;
  }

  Object.assign(user, updates, { updatedAt: timestamp() });
  return ok(res, 'Profile updated', { user: publicUser(user) });
});

export default router;
