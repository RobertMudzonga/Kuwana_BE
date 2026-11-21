import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  // App
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3001),
  API_VERSION: z.string().default('v1'),
  APP_NAME: z.string().default('Kuwana API'),

  // Database
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // JWT
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

  // Bcrypt
  BCRYPT_SALT_ROUNDS: z.coerce.number().default(12),

  // CORS
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  // Rate limiting
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(900000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().default(1000),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().default(20),

  // Public base URL of this API (used for Paynow result callbacks and locally stored uploads)
  /// On Render this defaults to the service's own https URL (RENDER_EXTERNAL_URL)
  PUBLIC_API_URL: z.string().default(process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000'),
  // Where password-reset links point (a web page or the app's deep link scheme)
  APP_URL: z.string().default('kuwana://'),

  /// Demo/MVP deployments: allows the mock payment gateway and console SMS while NODE_ENV=production.
  /// Never set this on a deployment that takes real money.
  DEMO_MODE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),

  // Payments
  // mock = instant success, for local development only (refused in production unless DEMO_MODE=true)
  ACTIVE_PAYMENT_GATEWAY: z.enum(['stripe', 'paynow', 'mock']).default('mock'),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_CURRENCY: z.string().default('usd'),
  PAYNOW_INTEGRATION_ID: z.string().optional(),
  PAYNOW_INTEGRATION_KEY: z.string().optional(),
  /** Paynow processes ZiG through a separate integration */
  PAYNOW_ZWG_INTEGRATION_ID: z.string().optional(),
  PAYNOW_ZWG_INTEGRATION_KEY: z.string().optional(),
  PAYNOW_RESULT_URL: z.string().optional(),
  PAYNOW_RETURN_URL: z.string().optional(),
  /// Paynow test mode only allows the merchant's own email as authemail
  PAYNOW_MERCHANT_EMAIL: z.string().email().optional(),
  PENDING_PAYMENT_TIMEOUT_MINUTES: z.coerce.number().default(30),

  // File storage: local disk (served by this API) or MinIO/S3
  STORAGE_DRIVER: z.enum(['local', 'minio']).default('local'),
  UPLOAD_DIR: z.string().default('uploads'),
  /// Public URL prefix for MinIO objects, e.g. https://cdn.kuwana.co.zw/kuwana
  MINIO_PUBLIC_URL: z.string().optional(),

  // SMS (phone verification)
  SMS_PROVIDER: z.enum(['console', 'twilio', 'africastalking']).default('console'),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM: z.string().optional(),
  AT_USERNAME: z.string().optional(),
  AT_API_KEY: z.string().optional(),
  AT_SENDER_ID: z.string().optional(),

  // Email (password reset). Without SMTP_HOST, emails are written to the log.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default('Kuwana <no-reply@kuwana.co.zw>'),

  // Expo push (optional access token if "enhanced push security" is enabled on the Expo project)
  EXPO_ACCESS_TOKEN: z.string().optional(),

  // MinIO
  MINIO_ENDPOINT: z.string().default('localhost'),
  MINIO_PORT: z.coerce.number().default(9000),
  MINIO_USE_SSL: z.string().default('false'),
  MINIO_ACCESS_KEY: z.string().default('minioadmin'),
  MINIO_SECRET_KEY: z.string().default('minioadmin'),
  MINIO_BUCKET_NAME: z.string().default('sosa-connect'),
  /// Needed by some S3-compatible stores (Cloudflare R2: "auto")
  MINIO_REGION: z.string().optional(),

  // Logging
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Redis: either REDIS_URL (redis:// or rediss://, as hosting providers give it) or host/port/password
  REDIS_URL: z.string().optional(),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),

  // Error Tracking (Sentry)
  SENTRY_DSN: z.string().optional(),

  // Admin seed
  ADMIN_EMAIL: z.string().email().default('admin@sosaconnect.zw'),
  ADMIN_PASSWORD: z.string().min(8).default('Admin@Sosa2024!'),
});

const parsed = envSchema
  .refine((e) => !(e.NODE_ENV === 'production' && !e.DEMO_MODE && e.ACTIVE_PAYMENT_GATEWAY === 'mock'), {
    message: 'ACTIVE_PAYMENT_GATEWAY=mock is not allowed in production (unless DEMO_MODE=true)',
    path: ['ACTIVE_PAYMENT_GATEWAY'],
  })
  .refine((e) => !(e.NODE_ENV === 'production' && !e.DEMO_MODE && e.SMS_PROVIDER === 'console'), {
    message: 'Configure a real SMS_PROVIDER in production (or set DEMO_MODE=true)',
    path: ['SMS_PROVIDER'],
  })
  .safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:\n', parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;

/** Connection options shared by the cache and the job queue */
export const redisConnection: { host: string; port: number; username?: string; password?: string; tls?: object } = (() => {
  if (!env.REDIS_URL) return { host: env.REDIS_HOST, port: env.REDIS_PORT, password: env.REDIS_PASSWORD };
  const u = new URL(env.REDIS_URL);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : env.REDIS_PASSWORD,
    tls: u.protocol === 'rediss:' ? {} : undefined,
  };
})();
