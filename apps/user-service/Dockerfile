FROM node:20.18-alpine3.19 AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && \
    npm cache clean --force && \
    npx -y node-prune

FROM node:20.18-alpine3.19 AS production
RUN addgroup -g 1001 -S appgroup && adduser -S appuser -u 1001 -G appgroup && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack
WORKDIR /app
COPY --from=deps --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --chown=appuser:appgroup src ./src
USER appuser
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/health/live', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"
CMD ["node", "src/index.js"]
