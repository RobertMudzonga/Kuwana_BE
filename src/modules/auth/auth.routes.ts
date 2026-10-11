import { Router } from 'express';
import { authController } from './auth.controller';
import { validate } from '../../middleware/validate.middleware';
import {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  changePasswordSchema,
  sendPhoneCodeSchema,
  verifyPhoneSchema,
} from './auth.schema';
import { authenticate } from '../../middleware/auth.middleware';
import { auditLog } from '../../middleware/audit.middleware';
import rateLimit from 'express-rate-limit';
import { env } from '../../config/env';

const router = Router();

const authLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.AUTH_RATE_LIMIT_MAX,
  message: { success: false, message: 'Too many auth attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * @swagger
 * /auth/register:
 *   post:
 *     summary: Register a new user or service provider
 *     tags: [Auth]
 */
router.post(
  '/register',
  authLimiter,
  validate(registerSchema),
  auditLog({ action: 'USER_CREATED', targetType: 'User' }),
  authController.register.bind(authController),
);

/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: Login and receive JWT tokens
 *     tags: [Auth]
 */
router.post(
  '/login',
  authLimiter,
  validate(loginSchema),
  authController.login.bind(authController),
);

/**
 * @swagger
 * /auth/refresh:
 *   post:
 *     summary: Rotate refresh token and get new access token
 *     tags: [Auth]
 */
router.post('/refresh', authController.refresh.bind(authController));

/**
 * @swagger
 * /auth/logout:
 *   post:
 *     summary: Logout and revoke refresh token
 *     tags: [Auth]
 */
router.post('/logout', authenticate, authController.logout.bind(authController));

router.get('/me', authenticate, authController.me.bind(authController));

router.post(
  '/change-password',
  authenticate,
  authLimiter,
  validate(changePasswordSchema),
  auditLog({ action: 'PASSWORD_CHANGED', targetType: 'User' }),
  authController.changePassword.bind(authController),
);

router.post('/forgot-password', authLimiter, validate(forgotPasswordSchema), authController.forgotPassword.bind(authController));

router.post(
  '/reset-password',
  authLimiter,
  validate(resetPasswordSchema),
  auditLog({ action: 'PASSWORD_RESET', targetType: 'User' }),
  authController.resetPassword.bind(authController),
);

router.post('/phone/send-code', authenticate, validate(sendPhoneCodeSchema), authController.sendPhoneCode.bind(authController));

router.post(
  '/phone/verify',
  authenticate,
  validate(verifyPhoneSchema),
  auditLog({ action: 'PHONE_VERIFIED', targetType: 'User' }),
  authController.verifyPhone.bind(authController),
);

export default router;
