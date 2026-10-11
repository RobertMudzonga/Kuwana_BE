import { z } from 'zod';

const passwordRule = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .regex(/[A-Z]/, 'Must contain an uppercase letter')
  .regex(/[0-9]/, 'Must contain a number');

/** Zimbabwean mobile number in E.164 form (+2637XXXXXXXX) */
export const zwMobile = z.string().regex(/^\+2637\d{8}$/, 'Enter a Zimbabwean mobile number in the form +2637XXXXXXXX');

export const registerSchema = z.object({
  email: z.string().email('Invalid email address').transform((e) => e.toLowerCase()),
  phone: z.string().regex(/^\+?[0-9]{7,15}$/, 'Invalid phone number').optional(),
  password: passwordRule,
  fullName: z.string().min(2, 'Full name is required').max(100),
});

export const loginSchema = z.object({
  email: z.string().email().transform((e) => e.toLowerCase()),
  password: z.string().min(1, 'Password is required'),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1).optional(),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email().transform((e) => e.toLowerCase()),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(20),
  password: passwordRule,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordRule,
});

export const sendPhoneCodeSchema = z.object({ phone: zwMobile });
export const verifyPhoneSchema = z.object({ phone: zwMobile, code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') });

export type RegisterDto = z.infer<typeof registerSchema> & { role?: 'USER' | 'PROVIDER' | 'DRIVER' };
export type LoginDto = z.infer<typeof loginSchema>;
