import axios from 'axios';
import prisma from './prisma';
import { env } from '../config/env';
import { logger } from './logger';

export type PushData =
  | { type: 'ORDER_UPDATE'; orderId: string }
  | { type: 'NEW_ORDER'; orderId: string }
  | { type: 'NEW_DELIVERY'; orderId?: string }
  | { type: 'EMERGENCY_ALERT'; alertId: string };

interface PushMessage {
  title: string;
  body: string;
  data: PushData;
}

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/**
 * Send a push notification to every device of the given users via the Expo Push API.
 * Fire-and-forget: failures are logged, never thrown, so they can't break the request.
 */
export async function sendPushToUsers(userIds: string[], message: PushMessage): Promise<void> {
  if (!userIds.length || env.NODE_ENV === 'test') return;
  try {
    const devices = await prisma.device.findMany({ where: { userId: { in: userIds } } });
    if (!devices.length) return;

    const payload = devices.map((d) => ({
      to: d.token,
      title: message.title,
      body: message.body,
      data: message.data,
      sound: 'default',
      channelId: 'orders',
    }));

    // Expo accepts up to 100 messages per request
    for (let i = 0; i < payload.length; i += 100) {
      const chunk = payload.slice(i, i + 100);
      const { data } = await axios.post(EXPO_PUSH_URL, chunk, {
        headers: {
          'Content-Type': 'application/json',
          ...(env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${env.EXPO_ACCESS_TOKEN}` } : {}),
        },
        timeout: 10000,
      });
      // Remove tokens Expo says are no longer registered
      const tickets: Array<{ status: string; details?: { error?: string } }> = data?.data ?? [];
      const dead = tickets
        .map((t, idx) => (t.status === 'error' && t.details?.error === 'DeviceNotRegistered' ? chunk[idx].to : null))
        .filter((t): t is string => !!t);
      if (dead.length) await prisma.device.deleteMany({ where: { token: { in: dead } } });
    }
  } catch (err) {
    logger.warn('Push notification failed', { err: (err as Error).message });
  }
}

export async function sendPushToRole(role: 'ADMIN' | 'DRIVER', message: PushMessage): Promise<void> {
  const users = await prisma.user.findMany({ where: { role, status: 'ACTIVE' }, select: { id: true } });
  await sendPushToUsers(users.map((u) => u.id), message);
}
