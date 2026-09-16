# --- deps ---
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# --- build ---
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Public config is inlined at build time; provide placeholders that compose overrides at runtime for server env.
ARG NEXT_PUBLIC_ACME_USD_ADDRESS
ARG NEXT_PUBLIC_TREASURY_ADDRESS
ARG NEXT_PUBLIC_EXPLORER_URL=https://explore.testnet.tempo.xyz
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# --- run ---
FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
RUN corepack enable
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# migrations + runner (tsx + drizzle are in node_modules of the standalone bundle only if traced; ship them explicitly)
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/src/db ./src/db
COPY --from=deps /app/node_modules ./node_modules_full
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["./docker-entrypoint.sh"]
