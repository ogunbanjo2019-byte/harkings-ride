import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import bcrypt from 'bcryptjs';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL?.trim();
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const confirmation = process.env.CONFIRM_PRODUCTION_ADMIN_PROVISIONING;

if (confirmation !== 'YES') {
  console.error('Refusing to run. Set CONFIRM_PRODUCTION_ADMIN_PROVISIONING=YES only after confirming the target Supabase project.');
  process.exit(1);
}
if (!supabaseUrl || !serviceRoleKey) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in a private local .env file first.');
  process.exit(1);
}

let projectRef;
try {
  projectRef = new URL(supabaseUrl).hostname.split('.')[0];
} catch {
  console.error('SUPABASE_URL is not a valid URL.');
  process.exit(1);
}

const rl = readline.createInterface({ input: stdin, output: stdout });
const ask = (label) => rl.question(label);

async function askHidden(label) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    throw new Error('Run this command in an interactive terminal so the password can be entered without echo.');
  }

  stderr.write(label);
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stderr.write('\n');
    };
    const onData = (chunk) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003') {
          cleanup();
          reject(new Error('Cancelled.'));
          return;
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (char >= ' ' && char !== '\u007f') value += char;
      }
    };
    stdin.on('data', onData);
  });
}

let supabase;
try {
  console.log(`Target Supabase project reference: ${projectRef}`);
  const typedProjectRef = (await ask('Type that project reference to confirm: ')).trim();
  if (typedProjectRef !== projectRef) throw new Error('Project reference did not match; no account was created.');

  const name = (await ask('Admin full name: ')).trim();
  const email = (await ask('Admin email: ')).trim().toLowerCase();
  const phone = (await ask('Admin phone (international format recommended): ')).trim();
  rl.close();

  if (name.length < 2 || name.length > 120) throw new Error('Name must be between 2 and 120 characters.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
  if (phone.length < 7 || phone.length > 30) throw new Error('Phone must be between 7 and 30 characters.');

  const password = await askHidden('Choose an admin password (minimum 12 characters; input hidden): ');
  const confirmationPassword = await askHidden('Re-enter admin password (input hidden): ');
  if (password.length < 12) throw new Error('Password must contain at least 12 characters.');
  if (password !== confirmationPassword) throw new Error('Passwords did not match.');

  supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('app_records')
      .select('id,data')
      .eq('collection', 'users')
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(`Could not check existing users: ${error.message}`);

    const duplicate = (data || []).find((row) => String(row.data?.email || '').trim().toLowerCase() === email);
    if (duplicate) throw new Error('That email already exists in the users collection. No changes were made; do not create a duplicate admin.');
    if (!data || data.length < pageSize) break;
    offset += pageSize;
  }

  const timestamp = new Date().toISOString();
  const user = {
    id: randomUUID(),
    name,
    email,
    phone,
    passwordHash: await bcrypt.hash(password, 12),
    role: 'admin',
    status: 'active',
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  const { error } = await supabase.from('app_records').insert({
    collection: 'users',
    id: user.id,
    data: user,
  });
  if (error) throw new Error(`Admin insert failed: ${error.message}`);

  console.log(`Admin provisioned for ${email}. The password and service-role key were not printed.`);
  console.log('Next: restart the Render service, then sign in at https://harkings-ride-2.onrender.com/admin/.');
} catch (error) {
  if (!rl.closed) rl.close();
  console.error(`Admin provisioning stopped: ${error.message}`);
  process.exitCode = 1;
} finally {
  // Best-effort overwrite of JS references; strings cannot be guaranteed erased from memory.
  supabase = undefined;
}