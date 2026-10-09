import { db, id, timestamp, persistToDatabase } from '../database/store.js';
import { executePayout } from './payouts.js';
import { emitRideEvent } from './realtime.js';

const MAX_ATTEMPTS = 5;
let timer; 
export const enqueueJob = (type, payload, options = {}) => {
  const existing = options.dedupeKey && db.jobs.find((job) => 
    job.dedupeKey === options.dedupeKey && 
    ['queued', 'running', 'succeeded'].includes(job.status)
  );

  if (existing) {
    return existing;
  }

  const job = {
    id: id(),
    type,
    payload,
    dedupeKey: options.dedupeKey || null,
    status: 'queued',
    attempts: 0,
    maxAttempts: options.maxAttempts || MAX_ATTEMPTS,
    runAfter: options.runAfter || timestamp(),
    createdAt: timestamp(),
    updatedAt: timestamp(),
  };

  db.jobs.push(job);
  return job;
};

const runJob = async (job) => {
  job.status = 'running';
  job.attempts += 1;
  job.updatedAt = timestamp();

  try {
    if (job.type === 'payout.process') {
      await executePayout(job.payload.withdrawalId);
    } else if (job.type === 'email.send') {
      
    } else if (job.type === 'notification.dispatch') {
      
    } else {
      throw new Error(`Unknown job type: ${job.type}`);
    }

    job.status = 'succeeded';
    job.completedAt = timestamp();
  } catch (error) {
    job.status = job.attempts >= job.maxAttempts ? 'dead_letter' : 'queued';
    job.lastError = error.message;
    job.runAfter = new Date(Date.now() + Math.min(60 * 60 * 1000, 2 ** job.attempts * 1000)).toISOString();
    job.updatedAt = timestamp();
  }
};

export const processJobs = async () => {
  const before = db.jobs.length;

  for (const withdrawal of db.withdrawals.filter((item) => item.status === 'approved')) {
    enqueueJob(
      'payout.process', 
      { withdrawalId: withdrawal.id }, 
      { dedupeKey: `payout:${withdrawal.id}` }
    );
  }

  const now = Date.now();

  const configuredTimeout = Number(process.env.RIDE_REQUEST_TIMEOUT_MINUTES || 5);
  const timeoutMinutes = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : 5;
  let expiredRideCount = 0;

  for (const ride of db.rides) {
    if (ride.status !== 'requested' || ride.driverId != null) continue;
    const requestedAtMs = new Date(ride.requestedAt).getTime();
    if (!Number.isFinite(requestedAtMs) || now - requestedAtMs < timeoutMinutes * 60 * 1000) continue;

    ride.status = 'cancelled';
    ride.cancelledBy = 'system';
    ride.cancelReason = 'no_drivers_available';
    ride.cancelledAt = timestamp();
    ride.updatedAt = ride.cancelledAt;
    emitRideEvent(ride, 'cancelled', {
      cancelledBy: 'system',
      reason: 'no_drivers_available',
    });
    expiredRideCount += 1;
  }

  const due = db.jobs
    .filter((job) => ['queued', 'retry'].includes(job.status) && new Date(job.runAfter).getTime() <= now)
    .slice(0, 20);

  for (const job of due) {
    await runJob(job);
  }

  if (due.length || db.jobs.length !== before || expiredRideCount > 0) {
    await persistToDatabase();
  }

  return due.length;
};

export const startWorker = (intervalMs = 5000) => {
  if (timer) return timer;

  timer = setInterval(
    () => processJobs().catch((error) => console.error('Job worker failed:', error.message)), 
    intervalMs
  );
  
  timer.unref();
  return timer;
};

export const stopWorker = () => {
  if (timer) clearInterval(timer);
  timer = undefined;
};