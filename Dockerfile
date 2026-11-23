# AD QUEST — production image (Northflank / any Docker host)
# Multi-stage: build the Vite client + bundled Express server, then run
# with production dependencies only.

# ---------- Build stage ----------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# Builds client/dist (vite) and dist-server/index.js (esbuild bundle)
RUN npm run build

# ---------- Runtime stage ----------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The platform provides PORT (Northflank: the port you configure on the
# service); 3000 is the local default the server falls back to.
ENV PORT=3000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/client/dist ./client/dist
COPY --from=build /app/dist-server ./dist-server

USER node
EXPOSE 3000

# start script: node dist-server/index.js
CMD ["npm", "start"]
