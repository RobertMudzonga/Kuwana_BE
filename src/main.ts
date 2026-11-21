import { createApp } from './app';
import { env } from './config/env';
import { logger } from './lib/logger';
import prisma from './lib/prisma';
import { ensurePublicBucket } from './lib/storage';
import { startJobs, stopJobs } from './lib/jobs';
import './jobs';

async function bootstrap() {
  // ── Database connectivity check ───────────────────────────
  try {
    await prisma.$connect();
    logger.info('✅ Database connected');
  } catch (err) {
    logger.error('❌ Database connection failed', { err });
    process.exit(1);
  }

  // ── Object storage ─────────────────────────────────────────
  if (env.STORAGE_DRIVER === 'minio') {
    try {
      await ensurePublicBucket();
      logger.info(`✅ MinIO bucket "${env.MINIO_BUCKET_NAME}" ready`);
    } catch (err) {
      // Non-fatal — app can run without MinIO (file uploads will fail gracefully)
      logger.warn('⚠️  MinIO not available — file uploads disabled', { err });
    }
  } else {
    logger.info(`📁 Uploads stored locally in ./${env.UPLOAD_DIR}`);
  }

  // ── Background jobs (BullMQ; in-process fallback without Redis) ──
  await startJobs();

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
      await stopJobs();
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
