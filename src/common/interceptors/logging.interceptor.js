'use strict';

const { Injectable, NestInterceptor, CallHandler, ExecutionContext } = require('@nestjs/common');
const { tap } = require('rxjs/operators');
const { v4: uuidv4 } = require('uuid');

/**
 * Injects a correlation ID on every request and logs request/response pairs.
 * Uses X-Request-ID header if provided by the client (or upstream gateway),
 * otherwise generates a new UUID v4.
 */
@Injectable()
class LoggingInterceptor {
  intercept(context, next) {
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();

    const requestId = req.headers['x-request-id'] || uuidv4();
    req.requestId = requestId;
    res.setHeader('X-Request-ID', requestId);

    const startMs = Date.now();
    const { method, url } = req;

    console.info(
      JSON.stringify({
        event: 'REQUEST_START',
        requestId,
        method,
        url,
        employeeId: req.headers['x-employee-id'],
        timestamp: new Date().toISOString(),
      }),
    );

    return next.handle().pipe(
      tap({
        next: () => {
          console.info(
            JSON.stringify({
              event: 'REQUEST_END',
              requestId,
              method,
              url,
              statusCode: res.statusCode,
              durationMs: Date.now() - startMs,
              timestamp: new Date().toISOString(),
            }),
          );
        },
        error: (err) => {
          console.warn(
            JSON.stringify({
              event: 'REQUEST_ERROR',
              requestId,
              method,
              url,
              error: err.message,
              durationMs: Date.now() - startMs,
              timestamp: new Date().toISOString(),
            }),
          );
        },
      }),
    );
  }
}

module.exports = { LoggingInterceptor };
