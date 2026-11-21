import { Router, Request, Response, NextFunction } from 'express';
import prisma from '../../lib/prisma';
import { authenticate } from '../../middleware/auth.middleware';
import { requireAdmin, requireRoles } from '../../middleware/rbac.middleware';
import { validate } from '../../middleware/validate.middleware';
import { auditLog } from '../../middleware/audit.middleware';
import { successResponse, createdResponse } from '../../lib/response';
import { sellersService } from '../sellers/sellers.service';
import { currencyService, money } from '../currency/currency.service';
import { balancesDto, statement, statementCsv } from './earnings.service';
import { payoutsService } from './payouts.service';
import { inboundService } from './inbound.service';
import { fulfilmentService } from './fulfilment.service';
import { productRequestsService } from '../catalog/requests.service';
import { branchesService } from '../branches/branches.service';
import { createBranchSchema, updateBranchSchema } from '../branches/branches.schema';
import { createProductRequestSchema } from '../catalog/catalog.schema';
import {
  createInboundSchema, updateInboundSchema, receiveInboundSchema, hubInboundQuerySchema, shipmentsQuerySchema,
  dispatchSchema, deliverSchema, requestPayoutSchema, statementQuerySchema, payoutListQuerySchema, markPaidSchema, rejectPayoutSchema,
} from './merchant.schema';

/**
 * Marketplace seller portal (/merchant/*), plus the hub and finance endpoints that complete
 * its workflows (/merchant/hub/*, /merchant/admin/*). Seller routes act on the caller's own
 * seller profile; access comes from owning that profile, not from the user's role.
 */
const router = Router();
router.use(authenticate);

declare global {
  namespace Express {
    interface Request {
      sellerId?: string;
    }
  }
}

const asSeller = async (req: Request, _res: Response, next: NextFunction) => {
  req.sellerId = (await sellersService.requireOwnProfile(req.user!.sub)).id;
  next();
};

// ── Hub (warehouse staff) ─────────────────────────────────

const hub = Router();
hub.use(requireRoles('WAREHOUSE', 'ADMIN'));
hub.get('/inbound', validate(hubInboundQuerySchema, 'query'), async (req: Request, res: Response) => {
  const q = req.query as { hubId?: string; status?: never };
  // Warehouse staff only see their own hub's deliveries
  const me = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.sub }, select: { role: true, hubId: true } });
  const hubId = me.role === 'WAREHOUSE' ? me.hubId ?? undefined : q.hubId;
  successResponse(res, await inboundService.listForHub({ hubId, status: q.status }), 'Inbound shipments');
});
hub.get('/inbound/:id', async (req: Request, res: Response) => {
  successResponse(res, await inboundService.getForHub(req.params.id));
});
hub.post(
  '/inbound/:id/receive',
  validate(receiveInboundSchema),
  auditLog({ action: 'INBOUND_RECEIVED', targetType: 'InboundShipment', targetIdParam: 'id' }),
  async (req: Request, res: Response) => {
    successResponse(res, await inboundService.receive(req.user!.sub, req.params.id, req.body), 'Stock received');
  },
);
router.use('/hub', hub);

// ── Finance (admin) ───────────────────────────────────────

const admin = Router();
admin.use(requireAdmin);
admin.get('/payouts', validate(payoutListQuerySchema, 'query'), async (req: Request, res: Response) => {
  successResponse(res, await payoutsService.listAll((req.query as { status?: never }).status), 'Payouts');
});
admin.post('/payouts/:id/approve', auditLog({ action: 'PAYOUT_UPDATED', targetType: 'Payout', targetIdParam: 'id' }), async (req: Request, res: Response) => {
  successResponse(res, await payoutsService.approve(req.params.id, req.user!.sub), 'Payout approved');
});
admin.post('/payouts/:id/paid', validate(markPaidSchema), auditLog({ action: 'PAYOUT_UPDATED', targetType: 'Payout', targetIdParam: 'id' }), async (req: Request, res: Response) => {
  successResponse(res, await payoutsService.markPaid(req.params.id, req.user!.sub, req.body.externalRef), 'Payout marked paid');
});
admin.post('/payouts/:id/reject', validate(rejectPayoutSchema), auditLog({ action: 'PAYOUT_UPDATED', targetType: 'Payout', targetIdParam: 'id' }), async (req: Request, res: Response) => {
  successResponse(res, await payoutsService.reject(req.params.id, req.user!.sub, req.body.note), 'Payout rejected');
});
router.use('/admin', admin);

// ── Seller portal ─────────────────────────────────────────

const seller = Router();
seller.use(asSeller);

