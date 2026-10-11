import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../../lib/prisma';
import { authenticate } from '../../middleware/auth.middleware';
import { validate } from '../../middleware/validate.middleware';
import { successResponse } from '../../lib/response';

const router = Router();
router.use(authenticate);

const deviceSchema = z.object({
  token: z.string().regex(/^(ExponentPushToken|ExpoPushToken)\[.+\]$/, 'Invalid Expo push token'),
  platform: z.enum(['ios', 'android', 'web']),
});

/** Register this device for push. A token moves to whoever signed in on the device most recently. */
router.post('/', validate(deviceSchema), async (req: Request, res: Response) => {
  await prisma.device.upsert({
    where: { token: req.body.token },
    update: { userId: req.user!.sub, platform: req.body.platform },
    create: { token: req.body.token, platform: req.body.platform, userId: req.user!.sub },
  });
  successResponse(res, null, 'Device registered');
});

router.delete('/:token', async (req: Request, res: Response) => {
  await prisma.device.deleteMany({ where: { token: req.params.token, userId: req.user!.sub } });
  successResponse(res, null, 'Device removed');
});

export default router;
