FROM node:22-bookworm-slim AS build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/frontend/dist ./frontend/dist
COPY server/*.mjs ./server/
ENV NODE_ENV=production
USER node
CMD ["node", "server/index.mjs"]
