import nodemailer from 'nodemailer';
import { env } from '../config/env';
import { logger } from './logger';

const transporter = env.SMTP_HOST
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    })
  : null;

export async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  if (!transporter) {
    // Development: log instead of sending
    logger.info(`[EMAIL → ${to}] ${subject}\n${text}`);
    return;
  }
  await transporter.sendMail({ from: env.MAIL_FROM, to, subject, text });
}
