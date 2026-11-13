# syntax=docker/dockerfile:1

# ---- build: compile TypeScript with the dev dependencies
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- deps: production dependencies only
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

# ---- runtime
FROM node:22-alpine
ENV NODE_ENV=production \
    LLM_GATEWAY_CONFIG=/config/config.yaml \
    LLM_GATEWAY_HOST=0.0.0.0 \
    LLM_GATEWAY_PORT=8080
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# The image's own `node` user: no root, and no write access to the application files.
USER node
EXPOSE 8080
# Liveness only: the container stays healthy while the gateway runs, even if a backend is down
# (backend status is on /healthz).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.LLM_GATEWAY_PORT + '/livez').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/index.js"]
