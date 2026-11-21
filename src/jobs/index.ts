import { defineJob, every } from '../lib/jobs';
import { logger } from '../lib/logger';
import { ordersService } from '../modules/orders/orders.service';
import { marketCheckoutService } from '../modules/market/checkout.service';
import { storeOrdersService } from '../modules/store/store-orders.service';
import { driverJobsService } from '../modules/drivers/driver-jobs.service';

/**
 * Every background job in one place. Import this module once at start-up, before startJobs().
 *
 * Escrow needs no job: store balances are derived from the ledger and delivery time (escrowHoldHours).
 */

export const JOBS = {
  expireUnpaidOrders: 'orders.expire-unpaid',
  expireOverdueMarketOrders: 'market.expire-overdue',
  /** One per store parcel: fires at its accept deadline */
  storeAcceptTimeout: 'store.accept-timeout',
  /** Catches any parcel whose timer was lost */
  storeAcceptSweep: 'store.accept-sweep',
  /** Push a ready parcel to nearby drivers; repeats with a wider radius until claimed */
  deliveryBroadcast: 'delivery.broadcast',
} as const;

defineJob(JOBS.expireUnpaidOrders, async () => {
  const n = await ordersService.expireUnpaidOrders();
  if (n) logger.info(`Expired ${n} unpaid order(s)`);
  return n;
});

defineJob(JOBS.expireOverdueMarketOrders, async () => {
  const n = await marketCheckoutService.expireOverdue();
  if (n) logger.info(`Expired ${n} unconfirmed marketplace order(s)`);
  return n;
});

defineJob<{ shipmentId: string }>(JOBS.storeAcceptTimeout, async ({ shipmentId }) => storeOrdersService.timeoutIfUnaccepted(shipmentId));

defineJob<{ jobId: string; round: number }>(JOBS.deliveryBroadcast, async ({ jobId, round }) => driverJobsService.broadcast(jobId, round));

defineJob(JOBS.storeAcceptSweep, async () => {
  const n = await storeOrdersService.sweepOverdue();
  if (n) logger.info(`Store SLA: ${n} unaccepted parcel(s) moved or refunded`);
  return n;
});

every(JOBS.expireUnpaidOrders, 60_000);
every(JOBS.storeAcceptSweep, 60_000);
every(JOBS.expireOverdueMarketOrders, 60_000);
