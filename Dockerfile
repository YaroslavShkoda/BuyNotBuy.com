# Production image for the BuyNotBuy backend.
#
# The backend is a plain Node ESM program: `tsc` emits JavaScript and Node
# runs it directly. No transpiler, no loader hook and no source files are
# shipped to production — tsx stays a development dependency, so a runtime
# path through it cannot silently become a production dependency.

FROM node:24-alpine AS dependencies
WORKDIR /app

# Only the manifest, so this layer is reused whenever dependencies have not
# changed. Copying everything first would invalidate it on every source edit.
COPY package.json package-lock.json ./
RUN npm ci


FROM dependencies AS build
WORKDIR /app

COPY tsconfig.json ./
COPY src ./src

# A build that type-checks but does not emit is a failed build, so the emit
# itself is the gate rather than a separate --noEmit pass.
RUN npm run build:backend


FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001
ENV HOST=0.0.0.0

# --env-file-if-exists rather than --env-file: in a container the configuration
# comes from the orchestrator, and a missing .env must not stop the service.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# The database lives here and must outlive the container. It is a volume so a
# redeploy does not start with an empty signal history, and it is owned by the
# unprivileged user the process actually runs as.
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]

USER node

EXPOSE 3001

# Signal handling is delegated to Node, which is what closes the database
# handle cleanly; an init process reaps zombies and forwards signals.
CMD ["node", "dist/backend/server.js"]
