# Development reference image. This does not establish production deployment readiness.
# Official multi-platform image digest verified against registry-1.docker.io on 2026-08-30.
FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY @types/package.json ./@types/package.json
COPY haip-view/package.json ./haip-view/package.json
COPY haip-sdk/package.json ./haip-sdk/package.json
COPY haip-server/package.json ./haip-server/package.json
COPY haip-cli/package.json ./haip-cli/package.json

FROM manifests AS build
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY @types ./@types
COPY haip-view ./haip-view
COPY haip-sdk ./haip-sdk
COPY haip-server ./haip-server
COPY haip-cli ./haip-cli
COPY protocol ./protocol
COPY scripts/generate.mjs scripts/openapi.mjs scripts/build-browser.mjs ./scripts/
RUN mkdir -p docs/protocol && npm run build

FROM manifests AS dependencies
RUN npm ci --omit=dev --ignore-scripts --workspace=@haip/server --no-audit --no-fund

FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS development
LABEL org.opencontainers.image.title="HAIP 2 development reference" \
      org.opencontainers.image.description="Development only; no production deployment or independent anchoring claim" \
      org.opencontainers.image.source="https://github.com/haiprotocol/haip" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
ENV NODE_ENV=production HAIP_MODE=development HAIP_LISTEN_HOST=0.0.0.0
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/@types/package.json /app/@types/LICENSE /app/@types/README.md ./@types/
COPY --from=build /app/@types/dist ./@types/dist
COPY --from=build /app/@types/contracts ./@types/contracts
COPY --from=build /app/haip-server/package.json /app/haip-server/LICENSE /app/haip-server/README.md ./haip-server/
COPY --from=build /app/haip-server/dist ./haip-server/dist
COPY --from=build /app/haip-server/migrations ./haip-server/migrations
COPY --from=build /app/haip-server/schema ./haip-server/schema
COPY --from=build /app/haip-server/public ./haip-server/public
USER node
EXPOSE 8080 8081
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD ["node", "--input-type=module", "-e", "const response = await fetch('http://127.0.0.1:' + (process.env.PORT || '8080') + '/health', { signal: AbortSignal.timeout(2000) }); if (!response.ok) process.exit(1);"]
CMD ["node", "haip-server/dist/main.js"]
