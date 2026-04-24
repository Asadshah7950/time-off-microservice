'use strict';

const { Catch, HttpException, HttpStatus, Injectable } = require('@nestjs/common');

/**
 * Global exception filter.
 * - Normalizes all errors (including unexpected ones) to a consistent JSON shape.
 * - Logs unhandled errors with full stack traces.
 * - Never leaks internal stack traces to clients.
 */
@Catch()
@Injectable()
class AllExceptionsFilter {
  catch(exception, host) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let errorCode = 'INTERNAL_SERVER_ERROR';
    let message = 'An unexpected error occurred';
    let details = undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        errorCode = exceptionResponse.error || String(status);
        message = Array.isArray(exceptionResponse.message)
          ? exceptionResponse.message.join('; ')
          : exceptionResponse.message || message;
        details = exceptionResponse.details;
      } else {
        message = String(exceptionResponse);
        errorCode = String(status);
      }
    } else {
      // Unexpected errors — log with full context
      console.error({
        event: 'UNHANDLED_EXCEPTION',
        requestId: request.requestId,
        method: request.method,
        path: request.path,
        errorMessage: exception.message,
        stack: exception.stack,
      });
    }

    const body = {
      statusCode: status,
      error: errorCode,
      message,
      requestId: request.requestId || 'unknown',
      timestamp: new Date().toISOString(),
      path: request.url,
    };

    if (details !== undefined) {
      body.details = details;
    }

    response.status(status).json(body);
  }
}

module.exports = { AllExceptionsFilter };
