# Build stage
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci
COPY tsconfig.base.json ./
COPY apps/api ./apps/api
RUN npm run build --workspace apps/api \
 && npm prune --omit=dev

# Runtime stage: same image serves both roles; the platform sets the command.
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /repo
RUN addgroup -S app && adduser -S app -G app
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/apps/api/package.json ./apps/api/package.json
COPY --from=build /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY --from=build /repo/apps/api/drizzle ./apps/api/drizzle
USER app
EXPOSE 3000
# api role (default). Worker role: node apps/api/dist/main-worker.js
# Migrations (one-off job before deploy): node apps/api/dist/infra/db/migrate.js
CMD ["node", "apps/api/dist/main-api.js"]
