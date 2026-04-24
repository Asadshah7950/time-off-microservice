'use strict';

const { NestFactory } = require('@nestjs/core');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { AppModule } = require('./app.module');

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const corsOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Idempotency-Key'],
  });

  app.use(helmet({ contentSecurityPolicy: false }));
  app.getHttpAdapter().getInstance().disable('x-powered-by');

  if (process.env.NODE_ENV !== 'test') {
    const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
    const maxRequests = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '300', 10);
    app.use(
      rateLimit({
        windowMs,
        max: maxRequests,
        standardHeaders: true,
        legacyHeaders: false,
        message: {
          error: 'RATE_LIMITED',
          message: 'Too many requests. Please retry later.',
        },
      }),
    );
  }
  
  // Custom logic before shutdown
  app.enableShutdownHooks();

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.info(`[Application] Time-Off Microservice running on default port: ${port}`);
}

bootstrap().catch((err) => {
  console.error('[Application] Bootstrap failed', err);
  process.exit(1);
});
