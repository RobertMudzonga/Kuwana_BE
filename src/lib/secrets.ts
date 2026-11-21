import crypto from 'crypto';
import { env } from '../config/env';

/** Random numeric code, e.g. a 6-digit OTP or collection PIN */
export function randomDigits(length = 6): string {
  return crypto.randomInt(0, 10 ** length).toString().padStart(length, '0');
}

/**
 * Keyed hash for short secrets (OTPs, PINs). `scope` binds the code to one purpose and record,
 * so a code for one order can't be replayed against another.
 */
export function hashSecret(scope: string, code: string): string {
  return crypto.createHmac('sha256', env.JWT_ACCESS_SECRET).update(`${scope}:${code}`).digest('hex');
}

export function verifySecret(scope: string, code: string, expectedHash: string | null | undefined): boolean {
  if (!expectedHash) return false;
  const a = Buffer.from(hashSecret(scope, code), 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * A short code derived from a record id (e.g. the 4-digit store pickup PIN for a delivery job).
 * Nothing is stored: whoever is allowed to see it recomputes it, and the checker recomputes and compares.
 */
export function derivedPin(scope: string, digits = 4): string {
  const h = crypto.createHmac('sha256', env.JWT_ACCESS_SECRET).update(`derived:${scope}`).digest();
  return (h.readUInt32BE(0) % 10 ** digits).toString().padStart(digits, '0');
}

export function verifyDerivedPin(scope: string, pin: string, digits = 4): boolean {
  const a = Buffer.from(derivedPin(scope, digits));
  const b = Buffer.from(pin);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
