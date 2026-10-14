import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import bcrypt from 'bcryptjs';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const projectRef = url ? new URL(url).hostname.split('.')[0] : '';

if (process.env.CONFIRM_PRODUCTION_ADMIN_PROVISIONING !== 'YES') {
  console.error('Confirmation is missing.');
  process.exit(1);
}
if (!url || !key || !projectRef) {
  console.error('Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in your private .env file.');
  process.exit(1);
}
if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 12) {
  console.error('Set a hidden ADMIN_PASSWORD of at least 12 characters before running.');
  process.exit(1);
}

const rl = readline.createInterface({ input: stdin, output: stdout });
const ask = (q) => rl.question(q);

try {
  console.log(`Supabase project reference: ${projectRef}`);
  if ((await ask('Type that reference to confirm: ')).trim() !== projectRef) {
    throw new Error('Project reference did not match; no account created.');
  }

  const name = (await ask('Admin name: ')).trim();
  const email = (await ask('Admin email: ')).trim().toLowerCase();
  const phone = (await ask('Admin phone: ')).trim();
  rl.close();

  if (name.length < 2 || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email) || phone.length < 7) {
    throw new Error('Check the name, email, and phone you entered.');
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: found, error: lookupError } = await supabase
    .from('app_records')
    .select('id')
    .eq('collection', 'users')
    .filter('data->>email', 'eq', email)
    .limit(1);

  if (lookupError) throw new Error(lookupError.message);
  if (found?.length) throw new Error('That email already exists; no account was created.');

  const now = new Date().toISOString();
  const user = {
    id: randomUUID(),
    name,
    email,
    phone,
    passwordHash: await bcrypt.hash(process.env.ADMIN_PASSWORD, 12),
    role: 'admin',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };

  const { error } = await supabase.from('app_records').insert({
    collection: 'users',
    id: user.id,
    data: user,
  });

  if (error) throw new Error(error.message);
  console.log(`Admin provisioned for ${email}. Restart Render, then sign in at /admin/.`);
} catch (error) {
  if (!rl.closed) rl.close();
  console.error(`Stopped: ${error.message}`);
  process.exitCode = 1;
} finally {
  process.env.ADMIN_PASSWORD = '';
}
