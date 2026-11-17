# syntax=docker/dockerfile:1.7
# Single image: the gateway serves the API, the WebSocket and the built web app.

ARG NODE_VERSION=24-alpine

FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

# ---- dependencies (cached unless a manifest or the lockfile changes) ----
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/gateway/package.json apps/gateway/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# ---- build ----
FROM deps AS build
COPY . .
ARG VITE_CHAIN_ID=421614
ARG VITE_SENTRY_DSN=
ARG RELEASE=dev
ENV VITE_CHAIN_ID=$VITE_CHAIN_ID VITE_SENTRY_DSN=$VITE_SENTRY_DSN VITE_RELEASE=$RELEASE
RUN pnpm --filter @paperperp/web build \
 && pnpm --filter @paperperp/gateway build \
 && pnpm --filter @paperperp/gateway deploy --prod --legacy /out

# ---- runtime ----
FROM node:${NODE_VERSION} AS runtime
ARG RELEASE=dev
ENV NODE_ENV=production \
    RELEASE=$RELEASE \
    PORT=8787 \
    DATABASE_PATH=/data/paperperp.db \
    STATIC_DIR=/app/public
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /app/apps/gateway/dist ./dist
COPY --from=build /app/apps/web/dist ./public
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1
CMD ["node", "--enable-source-maps", "dist/main.js"]
