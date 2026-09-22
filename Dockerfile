# Build stage
FROM golang:1.22-alpine AS builder

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-w -s" -o /apigee-emulator-service .

# Final stage
FROM alpine:3.19

RUN apk --no-cache add ca-certificates curl jq

WORKDIR /app

COPY --from=builder /apigee-emulator-service /app/apigee-emulator-service
COPY public /app/public
COPY data /app/data
RUN cp /app/data/products/products.json /app/products.json 2>/dev/null || true && \
    cp /app/data/developers/developers.json /app/developers.json 2>/dev/null || true && \
    cp /app/data/developerapps/developerapps.json /app/developerapps.json 2>/dev/null || true && \
    cp /app/data/maps/maps.json /app/maps.json 2>/dev/null || true && \
    cp /app/data/datacollectors/datacollectors.json /app/datacollectors.json 2>/dev/null || true

ENV PORT=8082 \
    EMULATOR_MGMT_URL=http://127.0.0.1:8080 \
    EMULATOR_RUNTIME_URL=http://127.0.0.1:8998 \
    DATA_DIR=/app/data

EXPOSE 8082

CMD ["/app/apigee-emulator-service"]
