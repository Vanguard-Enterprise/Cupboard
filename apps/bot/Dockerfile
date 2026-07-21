# cupboard-bot: TypeScript Discord worker (headless; no ports).
# 3-stage build: deps (npm ci) -> builder (tsc + prune to prod deps) -> runner.
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json \
    && npm prune --omit=dev --no-audit --no-fund

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN useradd --system --uid 10001 --no-create-home bot
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
USER 10001
# --import registers the ESM loader hook (register-hook.ts) before boot; the
# OTel instrumentations cannot wrap ESM-loaded deps (pino included) without it.
CMD ["node", "--import", "./dist/register-hook.js", "dist/index.js"]
