import { Body, Controller, Get, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { AuthGuard } from './auth.guard.js';
import type { Req as R } from '../common/http.js';
import { forbidden } from '../common/problem.js';

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private s: AuthService) {}
  @Post('login') @HttpCode(200) login(@Body() b: any, @Req() req: R) { return this.s.login(b, req.ip ?? ''); }
  @Post('register') register(@Body() b: any) { return this.s.register(b); }
  @Get('me') @UseGuards(AuthGuard) me(@Req() req: R) {
    if (req.principal?.type !== 'jwt') throw forbidden('Este endpoint requiere una sesión de usuario (JWT).');
    return this.s.me(req.principal.id!);
  }
}
