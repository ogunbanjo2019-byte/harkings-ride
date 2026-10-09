import { ZodError } from 'zod';
import { AppError, fail } from '../shared/core.js';

export const validate = (schema, source = 'body') => (req, res, next) => {
  const result = schema.safeParse(req[source]);

  if (!result.success) {
    return fail(
      res,
      400,
      'Validation failed',
      'VALIDATION_ERROR',
      result.error.flatten()
    );
  }

  req[source] = result.data;
  next();
};

export const notFound = (req, res) =>
  fail(
    res,
    404,
    `Route not found: ${req.method} ${req.originalUrl}`,
    'NOT_FOUND'
  );

export const errorHandler = (err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  if (err instanceof ZodError) {
    return fail(
      res,
      400,
      'Validation failed',
      'VALIDATION_ERROR',
      err.flatten()
    );
  }

  if (err instanceof AppError) {
    return fail(res, err.status, err.message, err.code, err.details);
  }

  console.error(err);
  return fail(
    res,
    500,
    'An unexpected server error occurred',
    'INTERNAL_ERROR'
  );
};