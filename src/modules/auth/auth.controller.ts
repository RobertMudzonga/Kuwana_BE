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

export class AuthController {
  async register(req: Request, res: Response): Promise<void> {
    const result = await authService.register(req.body);
    res.cookie(CONSTANTS.REFRESH_TOKEN_COOKIE, result.refreshToken, cookieOptions);
    createdResponse(res, { accessToken: result.accessToken, user: result.user }, 'Account created');
  }

  async login(req: Request, res: Response): Promise<void> {
    const result = await authService.login(req.body);
    res.cookie(CONSTANTS.REFRESH_TOKEN_COOKIE, result.refreshToken, cookieOptions);
    successResponse(res, { accessToken: result.accessToken, user: result.user }, 'Login successful');
  }

  async refresh(req: Request, res: Response): Promise<void> {
    // Accept token from cookie or body
    const token: string =
      req.cookies?.[CONSTANTS.REFRESH_TOKEN_COOKIE] ?? req.body?.refreshToken ?? '';
    const result = await authService.refresh(token);
    res.cookie(CONSTANTS.REFRESH_TOKEN_COOKIE, result.refreshToken, cookieOptions);
    successResponse(res, { accessToken: result.accessToken }, 'Token refreshed');
  }

  async logout(req: Request, res: Response): Promise<void> {
    const token: string =
      req.cookies?.[CONSTANTS.REFRESH_TOKEN_COOKIE] ?? req.body?.refreshToken ?? '';
    if (token) await authService.logout(token);
    res.clearCookie(CONSTANTS.REFRESH_TOKEN_COOKIE);
    successResponse(res, null, 'Logged out');
  }
}

export const authController = new AuthController();
