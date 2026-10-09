import app from './app.js';
import { env } from './config/env.js';
import { connectDatabase, closeDatabase, db, seed, persistToDatabase } from './database/store.js';
import { startWorker, stopWorker } from './services/jobs.js';

await connectDatabase();
await seed();
const cleanup = () => {
  const now = Date.now();
  let changed = false;
  for (const collection of [db.otpChallenges, db.passwordResetTokens]) {
    for (let index = collection.length - 1; index >= 0; index -= 1) {
      const item = collection[index];
      if (item.usedAt || new Date(item.expiresAt).getTime() < now - 24 * 60 * 60 * 1000) { collection.splice(index, 1); changed = true; }
    }
  }
  if (changed) persistToDatabase().catch((error) => console.error('Expired secret cleanup persistence failed:', error.message));
};
cleanup();
const cleanupTimer = setInterval(cleanup, 15 * 60 * 1000);
cleanupTimer.unref();
startWorker();
const server = app.listen(env.port, '0.0.0.0', () => console.log(`Ride platform backend listening on port ${env.port}`));
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(cleanupTimer);
  stopWorker();
  const forceExit = setTimeout(() => process.exit(1), 10000);
  forceExit.unref();
  await new Promise((resolve) => server.close(resolve));
  await closeDatabase();
  clearTimeout(forceExit);
  process.exit(0);
};
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
