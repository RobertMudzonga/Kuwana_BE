import { Queue, Worker, JobsOptions } from 'bullmq';
import Redis from 'ioredis';
import { env } from '../config/env';
import { logger } from './logger';

/**
 * Background jobs on BullMQ (Redis).
 *
 * - `defineJob(name, handler)` registers a handler.
 * - `enqueue(name, data, { delayMs, jobId })` runs it later; a `jobId` makes the enqueue idempotent
 *   (e.g. one SLA timer per shipment) and lets it be cancelled with `cancel(jobId)`.
 * - `every(name, ms)` runs it on a fixed interval (one run cluster-wide per tick).
 *
 * If Redis is unreachable at start-up, jobs fall back to in-process timers so local development
 * keeps working; delayed jobs are then lost on restart, which is logged loudly.
 * Under NODE_ENV=test nothing runs: enqueued jobs are recorded in `testQueue` for assertions.
 */

type Handler<T = unknown> = (data: T) => Promise<unknown>;

const QUEUE_NAME = 'kuwana';
const handlers = new Map<string, Handler>();
const repeating = new Map<string, number>();

let queue: Queue | null = null;
let worker: Worker | null = null;
let mode: 'idle' | 'bullmq' | 'local' | 'test' = env.NODE_ENV === 'test' ? 'test' : 'idle';
const localTimers = new Map<string, NodeJS.Timeout>();

/** Jobs enqueued while NODE_ENV=test */
export const testQueue: { name: string; data: unknown; delayMs?: number; jobId?: string }[] = [];

const connection = () => ({
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  password: env.REDIS_PASSWORD,
  maxRetriesPerRequest: null,
});

export function defineJob<T>(name: string, handler: Handler<T>) {
  handlers.set(name, handler as Handler);
}

async function runLocal(name: string, data: unknown) {
  const h = handlers.get(name);
  if (!h) return logger.error('No handler for job', { name });
  try {
    await h(data);
  } catch (err) {
    logger.error('Job failed', { name, err });
  }
}

export async function enqueue<T>(name: string, data: T, opts: { delayMs?: number; jobId?: string } = {}) {
  if (!handlers.has(name)) throw new Error(`Unknown job "${name}"`);
  if (mode === 'test') {
    testQueue.push({ name, data, ...opts });
    return;
  }
  if (mode === 'bullmq' && queue) {
    const jobOpts: JobsOptions = {
      delay: opts.delayMs,
      jobId: opts.jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    };
    await queue.add(name, data, jobOpts);
    return;
  }
  // Local fallback (or not started yet)
  const key = opts.jobId ?? `${name}:${Date.now()}:${Math.random()}`;
  if (opts.jobId && localTimers.has(key)) return;
  const t = setTimeout(() => {
    localTimers.delete(key);
    void runLocal(name, data);
  }, opts.delayMs ?? 0);
  t.unref();
  localTimers.set(key, t);
}

/** Cancel a delayed job by its id (no-op if it already ran) */
export async function cancel(jobId: string) {
  if (mode === 'test') {
    const i = testQueue.findIndex((j) => j.jobId === jobId);
    if (i >= 0) testQueue.splice(i, 1);
    return;
  }
  if (mode === 'bullmq' && queue) {
    const job = await queue.getJob(jobId);
    if (job && (await job.isDelayed())) await job.remove();
    return;
  }
  const t = localTimers.get(jobId);
  if (t) {
    clearTimeout(t);
    localTimers.delete(jobId);
  }
}

/** Run `name` every `ms` milliseconds */
export function every(name: string, ms: number) {
  repeating.set(name, ms);
}

async function redisReachable(): Promise<boolean> {
  const probe = new Redis({ ...connection(), lazyConnect: true, connectTimeout: 2_000, maxRetriesPerRequest: 0, retryStrategy: () => null });
  probe.on('error', () => undefined);
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

export async function startJobs() {
  if (mode === 'test' || mode === 'bullmq' || mode === 'local') return mode;

  if (await redisReachable()) {
    queue = new Queue(QUEUE_NAME, { connection: connection() });
    worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        const h = handlers.get(job.name);
        if (!h) throw new Error(`No handler for job "${job.name}"`);
        return h(job.data);
      },
      { connection: connection(), concurrency: 5 },
    );
    worker.on('failed', (job, err) => logger.error('Job failed', { name: job?.name, id: job?.id, attempts: job?.attemptsMade, err: err.message }));
    worker.on('error', (err) => logger.error('Job worker error', { err: err.message }));

    // Replace any repeat schedules left from a previous deploy
    for (const r of await queue.getRepeatableJobs()) await queue.removeRepeatableByKey(r.key);
    for (const [name, ms] of repeating) {
      await queue.add(name, {}, { repeat: { every: ms }, jobId: `repeat:${name}`, removeOnComplete: 100, removeOnFail: 500 });
    }
    mode = 'bullmq';
    logger.info(`✅ Background jobs on BullMQ (${handlers.size} job types, ${repeating.size} repeating)`);
  } else {
    for (const [name, ms] of repeating) {
      const t = setInterval(() => void runLocal(name, {}), ms);
      t.unref();
      localTimers.set(`repeat:${name}`, t);
    }
    mode = 'local';
    logger.warn('⚠️  Redis unreachable — background jobs run in-process; delayed jobs will not survive a restart');
  }
  return mode;
}

export async function stopJobs() {
  for (const t of localTimers.values()) clearTimeout(t);
  localTimers.clear();
  await worker?.close();
  await queue?.close();
  worker = null;
  queue = null;
  if (mode !== 'test') mode = 'idle';
}

/** Run a registered job's handler immediately (tests, admin "run now") */
export async function runJobNow<T>(name: string, data: T) {
  const h = handlers.get(name);
  if (!h) throw new Error(`Unknown job "${name}"`);
  return h(data);
}
