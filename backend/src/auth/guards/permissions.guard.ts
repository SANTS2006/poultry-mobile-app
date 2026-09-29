import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthUser } from '../auth.types';
import { ANY_AUTHENTICATED, PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { IS_PUBLIC } from '../decorators/public.decorator';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    const user = ctx.switchToHttp().getRequest<{ user?: AuthUser }>().user;
    if (!user) throw new ForbiddenException('You do not have permission to perform this action.');

    const required = this.reflector.getAllAndOverride<string[] | undefined>(PERMISSIONS_KEY, targets);
    if (required?.length) {
      if (required.every((p) => user.permissions.includes(p))) return true;
      throw new ForbiddenException('You do not have permission to perform this action.');
    }
    // Deny-by-default: a route must explicitly declare that any signed-in user may call it.
    if (this.reflector.getAllAndOverride<boolean>(ANY_AUTHENTICATED, targets)) return true;
    throw new ForbiddenException('You do not have permission to perform this action.');
  }
}
