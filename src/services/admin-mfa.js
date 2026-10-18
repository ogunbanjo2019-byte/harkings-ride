import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const encryptionKey = createHash('sha256').update(`switchride-admin-mfa:${env.jwtSecret}`).digest();

export const generateTotpSecret = () => {
  const bytes = randomBytes(20);
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  let encoded = '';
  for (let index = 0; index < bits.length; index += 5) {
    encoded += alphabet[parseInt(bits.slice(index, index + 5).padEnd(5, '0'), 2)];
  }
  return encoded;
};

const decodeBase32 = (secret) => {
  const normalized = String(secret || '').replace(/=+$/g, '').toUpperCase();
  let bits = '';
  for (const char of normalized) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error('Invalid TOTP secret');
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
};

export const encryptTotpSecret = (secret) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
};

export const decryptTotpSecret = (packed) => {
  const [ivText, tagText, dataText] = String(packed || '').split('.');
  if (!ivText || !tagText || !dataText) throw new Error('Invalid encrypted TOTP secret');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataText, 'base64url')), decipher.final()]).toString('utf8');
};

const totpAt = (secret, counter) => {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', decodeBase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, '0');
};

export const generateTotpCode = (secret, now = Date.now()) =>
  totpAt(secret, Math.floor(now / 30_000));

export const verifyTotp = (secret, suppliedCode, now = Date.now()) => {
  if (!/^\d{6}$/.test(String(suppliedCode || ''))) return false;
  const currentCounter = Math.floor(now / 30_000);
  const supplied = Buffer.from(String(suppliedCode));
  for (const delta of [-1, 0, 1]) {
    const expected = Buffer.from(totpAt(secret, currentCounter + delta));
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return true;
  }
  return false;
};

export const totpUri = (secret, email) => {
  const label = encodeURIComponent(`SwitchRide:${email || 'admin'}`);
  const issuer = encodeURIComponent('SwitchRide');
  return `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
};
