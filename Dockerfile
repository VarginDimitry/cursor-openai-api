# syntax=docker/dockerfile:1

# Runtime needs both Bun (main process) and Node (h2-bridge.mjs HTTP/2).
FROM oven/bun:1-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM base AS prod-deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN bun run build \
  && find dist -type f \( -name '*.map' -o -name '*.d.ts' \) -delete

FROM base AS release
# Keep Node only for the HTTP/2 bridge child process.
COPY --from=node:22-alpine /usr/local/bin/node /usr/local/bin/node

RUN addgroup -g 1001 -S appuser \
  && adduser -u 1001 -S appuser -G appuser

COPY --from=prod-deps --chown=appuser:appuser /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appuser /app/dist ./dist
COPY --chown=appuser:appuser package.json ./

ENV NODE_ENV=production
USER appuser
ENTRYPOINT ["bun", "dist/cli.js"]
