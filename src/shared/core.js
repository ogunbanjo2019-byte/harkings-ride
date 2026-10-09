export const ROLES = Object.freeze({
  RIDER: 'rider',
  DRIVER: 'driver',
  ADMIN: 'admin',
});

export const RIDE_STATUS = Object.freeze({
  REQUESTED: 'requested',
  ACCEPTED: 'accepted',
  ARRIVED: 'arrived',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
});

export const DRIVER_STATUS = Object.freeze({
  PENDING: 'pending',
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
});

export const response = (res, status, message, data = null, error = null) => 
  res.status(status).json({ 
    success: status < 400, 
    message, 
    data, 
    error 
  });

export const ok = (res, message, data = null, status = 200) => 
  response(res, status, message, data);

export const fail = (res, status, message, code, details = null) => 
  response(res, status, message, null, { code, details });


export class AppError extends Error {
  constructor(status, message, code = 'APP_ERROR', details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const asyncHandler = (fn) => (req, res, next) => 
  Promise.resolve(fn(req, res, next)).catch(next);

export const paginate = (items, page = 1, limit = 20) => {
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(100, Math.max(1, Number(limit) || 20));
  const start = (p - 1) * l;
  
  return {
    items: items.slice(start, start + l),
    page: p,
    limit: l,
    total: items.length,
    pages: Math.ceil(items.length / l),
  };
};