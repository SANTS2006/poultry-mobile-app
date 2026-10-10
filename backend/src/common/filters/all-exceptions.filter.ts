import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { GENERIC_ERROR_MESSAGE } from '../messages';

/** Prisma codes meaning "database unreachable / timed out / pool exhausted". */
const DB_UNAVAILABLE = ['P1001', 'P1002', 'P1008', 'P1017', 'P2024'];

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  requestId?: string;
}

/**
 * Single choke point for error responses. Clients only ever receive client-safe messages:
 * no stack traces, SQL, paths or internals. Full detail goes to the (redacted) server log.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(AllExceptionsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request & { id?: string }>();
    const res = http.getResponse<Response>();
    const { status, message, error } = this.toClientError(exception);

    if (status === 503) {
      this.logger.warn({ requestId: req.id, code: (exception as { code?: string }).code }, 'Database temporarily unreachable');
    } else if (status >= 500) {
      this.logger.error({ err: exception, requestId: req.id }, 'Unhandled server error');
    } else if (status === 401 || status === 403) {
      this.logger.warn({ requestId: req.id, status, path: String(req.url).split('?')[0] }, 'Access denied');
    }

    const body: ErrorBody = { statusCode: status, error, message, requestId: req.id };
    res.status(status).json(body);
  }

  private toClientError(exception: unknown): { status: number; message: string | string[]; error: string } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status >= 500) return this.generic(status);
      const response = exception.getResponse();
      let message: string | string[] = exception.message;
      if (typeof response === 'object' && response && 'message' in response) {
        message = (response as { message: string | string[] }).message;
      }
      return { status, message, error: HttpStatus[status] ?? 'Error' };
    }
    // The database could not be reached or the connection pool is exhausted: a temporary condition, not a bug. 503 tells the app to retry.
    if (exception instanceof Prisma.PrismaClientInitializationError || (exception instanceof Prisma.PrismaClientKnownRequestError && DB_UNAVAILABLE.includes(exception.code))) {
      return { status: 503, message: 'The server cannot reach its database right now. Please try again in a moment.', error: 'Service Unavailable' };
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      // Map by code only; never expose meta (contains table/column/constraint names).
      if (exception.code === 'P2002') {
        return { status: 409, message: 'A record with these details already exists.', error: 'Conflict' };
      }
      if (exception.code === 'P2025') {
        return { status: 404, message: 'The requested record was not found.', error: 'Not Found' };
      }
      if (exception.code === 'P2003' || exception.code === 'P2004') {
        return { status: 409, message: 'This operation conflicts with related records.', error: 'Conflict' };
      }
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError && exception.code === 'P2010') {
      // Raw-query failure: map by SQLSTATE only (meta may contain SQL text).
      const sqlState = (exception.meta as { code?: string } | undefined)?.code;
      if (sqlState === '23505' || sqlState === '23503') {
        return { status: 409, message: 'This operation conflicts with existing records.', error: 'Conflict' };
      }
      if (sqlState === '23514' || sqlState === '23502') {
        return { status: 400, message: 'The submitted values are not valid.', error: 'Bad Request' };
      }
    }
    // Body-parser / http-errors (oversized or malformed JSON): expose status with a fixed message only.
    const httpLike = exception as { status?: unknown; type?: unknown };
    if (typeof httpLike?.status === 'number' && httpLike.status >= 400 && httpLike.status < 500) {
      const message =
        httpLike.status === 413 ? 'The request is too large.' : 'The request could not be understood.';
      return { status: httpLike.status, message, error: HttpStatus[httpLike.status] ?? 'Bad Request' };
    }
    return this.generic(500);
  }

  private generic(status: number) {
    return { status, message: GENERIC_ERROR_MESSAGE, error: HttpStatus[status] ?? 'Internal Server Error' };
  }
}
