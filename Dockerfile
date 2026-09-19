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
COPY products.json developerapps.json developers.json maps.json datacollectors.json /app/

ENV PORT=8082 \
    EMULATOR_MGMT_URL=http://127.0.0.1:8080 \
    EMULATOR_RUNTIME_URL=http://127.0.0.1:8998 \
    DATA_DIR=/app/data

EXPOSE 8082

CMD ["/app/apigee-emulator-service"]
