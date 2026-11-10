# syntax=docker/dockerfile:1
FROM node:24.18.0-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
# npm and Next.js caches persist in the runner's Docker daemon.
RUN --mount=type=cache,id=cupboard-npm,target=/root/.npm,sharing=locked \
    npm ci --prefer-offline --no-audit --no-fund
COPY . .
RUN --mount=type=cache,id=cupboard-next,target=/app/.next/cache,sharing=locked \
    npm run build

FROM node:24.18.0-bookworm-slim AS runtime
WORKDIR /app
LABEL org.opencontainers.image.source="https://github.com/Vanguard-Enterprise/Cupboard"
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]
