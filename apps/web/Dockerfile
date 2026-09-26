# Control-plane dashboard (Phase 3). Build from the repo root:
#   docker build -f apps/web/Dockerfile -t postelyo-web .
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY packages/publishing-core/package.json packages/publishing-core/
RUN npm ci
COPY apps/web ./apps/web
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build --workspace apps/web

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3001
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
USER app
EXPOSE 3001
# API_INTERNAL_URL and APP_BASE_URL are provided by the platform.
CMD ["node", "apps/web/server.js"]
