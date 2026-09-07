# syntax=docker/dockerfile:1.7

FROM oven/bun:1.4.0-debian AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
RUN --mount=type=cache,id=frely-network-bun,target=/root/.bun/install/cache \
    bun install --frozen-lockfile
RUN bun run build

FROM oven/bun:1.4.0-debian AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=bun:bun /app/dist ./dist
USER bun
EXPOSE 4100
CMD ["bun", "dist/broker-mcp.js"]
