import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../../lib/prisma';
import { authenticate } from '../../middleware/auth.middleware';
import { validate } from '../../middleware/validate.middleware';
import { successResponse, createdResponse } from '../../lib/response';
import { BadRequestError, NotFoundError } from '../../middleware/error.middleware';

const MAX_ADDRESSES = 20;

const addressSchema = z.object({
  label: z.string().min(1).max(40),
  line1: z.string().min(2).max(200),
  line2: z.string().max(200).optional(),
  city: z.string().min(2).max(100).optional(),
  /** Structured city from /logistics/cities; sets `city` to its name */
  cityId: z.string().uuid().optional(),
  suburb: z.string().max(100).optional(),
  /** Directions where street numbers are unclear, e.g. "blue gate opposite the clinic" */
  landmark: z.string().max(200).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  instructions: z.string().max(300).optional(),
  isDefault: z.boolean().optional(),
}).refine((a) => a.city || a.cityId, { message: 'Choose a town or city', path: ['cityId'] });

const router = Router();
router.use(authenticate);

router.get('/', async (req: Request, res: Response) => {
  const addresses = await prisma.address.findMany({
    where: { userId: req.user!.sub },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
  });
  successResponse(res, addresses);
});

router.post('/', validate(addressSchema), async (req: Request, res: Response) => {
  const userId = req.user!.sub;
  const count = await prisma.address.count({ where: { userId } });
  if (count >= MAX_ADDRESSES) {
    res.status(400).json({ success: false, message: `You can save up to ${MAX_ADDRESSES} addresses` });
    return;
  }
  // The first address becomes the default
  const isDefault = req.body.isDefault ?? count === 0;
  let { city, cityId } = req.body as { city?: string; cityId?: string };
  if (cityId) {
    const ref = await prisma.city.findUnique({ where: { id: cityId }, select: { name: true } });
    if (!ref) throw new BadRequestError('Unknown city');
    city = ref.name;
  } else if (city) {
    // Free-text city: link it when it matches a known town
    cityId = (await prisma.city.findFirst({ where: { name: { equals: city.trim(), mode: 'insensitive' } }, select: { id: true } }))?.id;
  }
  const address = await prisma.$transaction(async (tx) => {
    if (isDefault) await tx.address.updateMany({ where: { userId }, data: { isDefault: false } });
    return tx.address.create({ data: { ...req.body, city: city!, cityId, isDefault, userId } });
  });
  createdResponse(res, address, 'Address saved');
});

router.delete('/:id', async (req: Request, res: Response) => {
  const userId = req.user!.sub;
  const address = await prisma.address.findFirst({ where: { id: req.params.id, userId } });
  if (!address) throw new NotFoundError('Address');
  await prisma.$transaction(async (tx) => {
    await tx.address.delete({ where: { id: address.id } });
    if (address.isDefault) {
      const next = await tx.address.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
      if (next) await tx.address.update({ where: { id: next.id }, data: { isDefault: true } });
    }
  });
  successResponse(res, null, 'Address deleted');
});

export default router;
