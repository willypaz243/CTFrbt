# syntax=docker/dockerfile:1

FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate

# ---------------- deps ----------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ---------------- builder ----------------
FROM base AS builder
ENV NEXT_TELEMETRY_DISABLED=1

# Variables públicas existentes
ARG NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_RECAPTCHA_SITE_KEY
ENV NEXT_PUBLIC_RECAPTCHA_SITE_KEY=$NEXT_PUBLIC_RECAPTCHA_SITE_KEY

COPY --from=deps /app/node_modules ./node_modules
COPY . .
# build script runs `prisma generate && next build`
RUN pnpm build

# ---------------- runner ----------------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

RUN apk add --no-cache postgresql-client su-exec \
    && addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

RUN npm install -g prisma@6 tsx

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
RUN mkdir -p /app/public/uploads && chown -R nextjs:nodejs /app/public/uploads
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma

# The uploads volume's mount point is owned by root (rootless podman does
# not copy ownership up), so start as root just long enough to fix it, then
# drop to nextjs for the actual app.
USER root
EXPOSE 3000

CMD ["sh", "-c", "chown nextjs:nodejs /app/public/uploads && exec su-exec nextjs sh -c 'prisma migrate deploy && node server.js'"]

# ---------------- orchestrator (dynamic challenge containers) ----------------
FROM base AS orchestrator
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/orchestrator/package.json ./apps/orchestrator/package.json
RUN pnpm install --frozen-lockfile
COPY apps/orchestrator/ ./apps/orchestrator/
RUN cd apps/orchestrator \
    && pnpm exec tsc -p tsconfig.json \
    && mkdir -p /deploy \
    && cp package.json /deploy/ \
    && cp -r dist /deploy/dist \
    && cd /deploy \
    && npm install --omit=dev --no-audit --no-fund

FROM node:22-alpine AS orchestrator-runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=orchestrator /deploy ./
CMD ["node", "dist/index.js"]
