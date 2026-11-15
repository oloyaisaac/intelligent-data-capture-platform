# syntax=docker/dockerfile:1

# Build from the repository root so npm can resolve the backend's workspace dependencies.
FROM node:22-bookworm-slim AS build
WORKDIR /workspace

# npm ci needs every workspace manifest to validate the monorepo lockfile. Select only the backend
# workspace so desktop/mobile dependencies (including Electron) are not installed into this image.
COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/mobile/package.json apps/mobile/package.json
COPY packages/connectors/package.json packages/connectors/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --workspace=@idcp/backend --no-audit --no-fund

COPY apps/backend/src/ apps/backend/src/
COPY packages/connectors/src/ packages/connectors/src/
COPY packages/shared/src/ packages/shared/src/
COPY tsconfig.base.json ./tsconfig.base.json
RUN npm run build --workspace=@idcp/backend

# Install only production dependencies in a separate layer. The backend build bundles the local
# @idcp workspace packages, so remove npm's workspace symlinks; the runtime needs only real packages.
FROM node:22-bookworm-slim AS production-dependencies
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/mobile/package.json apps/mobile/package.json
COPY packages/connectors/package.json packages/connectors/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --omit=dev --workspace=@idcp/backend --no-audit --no-fund \
  && rm -f node_modules/@idcp/backend node_modules/@idcp/connectors node_modules/@idcp/shared

FROM node:22-bookworm-slim AS runtime

# The default local OCR provider invokes Tesseract. Include its English language data in the
# deployment image rather than silently shipping an unavailable provider (review finding MM-24).
RUN apt-get update \
  && apt-get install --yes --no-install-recommends tesseract-ocr tesseract-ocr-eng \
  && tesseract --list-langs | grep -qx eng \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=4000 \
    SQLITE_PATH=/data/idcp.db \
    STORAGE_PATH=/data/documents \
    LEGAL_DIR=/app/legal \
    TESSERACT_BIN=/usr/bin/tesseract
WORKDIR /app

COPY --from=production-dependencies --chown=node:node /workspace/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/apps/backend/dist ./dist
COPY --chown=node:node legal/ ./legal/

# SQLite (for standalone use) and filesystem documents both persist under this mount.
RUN mkdir -p /data/documents \
  && chown -R node:node /data
VOLUME ["/data"]

USER node
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/api/v1/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/server.js"]