/**
 * @openapi
 * /merchant/dashboard:
 *   get:
 *     tags: [Seller portal]
 *     summary: Balances, parcels to dispatch, stock alerts and recent sales for the signed-in seller
 */
seller.get('/dashboard', async (req: Request, res: Response) => {
  const sellerId = req.sellerId!;
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [profile, balances, toDispatch, overdue, inTransit, inboundOpen, offers, sales, rate, requestsPending, requestsReady] = await Promise.all([
    prisma.sellerProfile.findUniqueOrThrow({ where: { id: sellerId }, select: { businessName: true, kycStatus: true, kycTier: true, plan: true, slaScore: true, disputeRate: true, ratingAvg: true, ratingCount: true, isFirstParty: true } }),
    balancesDto(sellerId),
    prisma.shipment.count({ where: { sellerId, sourceType: 'SELLER_FULFILLED', storeBranchId: null, status: { in: ['PROCESSING', 'PACKED'] }, order: { confirmedAt: { not: null } } } }),
    prisma.shipment.count({ where: { sellerId, sourceType: 'SELLER_FULFILLED', storeBranchId: null, status: { in: ['PROCESSING', 'PACKED'] }, dispatchBy: { lt: new Date() }, order: { confirmedAt: { not: null } } } }),
    prisma.shipment.count({ where: { sellerId, sourceType: 'SELLER_FULFILLED', storeBranchId: null, status: { in: ['DISPATCHED', 'OUT_FOR_DELIVERY', 'READY_FOR_COLLECTION'] } } }),
    prisma.inboundShipment.count({ where: { sellerId, status: { in: ['DRAFT', 'SUBMITTED'] } } }),
    prisma.offer.findMany({ where: { sellerId, isActive: true }, select: { stockQty: true, isBuyBoxWinner: true } }),
    prisma.marketOrderItem.aggregate({
      where: { sellerId, createdAt: { gte: since }, order: { confirmedAt: { not: null }, status: { not: 'CANCELLED' } } },
      _sum: { quantity: true, lineTotalUsd: true },
      _count: { orderId: true },
    }),
    currencyService.getUsdToZwg(),
    prisma.productRequest.count({ where: { sellerId, status: 'PENDING' } }),
    // Approved requests whose product is live but the seller hasn't listed an offer on yet
    prisma.productRequest.count({
      where: { sellerId, status: { in: ['APPROVED', 'DUPLICATE'] }, product: { status: 'ACTIVE', offers: { none: { sellerId } } } },
    }),
  ]);
  successResponse(res, {
    seller: { ...profile, slaScore: profile.slaScore.toNumber(), disputeRate: profile.disputeRate.toNumber() },
    balances,
    tasks: { toDispatch, overdue, inTransit, inboundOpen },
    offers: {
      active: offers.length,
      outOfStock: offers.filter((o) => o.stockQty === 0).length,
      lowStock: offers.filter((o) => o.stockQty > 0 && o.stockQty <= 5).length,
      buyBoxWins: offers.filter((o) => o.isBuyBoxWinner).length,
    },
    requests: { pending: requestsPending, readyToList: requestsReady },
    last30Days: { orderLines: sales._count.orderId, units: sales._sum.quantity ?? 0, sales: money(sales._sum.lineTotalUsd ?? 0, rate) },
  });
});

seller.get('/balances', async (req: Request, res: Response) => {
  successResponse(res, await balancesDto(req.sellerId!), 'Balances');
});

seller.get('/sales', async (req: Request, res: Response) => {
  successResponse(res, await fulfilmentService.sales(req.sellerId!), 'Sales');
});

