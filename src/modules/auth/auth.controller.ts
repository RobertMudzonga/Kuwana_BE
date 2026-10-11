import { Request, Response } from 'express';
import { authService } from './auth.service';
import { successResponse, createdResponse } from '../../lib/response';
import { CONSTANTS } from '../../config/constants';
import { env } from '../../config/env';

const cookieOptions = {
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
};

// The refresh token is returned in the body for mobile clients (which can't rely on cookies)
// and also set as an httpOnly cookie for browser clients.
export class AuthController {
  async register(req: Request, res: Response): Promise<void> {
    const result = await authService.register(req.body);
    res.cookie(CONSTANTS.REFRESH_TOKEN_COOKIE, result.refreshToken, cookieOptions);
    createdResponse(res, result, 'Account created');
  }

  async login(req: Request, res: Response): Promise<void> {
    const result = await authService.login(req.body);
    res.cookie(CONSTANTS.REFRESH_TOKEN_COOKIE, result.refreshToken, cookieOptions);
    successResponse(res, result, 'Login successful');
  }

  async refresh(req: Request, res: Response): Promise<void> {
    // Prefer an explicit body token (mobile) over the cookie (web)
    const token: string = req.body?.refreshToken ?? req.cookies?.[CONSTANTS.REFRESH_TOKEN_COOKIE] ?? '';
    const result = await authService.refresh(token);
    res.cookie(CONSTANTS.REFRESH_TOKEN_COOKIE, result.refreshToken, cookieOptions);
    successResponse(res, result, 'Token refreshed');
  }

  async logout(req: Request, res: Response): Promise<void> {
    const token: string = req.body?.refreshToken ?? req.cookies?.[CONSTANTS.REFRESH_TOKEN_COOKIE] ?? '';
    if (token) await authService.logout(token);
    res.clearCookie(CONSTANTS.REFRESH_TOKEN_COOKIE);
    successResponse(res, null, 'Logged out');
  }

  async me(req: Request, res: Response): Promise<void> {
    successResponse(res, await authService.me(req.user!.sub));
  }

  async changePassword(req: Request, res: Response): Promise<void> {
    await authService.changePassword(req.user!.sub, req.body.currentPassword, req.body.newPassword);
    successResponse(res, null, 'Password changed');
  }

  async forgotPassword(req: Request, res: Response): Promise<void> {
    await authService.forgotPassword(req.body.email);
    successResponse(res, null, 'If an account exists for that email, a reset link has been sent');
  }

  async resetPassword(req: Request, res: Response): Promise<void> {
    await authService.resetPassword(req.body.token, req.body.password);
    successResponse(res, null, 'Password reset. You can now log in.');
  }

  async sendPhoneCode(req: Request, res: Response): Promise<void> {
    await authService.sendPhoneCode(req.user!.sub, req.body.phone);
    successResponse(res, null, 'Verification code sent');
  }

  async verifyPhone(req: Request, res: Response): Promise<void> {
    const user = await authService.verifyPhone(req.user!.sub, req.body.phone, req.body.code);
    successResponse(res, user, 'Phone verified');
  }
}

export const authController = new AuthController();
