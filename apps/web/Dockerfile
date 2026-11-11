FROM node:22-alpine AS build

WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
    && pnpm --filter @canvas/web build

FROM caddy:2.11-alpine
COPY --from=build /app/apps/web/dist /srv
COPY infra/Caddyfile /etc/caddy/Caddyfile

EXPOSE 80 443 443/udp
