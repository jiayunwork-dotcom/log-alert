FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY .npmrc ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV TZ=UTC

RUN apk add --no-cache tzdata ca-certificates

COPY package*.json ./
COPY .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

RUN mkdir -p /app/config /app/logs /app/rules

COPY examples/rules.yaml ./examples/rules.yaml
COPY examples/config.yaml ./examples/config.yaml

EXPOSE 3000

ENV LOG_ALERT_CONFIG=/app/config/config.yaml
ENV HTTP_PORT=3000

ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["run", "-c", "/app/config/config.yaml"]

LABEL org.opencontainers.image.title="log-alert" \
      org.opencontainers.image.description="日志结构化解析与智能告警规则引擎" \
      org.opencontainers.image.licenses="MIT"
