import Redis from 'ioredis';
import { env } from '../config/env';
import { logger } from './logger';

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis({
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      password: env.REDIS_PASSWORD,
      retryStrategy: (times) => Math.min(times * 50, 2000),
      enableReadyCheck: false,
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });

    redis.on('error', (err) => {
      logger.error('Redis connection error', { err });
    });

    redis.on('connect', () => {
      logger.info('Redis connected');
    });

    redis.connect().catch((err) => {
      logger.warn('Redis connection failed — caching disabled', { err });
      // Don't throw — app should work without cache
    });
  }
  return redis;
}

export const cache = getRedis();

/**
 * Get value from cache or fetch from source if not cached
 * @param key Cache key
 * @param ttlSeconds Time to live in seconds
 * @param fn Function to fetch data if not cached
 */
export async function getOrSet<T>(
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    const cached = await cache.get(key);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (err) {
    logger.warn('Cache get failed', { key, err });
    // Fall through to fetch from source
  }

  const value = await fn();

  try {
    await cache.setex(key, ttlSeconds, JSON.stringify(value));
  } catch (err) {
    logger.warn('Cache set failed', { key, err });
    // Don't fail if cache write fails — still return value
  }

  return value;
}

/**
 * Invalidate cache keys matching pattern
 * @param pattern Redis pattern (e.g. 'providers:*')
 */
export async function invalidate(pattern: string): Promise<number> {
  try {
    const keys = await cache.keys(pattern);
    if (keys.length === 0) return 0;

    await cache.del(...keys);
    logger.debug('Cache invalidated', { pattern, count: keys.length });
    return keys.length;
  } catch (err) {
    logger.warn('Cache invalidation failed', { pattern, err });
    return 0;
  }
}

/**
 * Delete single cache key
 */
export async function delete_(key: string): Promise<boolean> {
  try {
    const result = await cache.del(key);
    return result > 0;
  } catch (err) {
    logger.warn('Cache delete failed', { key, err });
    return false;
  }
}

/**
 * Clear all cache
 */
export async function clear(): Promise<void> {
  try {
    await cache.flushdb();
    logger.info('Cache cleared');
  } catch (err) {
    logger.warn('Cache clear failed', { err });
  }
}

export default cache;