// Statement (JSON, or CSV for accountants)
function period(q: { from?: Date; to?: Date }) {
  const to = q.to ?? new Date(Date.now() + 1000);
  const from = q.from ?? new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { from, to };
}
seller.get('/statement', validate(statementQuerySchema, 'query'), async (req: Request, res: Response) => {
  const { from, to } = period(req.query as { from?: Date; to?: Date });
  successResponse(res, await statement(req.sellerId!, from, to), 'Statement');
});
seller.get('/statement.csv', validate(statementQuerySchema, 'query'), async (req: Request, res: Response) => {
  const { from, to } = period(req.query as { from?: Date; to?: Date });
  const csv = statementCsv(await statement(req.sellerId!, from, to));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="kuwana-statement-${from.toISOString().slice(0, 10)}-to-${to.toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

// Payouts
seller.get('/payouts', async (req: Request, res: Response) => {
  successResponse(res, await payoutsService.listForSeller(req.sellerId!), 'Payouts');
});
seller.post('/payouts', validate(requestPayoutSchema), auditLog({ action: 'PAYOUT_REQUESTED', targetType: 'Payout' }), async (req: Request, res: Response) => {
  createdResponse(res, await payoutsService.request(req.sellerId!, req.body), 'Payout requested');
});

// Seller-fulfilled parcels
seller.get('/shipments', validate(shipmentsQuerySchema, 'query'), async (req: Request, res: Response) => {
  successResponse(res, await fulfilmentService.list(req.sellerId!, (req.query as { tab: never }).tab), 'Shipments');
});
seller.get('/shipments/:id', async (req: Request, res: Response) => {
  successResponse(res, await fulfilmentService.get(req.sellerId!, req.params.id));
});
seller.post('/shipments/:id/pack', auditLog({ action: 'SHIPMENT_STATUS_CHANGED', targetType: 'Shipment', targetIdParam: 'id' }), async (req: Request, res: Response) => {
  successResponse(res, await fulfilmentService.pack(req.sellerId!, req.params.id), 'Marked packed');
});
seller.post('/shipments/:id/dispatch', validate(dispatchSchema), auditLog({ action: 'SHIPMENT_STATUS_CHANGED', targetType: 'Shipment', targetIdParam: 'id' }), async (req: Request, res: Response) => {
  successResponse(res, await fulfilmentService.dispatch(req.sellerId!, req.params.id, req.body), 'Dispatched');
});
seller.post('/shipments/:id/deliver', validate(deliverSchema), auditLog({ action: 'SHIPMENT_STATUS_CHANGED', targetType: 'Shipment', targetIdParam: 'id' }), async (req: Request, res: Response) => {
  successResponse(res, await fulfilmentService.deliver(req.sellerId!, req.params.id, req.body.pin), 'Delivered');
});

// Inbound stock (ASN)
seller.get('/inbound', async (req: Request, res: Response) => {
  successResponse(res, await inboundService.listForSeller(req.sellerId!), 'Inbound shipments');
});
seller.post('/inbound', validate(createInboundSchema), async (req: Request, res: Response) => {
  createdResponse(res, await inboundService.create(req.sellerId!, req.body), 'Inbound notice created');
});
seller.get('/inbound/:id', async (req: Request, res: Response) => {
  successResponse(res, await inboundService.getForSeller(req.sellerId!, req.params.id));
});
seller.patch('/inbound/:id', validate(updateInboundSchema), async (req: Request, res: Response) => {
  successResponse(res, await inboundService.updateDraft(req.sellerId!, req.params.id, req.body), 'Inbound notice updated');
});
seller.post('/inbound/:id/submit', auditLog({ action: 'INBOUND_SUBMITTED', targetType: 'InboundShipment', targetIdParam: 'id' }), async (req: Request, res: Response) => {
  successResponse(res, await inboundService.submit(req.sellerId!, req.params.id), 'Inbound notice sent to the hub');
});
seller.post('/inbound/:id/cancel', async (req: Request, res: Response) => {
  successResponse(res, await inboundService.cancel(req.sellerId!, req.params.id), 'Inbound notice cancelled');
});

// Requests for products not yet in the catalog
seller.get('/product-requests', async (req: Request, res: Response) => {
  successResponse(res, await productRequestsService.listForSeller(req.sellerId!), 'Product requests');
});
seller.post('/product-requests', validate(createProductRequestSchema), auditLog({ action: 'PRODUCT_REQUEST_SUBMITTED', targetType: 'ProductRequest' }), async (req: Request, res: Response) => {
  createdResponse(res, await productRequestsService.create(req.sellerId!, req.body), 'Request sent to the catalog team');
});
seller.post('/product-requests/:id/cancel', async (req: Request, res: Response) => {
  successResponse(res, await productRequestsService.cancel(req.sellerId!, req.params.id), 'Request cancelled');
});

// Store branches: physical locations that hold stock and pack orders
seller.get('/branches', async (req: Request, res: Response) => {
  successResponse(res, await branchesService.list(req.sellerId!), 'Branches');
});
seller.get('/branches/:id', async (req: Request, res: Response) => {
  successResponse(res, await branchesService.get(req.sellerId!, req.params.id));
});
seller.post('/branches', validate(createBranchSchema), auditLog({ action: 'BRANCH_CREATED', targetType: 'StoreBranch' }), async (req: Request, res: Response) => {
  createdResponse(res, await branchesService.create(req.sellerId!, req.body), 'Branch added');
});
seller.patch('/branches/:id', validate(updateBranchSchema), auditLog({ action: 'BRANCH_UPDATED', targetType: 'StoreBranch', targetIdParam: 'id' }), async (req: Request, res: Response) => {
  successResponse(res, await branchesService.update(req.sellerId!, req.params.id, req.body), 'Branch updated');
});

router.use('/', seller);

export default router;
