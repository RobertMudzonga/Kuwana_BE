import { createApp } from './app';
import { env } from './config/env';
import { logger } from './lib/logger';
import prisma from './lib/prisma';
import * as Minio from 'minio';

async function bootstrap() {
  // ── Database connectivity check ───────────────────────────
  try {
    await prisma.$connect();
    logger.info('✅ Database connected');
  } catch (err) {
    logger.error('❌ Database connection failed', { err });
    process.exit(1);
  }

  // ── MinIO bucket initialisation ───────────────────────────
  try {
    const minioClient = new Minio.Client({
      endPoint: env.MINIO_ENDPOINT,
      port: env.MINIO_PORT,
      useSSL: env.MINIO_USE_SSL === 'true',
      accessKey: env.MINIO_ACCESS_KEY,
      secretKey: env.MINIO_SECRET_KEY,
    });

    const bucketExists = await minioClient.bucketExists(env.MINIO_BUCKET_NAME);
    if (!bucketExists) {
      await minioClient.makeBucket(env.MINIO_BUCKET_NAME, 'us-east-1');
      logger.info(`✅ MinIO bucket "${env.MINIO_BUCKET_NAME}" created`);
    } else {
      logger.info(`✅ MinIO bucket "${env.MINIO_BUCKET_NAME}" ready`);
    }
  } catch (err) {
    // Non-fatal — app can run without MinIO (file uploads will fail gracefully)
    logger.warn('⚠️  MinIO not available — file uploads disabled', { err });
  }

  // ── Start HTTP server ─────────────────────────────────────
  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`🚀 ${env.APP_NAME} running on port ${env.PORT} [${env.NODE_ENV}]`);
    logger.info(`📚 API Docs: http://localhost:${env.PORT}/api/${env.API_VERSION}/docs`);
    logger.info(`❤️  Health:   http://localhost:${env.PORT}/api/${env.API_VERSION}/health`);
  });

  // ── Graceful shutdown ─────────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info(`${signal} received — gracefully shutting down`);
    server.close(async () => {
      await prisma.$disconnect();
      logger.info('Database disconnected. Bye 👋');
      process.exit(0);
    });

    // Force shutdown after 10 seconds
    setTimeout(() => {
      logger.error('Force shutdown — timed out');
      process.exit(1);
    }, 10_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { reason });
  });

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { err });
    process.exit(1);
  });
}

bootstrap();
