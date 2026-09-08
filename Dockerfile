# Multi-stage production Dockerfile for time-off-microservice
FROM node:20-alpine AS builder

WORKDIR /app

# Install native build tools for compiling sqlite3 bindings
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci

COPY . .

# Production runner stage
FROM node:20-alpine AS runner

WORKDIR /app

RUN apk add --no-cache sqlite-libs wget

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/timeoff.db

COPY package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/.babelrc ./
COPY --from=builder /app/babel.config.js ./
COPY --from=builder /app/jsconfig.json ./

# Run with non-root user
RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["npm", "start"]
