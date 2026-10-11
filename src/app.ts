import 'express-async-errors';
import express, { Application, Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';

import { env } from './config/env';
import { morganStream } from './lib/logger';
import { globalErrorHandler } from './middleware/error.middleware';

// Route modules
import authRoutes from './modules/auth/auth.routes';
import usersRoutes from './modules/users/users.routes';
import providersRoutes from './modules/providers/providers.routes';
import servicesRoutes from './modules/services/services.routes';
import ordersRoutes from './modules/orders/orders.routes';
import paymentsRoutes from './modules/payments/payments.routes';
import emergencyRoutes from './modules/emergency/emergency.routes';
import adminRoutes from './modules/admin/admin.routes';
import addressesRoutes from './modules/addresses/addresses.routes';
import favouritesRoutes from './modules/favourites/favourites.routes';
import devicesRoutes from './modules/devices/devices.routes';
import uploadsRoutes from './modules/uploads/uploads.routes';
import deliveriesRoutes from './modules/deliveries/deliveries.routes';
import reviewsRoutes from './modules/reviews/reviews.routes';
import path from 'path';

export function createApp(): Application {
  const app = express();

  // ── Security headers ─────────────────────────────────────
  app.use(helmet({
    contentSecurityPolicy: env.NODE_ENV === 'production',
    crossOriginEmbedderPolicy: env.NODE_ENV === 'production',
  }));

  // ── CORS ─────────────────────────────────────────────────
  const allowedOrigins = env.CORS_ORIGINS.split(',').map((o) => o.trim());
  app.use(cors({
    origin: (origin, cb) => {
      // Allow requests with no origin (mobile apps, curl, etc.)
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-request-id'],
  }));

  // ── Compression ───────────────────────────────────────────
  app.use(compression());

  // ── Trust proxy (for accurate IP behind load balancer) ───
  app.set('trust proxy', 1);

  // ── Global rate limit ─────────────────────────────────────
  app.use(
    rateLimit({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.RATE_LIMIT_MAX_REQUESTS,
      standardHeaders: true,
      legacyHeaders: false,
      message: { success: false, message: 'Too many requests, please slow down.' },
    }),
  );

  // ── HTTP logging ─────────────────────────────────────────
  app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev', { stream: morganStream }));

  // ── Cookie parser ─────────────────────────────────────────
  app.use(cookieParser());

  // ── Body parsing
  // NOTE: payments webhook route uses express.raw() internally — registered first
  app.use(`/api/${env.API_VERSION}/payments`, paymentsRoutes);

  // JSON body parser for all other routes
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // ── Swagger / OpenAPI docs ────────────────────────────────
  const swaggerSpec = swaggerJsdoc({
    definition: {
      openapi: '3.0.0',
      info: {
        title: env.APP_NAME,
        version: '1.0.0',
        description: 'Kuwana — Marketplace, ordering & emergency services API',
      },
      servers: [{ url: `/api/${env.API_VERSION}` }],
      components: {
        securitySchemes: {
          BearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
      security: [{ BearerAuth: [] }],
    },
    apis: ['./src/modules/**/*.routes.ts'],
  });
  app.use(`/api/${env.API_VERSION}/docs`, swaggerUi.serve, swaggerUi.setup(swaggerSpec));

  // ── Health check ─────────────────────────────────────────
  app.get(`/api/${env.API_VERSION}/health`, (_req: Request, res: Response) => {
    res.json({
      success: true,
      service: env.APP_NAME,
      version: '1.0.0',
      environment: env.NODE_ENV,
      timestamp: new Date().toISOString(),
    });
  });

  // ── API Routes ────────────────────────────────────────────
  const base = `/api/${env.API_VERSION}`;
  app.use(`${base}/auth`, authRoutes);
  app.use(`${base}/users`, usersRoutes);
  app.use(`${base}/providers`, providersRoutes);
  app.use(`${base}/services`, servicesRoutes);
  app.use(`${base}/orders`, ordersRoutes);
  // payments already mounted above (raw body first)
  app.use(`${base}/emergency`, emergencyRoutes);
  app.use(`${base}/admin`, adminRoutes);
  app.use(`${base}/addresses`, addressesRoutes);
  app.use(`${base}/favourites`, favouritesRoutes);
  app.use(`${base}/devices`, devicesRoutes);
  app.use(`${base}/uploads`, uploadsRoutes);
  app.use(`${base}/deliveries`, deliveriesRoutes);
  app.use(`${base}/reviews`, reviewsRoutes);

  // Locally stored uploads (STORAGE_DRIVER=local)
  if (env.STORAGE_DRIVER === 'local') {
    app.use('/uploads', express.static(path.resolve(env.UPLOAD_DIR), {
      maxAge: '30d',
      immutable: true,
      setHeaders: (res) => res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'),
    }));
  }

  // ── 404 handler ───────────────────────────────────────────
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ success: false, message: 'Route not found' });
  });

  // ── Global error handler ──────────────────────────────────
  app.use(globalErrorHandler);

  return app;
}
