# syntax=docker/dockerfile:1

FROM node:24-alpine AS builder

WORKDIR /app

RUN apk add --no-cache python3 py3-pip make g++ linux-headers && ln -sf python3 /usr/bin/python

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./

RUN pnpm install --no-frozen-lockfile

COPY . .

RUN pnpm build

RUN pnpm prune --prod


FROM node:24-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

RUN addgroup -S kis && adduser -S kis -G kis

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public

RUN mkdir -p /app/uploads && chown -R kis:kis /app

USER kis

EXPOSE 4000

CMD ["node", "dist/main"]
