import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';
import { DRIVER_STATUS, ROLES, RIDE_STATUS } from '../shared/core.js';

const collectionNames = [
  'users',
  'riders',
  'drivers',
  'vehicles',
  'documents',
  'rides',
  'rideLocations',
  'payments',
  'subscriptions',
  'ratings',
  'notifications',
  'complaints',
  'cngTransactions',
  'wallets',
  'walletTransactions',
  'withdrawals',
  'supportTickets',
  'auditLogs',
  'sosEvents',
  'otpChallenges',
  'passwordResetTokens',
  'emailMessages',
  'identityChecks',
  'jobs',
  'safetyContacts',
  'pricingConfigs',
  'savedPlaces',
  'savedCards',
  'promotions',
  'shareTokens',
  'sseTokens'
];

export const db = Object.fromEntries(collectionNames.map((name) => [name, []]));
export const id = () => randomUUID();
export const timestamp = () => new Date().toISOString();

let client;
let connected = false;
let persistenceQueue = Promise.resolve();

const useMemory = () => env.databaseProvider === 'memory' || process.env.NODE_ENV === 'test';

const requireSupabase = () => {
  if (!env.supabaseUrl || !env.supabaseServiceRoleKey) {
    throw new Error(
      'Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or use DATABASE_PROVIDER=memory for tests.'
    );
  }
  return createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
};

export const connectDatabase = async () => {
  if (connected) return client;
  if (useMemory()) {
    connected = true;
    client = null;
    return client;
  }

  client = requireSupabase();
  const { error } = await client.from('app_records').select('id').limit(1);
  console.log("Connecting to Supabase URL:", process.env.SUPABASE_URL || env.supabaseUrl);

  if (error) throw new Error(`Supabase connection failed: ${error.message}`);
  connected = true;
  await loadFromSupabase();
  return client;
};

export const closeDatabase = async () => {
  await persistenceQueue;
  client = undefined;
  connected = false;
};

export const loadFromSupabase = async () => {
  if (useMemory()) return;
  const { data, error } = await client.from('app_records').select('collection,id,data');
  if (error) throw new Error(`Supabase load failed: ${error.message}`);

  collectionNames.forEach((name) => {
    db[name].length = 0;
  });

  for (const row of data || []) {
    if (db[row.collection]) db[row.collection].push(row.data);
  }
};
export const persistToSupabase = async () => {
  if (useMemory()) return;
  if (!client) throw new Error('Supabase is not connected');

  persistenceQueue = persistenceQueue.catch(() => {}).then(async () => {
    const rows = collectionNames.flatMap((name) =>
      db[name].map((data) => ({ collection: name, id: data.id, data }))
    );
    const { error } = await client.rpc('replace_app_records_snapshot', { p_rows: rows });
    if (error) throw new Error(`Supabase atomic snapshot save failed: ${error.message}`);
  });

  return persistenceQueue;
};

export const persistToDatabase = persistToSupabase;

export const seed = async () => {
  if (process.env.NODE_ENV !== 'development' || process.env.ALLOW_DEMO_ADMIN_SEED !== 'true') return;
  if (!connected) await connectDatabase();
  if (process.env.NODE_ENV === 'production') return;
  if (db.users.length) return;

  const passwordHash = await bcrypt.hash('Password123!', 10);
  db.users.push({
    id: id(),
    name: 'System Admin',
    email: 'admin@example.com',
    phone: '+2340000000000',
    passwordHash,
    role: ROLES.ADMIN,
    status: 'active',
    createdAt: timestamp(),
    updatedAt: timestamp(),
  });
  await persistToDatabase();
};

export const findUser = ({ id: userId, email, phone } = {}) =>
  db.users.find(
    (u) =>
      (userId && u.id === userId) ||
      (email && u.email === email) ||
      (phone && u.phone === phone)
  );

export const publicUser = ({ passwordHash, ...user }) => user;

export const createUser = ({ name, email, phone, passwordHash, role = ROLES.RIDER }) => {
  const user = {
    id: id(),
    name,
    email,
    phone,
    passwordHash,
    role,
    status: role === ROLES.DRIVER ? 'pending' : 'active',
    ninVerified: role === ROLES.RIDER ? false : undefined,
    createdAt: timestamp(),
    updatedAt: timestamp(),
  };
  db.users.push(user);
  return user;
};

export const createDriver = (userId, input = {}) => {
  const driver = {
    id: id(),
    userId,
    verificationStatus: 'pending',
    onlineStatus: false,
    status: DRIVER_STATUS.PENDING,
    currentLocation: null,
    ...input,
    createdAt: timestamp(),
    updatedAt: timestamp(),
  };
  db.drivers.push(driver);
  return driver;
};

export const createRider = (userId, input = {}) => {
  const rider = {
    id: id(),
    userId,
    ...input,
    createdAt: timestamp(),
    updatedAt: timestamp(),
  };
  db.riders.push(rider);
  return rider;
};

export const findDriverByUser = (userId) => db.drivers.find((d) => d.userId === userId);

export const findRide = (rideId) => db.rides.find((r) => r.id === rideId);

export const creditWallet = (driverId, amount, reference) => {
  let wallet = db.wallets.find((item) => item.driverId === driverId);
  if (!wallet) {
    wallet = {
      id: id(),
      driverId,
      balance: 0,
      bankAccount: null,
      createdAt: timestamp(),
      updatedAt: timestamp(),
    };
    db.wallets.push(wallet);
  }
  wallet.balance += Number(amount);
  wallet.updatedAt = timestamp();

  db.walletTransactions.push({
    id: id(),
    driverId,
    type: 'ride_earning',
    amount: Number(amount),
    balanceAfter: wallet.balance,
    reference,
    createdAt: timestamp(),
  });
  return wallet;
};

export const eligibleDrivers = () =>
  db.drivers.filter(
    (d) =>
      d.onlineStatus &&
      d.status === DRIVER_STATUS.ACTIVE &&
      d.verificationStatus === 'approved' &&
      db.subscriptions.some(
        (s) =>
          s.driverId === d.id &&
          s.status === 'active' &&
          new Date(s.expiresAt) > new Date()
      )
  );

export const transitionAllowed = {
  [RIDE_STATUS.REQUESTED]: [RIDE_STATUS.ACCEPTED, RIDE_STATUS.CANCELLED],
  [RIDE_STATUS.ACCEPTED]: [RIDE_STATUS.ARRIVED, RIDE_STATUS.CANCELLED],
  [RIDE_STATUS.ARRIVED]: [RIDE_STATUS.IN_PROGRESS, RIDE_STATUS.CANCELLED],
  [RIDE_STATUS.IN_PROGRESS]: [RIDE_STATUS.COMPLETED, RIDE_STATUS.CANCELLED],
  [RIDE_STATUS.COMPLETED]: [],
  [RIDE_STATUS.CANCELLED]: [],
};

export const isDatabaseConnected = () => connected;
export const databaseProvider = () => (useMemory() ? 'memory' : 'supabase');

export { collectionNames };
export const loadFromMongo = loadFromSupabase;
export const persistToMongo = persistToSupabase;

export const creditRiderWallet = (riderId, amount, reference, type = 'wallet_topup') => {
  const value = Number(amount);
  db.walletTransactions.push({
    id: id(),
    riderId,
    type,
    amount: value,
    reference,
    createdAt: timestamp(),
  });
  return db.walletTransactions.at(-1);
};

