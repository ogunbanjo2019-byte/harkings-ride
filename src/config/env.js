if (process.env.NODE_ENV !== 'test') await import('dotenv/config')
const isProduction = process.env.NODE_ENV === 'production';
const configuredJwtSecret = process.env.JWT_SECRET || '';
const requiredProduction = (name, value) => {
  if (isProduction && !value) {
    throw new Error(`${name} must be configured in production.`);
  }
  return value || '';
};

if (isProduction && configuredJwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be set to at least 32 characters in production.');
}

const corsOrigin = process.env.CORS_ORIGIN || (isProduction ? '' : '*');
if (isProduction && (corsOrigin === '*' || !/^https:\/\//.test(corsOrigin))) {
  throw new Error('CORS_ORIGIN must be an exact HTTPS origin in production.');
}

const appPublicUrl =
  process.env.APP_PUBLIC_URL || `http://localhost:${Number(process.env.PORT || 4000)}`;

if (isProduction && !/^https:\/\//.test(appPublicUrl)) {
  throw new Error('APP_PUBLIC_URL must be HTTPS in production.');
}

const emailProvider = process.env.EMAIL_PROVIDER || 'development';
if (isProduction && !['resend', 'smtp'].includes(emailProvider)) {
  throw new Error('EMAIL_PROVIDER must be resend or smtp in production.');
}

if (isProduction && emailProvider === 'resend') {
  requiredProduction('RESEND_API_KEY', process.env.RESEND_API_KEY);
}

if (isProduction && emailProvider === 'smtp') {
  ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD'].forEach((name) =>
    requiredProduction(name, process.env[name])
  );
}

const identityProvider = process.env.IDENTITY_PROVIDER || '';
const awsRegion = process.env.AWS_REGION || '';
const faceLivenessThreshold = Number(process.env.FACE_LIVENESS_THRESHOLD || 90);
const faceMatchSimilarityThreshold = Number(process.env.FACE_MATCH_SIMILARITY_THRESHOLD || 90);
const faceConsentVersion = process.env.FACE_CONSENT_VERSION || 'face-check-v1';

for (const [name, value] of [
  ['FACE_LIVENESS_THRESHOLD', faceLivenessThreshold],
  ['FACE_MATCH_SIMILARITY_THRESHOLD', faceMatchSimilarityThreshold],
]) {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${name} must be a number between 0 and 100.`);
  }
}

if (isProduction && identityProvider !== 'aws-rekognition') {
  throw new Error('IDENTITY_PROVIDER=aws-rekognition is required in production.');
}

if (identityProvider === 'aws-rekognition') {
  if (!awsRegion) {
    throw new Error('AWS_REGION must be configured when IDENTITY_PROVIDER=aws-rekognition.');
  }

  if (Boolean(process.env.AWS_ACCESS_KEY_ID) !== Boolean(process.env.AWS_SECRET_ACCESS_KEY)) {
    throw new Error('Configure both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.');
  }

  if (isProduction && !process.env.AWS_ACCESS_KEY_ID) {
    throw new Error(
      'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be configured in production.'
    );
  }
}

export const env = {
  isProduction,
  port: Number(process.env.PORT || 4000),
  jwtSecret: configuredJwtSecret || 'development-only-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  corsOrigin,
  dailyFee: Number(process.env.DAILY_DRIVER_SUBSCRIPTION_FEE || 1500),
  cngUnit: process.env.DEFAULT_CNG_UNIT || 'kg',
  databaseProvider:
    process.env.DATABASE_PROVIDER || (process.env.NODE_ENV === 'test' ? 'memory' : 'supabase'),
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  paystackSecretKey: process.env.PAYSTACK_SECRET_KEY || '',
  paystackCallbackUrl: process.env.PAYSTACK_CALLBACK_URL || '',
  smsProvider: process.env.SMS_PROVIDER || '',
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || '',
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || '',
  twilioFromNumber: process.env.TWILIO_FROM_NUMBER || '',
  emailProvider,
  emailFrom: process.env.EMAIL_FROM || 'no-reply@switchride.local',
  appPublicUrl,
  resendApiKey: process.env.RESEND_API_KEY || '',
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: Number(process.env.SMTP_PORT || 587),
  smtpUser: process.env.SMTP_USER || '',
  smtpPassword: process.env.SMTP_PASSWORD || '',
  smtpSecure: process.env.SMTP_SECURE === 'true',
  storageBucket: process.env.SENSITIVE_STORAGE_BUCKET || 'sensitive-documents',
  signedUrlTtlSeconds: Number(process.env.SIGNED_URL_TTL_SECONDS || 300),
  uploadMaxBytes: Number(process.env.UPLOAD_MAX_BYTES || 5 * 1024 * 1024),
  allowedUploadMimeTypes: (
    process.env.ALLOWED_UPLOAD_MIME_TYPES || 'image/jpeg,image/png,application/pdf'
  )
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),
  otpRateLimit: Number(process.env.OTP_RATE_LIMIT || 5),
  resetRateLimit: Number(process.env.RESET_RATE_LIMIT || 5),
  identityProvider,
  identityProviderApiKey: process.env.IDENTITY_PROVIDER_API_KEY || '',
  awsRegion,
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  awsSessionToken: process.env.AWS_SESSION_TOKEN || '',
  faceLivenessThreshold,
  faceMatchSimilarityThreshold,
  faceConsentVersion,
  payoutProvider: process.env.PAYOUT_PROVIDER || 'paystack',
  logLevel: process.env.LOG_LEVEL || 'info',
};

if (isProduction) {
  requiredProduction('SUPABASE_URL', env.supabaseUrl);
  requiredProduction('SUPABASE_SERVICE_ROLE_KEY', env.supabaseServiceRoleKey);
  requiredProduction('SENSITIVE_STORAGE_BUCKET', env.storageBucket);
}
