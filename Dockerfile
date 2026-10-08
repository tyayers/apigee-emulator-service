FROM oven/bun:1-alpine

RUN apk --no-cache add ca-certificates curl jq docker-cli

WORKDIR /app

COPY package.json bun.lock* tsconfig.json ./
RUN bun install --production --frozen-lockfile || bun install --production

COPY src /app/src
COPY public /app/public
COPY data /app/data

ENV PORT=8082 \
    EMULATOR_MGMT_URL=http://127.0.0.1:8080 \
    EMULATOR_RUNTIME_URL=http://127.0.0.1:8888 \
    DATA_DIR=/app/data

EXPOSE 8082

CMD ["bun", "run", "src/index.ts"]
