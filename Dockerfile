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

# No volume here: the history lives in PostgreSQL, not in a file beside the
# process, so a redeploy keeps its signal history by pointing DATABASE_URL at
# the same database. A volume for a file nothing writes would only be a second
# thing to back up.

USER node

EXPOSE 3001

# Signal handling is delegated to Node, which drains the connection pool on
# shutdown; an init process reaps zombies and forwards signals. Without it a
# write in flight is lost, and the history is exactly the record that must not
# have holes in it.
CMD ["node", "dist/backend/server.js"]
