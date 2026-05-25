export const CONSTANTS = {
  // Pagination
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,

  // Geo
  DEFAULT_RADIUS_KM: 10,
  MAX_RADIUS_KM: 100,

  // Ratings
  MIN_RATING: 1,
  MAX_RATING: 5,

  // File uploads
  MAX_FILE_SIZE_BYTES: 5 * 1024 * 1024, // 5 MB
  ALLOWED_IMAGE_TYPES: ['image/jpeg', 'image/png', 'image/webp'],

  // ZiG conversion (approximate — update via config for production)
  ZIG_TO_USD_RATE: 0.0013, // 1 ZiG ≈ 0.0013 USD

  // Roles
  ROLES: {
    USER: 'USER',
    PROVIDER: 'PROVIDER',
    ADMIN: 'ADMIN',
  },

  // Stripe
  STRIPE_API_VERSION: '2024-06-20' as const,

  // Cookie names
  REFRESH_TOKEN_COOKIE: 'sosa_refresh_token',

  // Headers
  REQUEST_ID_HEADER: 'x-request-id',
} as const;
