FROM node:20.18-alpine3.19 AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && \
    npm cache clean --force && \
    rm -rf /root/.npm /app/node_modules/.bin /app/node_modules/.cache && \
    find /app/node_modules -name "*.md" -delete && \
    find /app/node_modules -name "*.ts" -delete && \
    find /app/node_modules -name "*.d.ts" -delete && \
    find /app/node_modules -name "*.map" -delete && \
    find /app/node_modules -name "*.flow" -delete && \
    find /app/node_modules -name "LICENSE*" -delete && \
    find /app/node_modules -name "CHANGELOG*" -delete && \
    find /app/node_modules -name ".gitignore" -delete && \
    find /app/node_modules -name ".npmignore" -delete && \
    find /app/node_modules -name ".editorconfig" -delete && \
    find /app/node_modules -name ".eslintrc*" -delete && \
    find /app/node_modules -name "*.yml" -delete && \
    find /app/node_modules -name "*.yaml" -delete && \
    find /app/node_modules -name "*.txt" -delete && \
    find /app/node_modules -name "Makefile" -delete && \
    find /app/node_modules -name "*.mk" -delete && \
    find /app/node_modules -name "*.h" -delete && \
    find /app/node_modules -name "*.c" -delete && \
    find /app/node_modules -name "*.cpp" -delete && \
    find /app/node_modules -name "*.cc" -delete && \
    find /app/node_modules -name "*.gyp" -delete && \
    find /app/node_modules -type d -name "test" -prune -exec rm -rf {} + && \
    find /app/node_modules -type d -name "tests" -prune -exec rm -rf {} + && \
    find /app/node_modules -type d -name "docs" -prune -exec rm -rf {} + && \
    find /app/node_modules -type d -name "examples" -prune -exec rm -rf {} + && \
    find /app/node_modules -type d -name ".github" -prune -exec rm -rf {} + && \
    find /app/node_modules -type d -name "coverage" -prune -exec rm -rf {} + && \
    find /app/node_modules -type d -name "benchmark" -prune -exec rm -rf {} + && \
    find /app/node_modules -type d -name "benchmarks" -prune -exec rm -rf {} + && \
    find /app/node_modules -type d -name "__tests__" -prune -exec rm -rf {} + && \
    find /app/node_modules -type d -name ".nyc_output" -prune -exec rm -rf {} + && \
    rm -f /app/node_modules/.package-lock.json

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
