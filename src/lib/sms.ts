import axios from 'axios';
import { env } from '../config/env';
import { logger } from './logger';

/** Last message sent by the console provider; lets tests read verification codes */
export const consoleOutbox: { to: string; body: string }[] = [];

export async function sendSms(to: string, body: string): Promise<void> {
  switch (env.SMS_PROVIDER) {
    case 'twilio': {
      if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM) {
        throw new Error('Twilio is not configured');
      }
      await axios.post(
        `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
        new URLSearchParams({ To: to, From: env.TWILIO_FROM, Body: body }).toString(),
        {
          auth: { username: env.TWILIO_ACCOUNT_SID, password: env.TWILIO_AUTH_TOKEN },
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 10000,
        },
      );
      return;
    }
    case 'africastalking': {
      if (!env.AT_USERNAME || !env.AT_API_KEY) throw new Error("Africa's Talking is not configured");
      const host = env.AT_USERNAME === 'sandbox' ? 'api.sandbox.africastalking.com' : 'api.africastalking.com';
      await axios.post(
        `https://${host}/version1/messaging`,
        new URLSearchParams({
          username: env.AT_USERNAME,
          to,
          message: body,
          ...(env.AT_SENDER_ID ? { from: env.AT_SENDER_ID } : {}),
        }).toString(),
        {
          headers: { apiKey: env.AT_API_KEY, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 10000,
        },
      );
      return;
    }
    default:
      // Development: no SMS is sent, the message is logged instead
      consoleOutbox.push({ to, body });
      if (consoleOutbox.length > 50) consoleOutbox.shift();
      logger.info(`[SMS → ${to}] ${body}`);
  }
}
