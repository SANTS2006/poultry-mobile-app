import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedRequest, AuthUser, RequestMeta } from '../auth.types';

export const CurrentUser = createParamDecorator((_d: unknown, ctx: ExecutionContext): AuthUser =>
  ctx.switchToHttp().getRequest<AuthenticatedRequest>().user);

export function requestMeta(req: import('express').Request & { id?: string }): RequestMeta {
  const h = (name: string) => {
    const v = req.headers[name];
    return typeof v === 'string' ? v.slice(0, 100) : undefined;
  };
  return {
    ip: req.ip,
    deviceName: h('x-device-name'),
    platform: h('x-platform'),
    userAgent: h('user-agent'),
    requestId: typeof req.id === 'string' ? req.id : undefined,
  };
}

export const Meta = createParamDecorator((_d: unknown, ctx: ExecutionContext): RequestMeta =>
  requestMeta(ctx.switchToHttp().getRequest()));
