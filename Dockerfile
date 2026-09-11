FROM oven/bun:1.3.14-alpine AS builder
WORKDIR /app

COPY ./package.json ./bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

FROM oven/bun:1.3.14-alpine AS runner
WORKDIR /app

COPY ./package.json ./bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts --no-cache

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/pages ./pages

EXPOSE 4141

# 127.0.0.1, not localhost: some bases resolve "localhost" to ::1 first, and
# when HOST=0.0.0.0 the server only binds the IPv4 wildcard, so the IPv6
# loopback probe gets a connection refused even though the server is healthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --spider -q http://127.0.0.1:4141/ || exit 1

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
