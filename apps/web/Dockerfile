FROM node:22-alpine AS build

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && corepack prepare --activate
COPY apps/web/package.json ./apps/web/package.json
COPY packages/api-client/package.json ./packages/api-client/package.json
COPY packages/canvas-core/package.json ./packages/canvas-core/package.json
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --fetch-timeout 120000
COPY apps/web ./apps/web
COPY packages ./packages
RUN pnpm --filter @canvas/web build

FROM caddy:2.11-alpine
COPY --from=build /app/apps/web/dist /srv
COPY infra/Caddyfile /etc/caddy/Caddyfile

EXPOSE 80 443 443/udp
