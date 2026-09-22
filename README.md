# Apigee Emulator Service Guide

This repository provides tools, scripts, and a lightweight web service for building, testing, tracing, and deploying Apigee proxies locally or to **Google Cloud Run** using the **Apigee Local Emulator**.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [1. Creating and Starting the Apigee Emulator Container](#1-creating-and-starting-the-apigee-emulator-container)
- [2. Deploying with `deploy.sh` (TestProxy & Deployment Manifests)](#2-deploying-with-deploysh-testproxy--deployment-manifests)
  - [Deploying TestProxy Directly](#deploying-testproxy-directly)
  - [Converting Deployment Manifests (`--convert`)](#converting-deployment-manifests---convert)
  - [Deploying Deployment Manifests Directly](#deploying-deployment-manifests-directly)
- [3. Tracing Proxy Executions with `trace.html`](#3-tracing-proxy-executions-with-tracehtml)
- [4. Testing TestProxy Endpoints](#4-testing-testproxy-endpoints)
- [5. Deploying to Google Cloud Run (`cloudrun.sh`)](#5-deploying-to-google-cloud-run-cloudrunsh)
  - [Architecture Overview](#architecture-overview)
  - [Deploying the Cloud Run Service](#deploying-the-cloud-run-service)
  - [Deploying TestProxy to Cloud Run](#deploying-testproxy-to-cloud-run)
  - [Testing & Tracing on Cloud Run](#testing--tracing-on-cloud-run)
  - [Cloud Run Management Commands](#cloud-run-management-commands)
- [6. Apigee Emulator Tester (`/tester/` Web UI & Go Service)](#6-apigee-emulator-tester-tester-web-ui--go-service)
  - [Running the Tester Service](#running-the-tester-service)
  - [Web UI Features](#web-ui-features)
  - [Test Suites & Assertions (from `deployment-1.yaml`)](#test-suites--assertions-from-deployment-1yaml)
  - [REST API Reference](#rest-api-reference)

---

## Prerequisites

- **Docker** installed and running (for local emulator container)
- **Google Cloud SDK (`gcloud`)** installed and authenticated (for Cloud Run)
- **AFT (Apigee Templater)** CLI tool installed
- **cURL** & **jq**
- **Python 3** with `pyyaml` (`pip install pyyaml`)
- **Go 1.21+** (for building the local tester service)

---

## 1. Creating and Starting the Apigee Emulator Container

The Apigee Emulator runs as a local Docker container exposing management endpoints and runtime proxy traffic.

### Create the Container

Run [`create.sh`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/create.sh):

```bash
./create.sh
```

Or execute the Docker command directly:

```bash
docker create --name apigee \
  -p 8080:8080 \
  -p 8998:8998 \
  gcr.io/apigee-release/hybrid/apigee-emulator:2.0.1
```

### Start / Stop the Container

```bash
# Start the container
docker start apigee

# Stop the container
docker stop apigee
```

### Port Mapping
- **Port `8080`**: Apigee Management API (`/v1/emulator/*`).
- **Port `8998`**: Apigee Message Processor Runtime (proxy traffic).

---

## 2. Deploying with `deploy.sh` (TestProxy & Deployment Manifests)

The [`deploy.sh`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/deploy.sh) script compiles AFT YAML files into proxy bundles, generates environment configs, packages test data, and deploys everything to the emulator.

### Deploying Deployments Directly

To compile and deploy [`data/deployments/deployment-1.yaml`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/data/deployments/deployment-1.yaml):

```bash
./deploy.sh data/deployments/deployment-1.yaml
```

This compiles the proxies defined in the deployment, packages test data (`products.json`, `developerapps.json`, etc.), resets the emulator, and deploys to the `test` environment.

---

### Converting Deployment Manifests (`--convert`)

You can convert any deployment manifest (such as [`data/deployments/deployment-1.yaml`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/data/deployments/deployment-1.yaml)) into deployable local assets:

```bash
# Convert a specific deployment manifest
./deploy.sh --convert data/deployments/deployment-1.yaml

# Or convert all deployment manifests in data/deployments/
./deploy.sh --convert
```

#### How Conversion Works:
1. Runs `aft -i data/deployments/<file>.yaml -f zip -o <target_dir> --no-animation`.
2. Copies generated proxy bundles into [`data/bundles/`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/data/bundles/) for automated startup deployment by the Go service.
3. Unpacks bundles into `dist/bundle/` and sanitizes target routes.
4. Merges generated API products, developers, and apps into `dist/` and sanitizes product schemas.

---

### Deploying Deployment Manifests Directly

Deploy [`data/deployments/deployment-1.yaml`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/data/deployments/deployment-1.yaml) in a single step:

```bash
./deploy.sh data/deployments/deployment-1.yaml
```

When given a deployment manifest, `deploy.sh`:
1. Compiles the included proxies (`TestProxy`) with `aft`.
2. Merges products, developers, apps, and credentials (`test-app-key-123`).
3. Resets the local emulator, loads all test data, and deploys the proxy bundle.

---

## 3. Tracing Proxy Executions with `trace.html`

The emulator includes built-in debug tracing. You can record execution traces and view them interactively in [`trace.html`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/trace.html).

### Step 1: Start a Trace Session

```bash
./emulator/trace_start.sh TestProxy
```

### Step 2: Send Request to Proxy

```bash
curl -i http://localhost:8998/testproxy
```

### Step 3: Stop Tracing & Fetch Transactions

```bash
./emulator/trace_stop.sh
```

This downloads recorded trace transactions and writes them to `emulator/trace.json`.

### Step 4: Inspect in `trace.html`

Open [`trace.html`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/trace.html) in your browser:
- Click **"Open trace.json"** and select `emulator/trace.json`.
- Inspect policy execution steps (`AM-SetHeader`, `JS-AddHelloWorld`), headers, and flow variables.

---

## 4. Testing TestProxy Endpoints

Once `TestProxy` is deployed, it listens on port **8998** with basepath `/testproxy`.

### 1. Basic Request

```bash
curl -i http://localhost:8998/testproxy
```

**Expected Response**:
```http
HTTP/1.1 200 OK
x-testheader: Hello world!
Content-Type: text/plain; charset=utf-8

Hello, Guest! Hello world!
```

---

### 2. Custom Message Query Parameter

`TestProxy` includes a JavaScript policy (`JS-AddHelloWorld`) that reads the `message` query parameter:

```bash
curl -i "http://localhost:8998/testproxy?message=from-Apigee"
```

**Expected Response**:
```http
HTTP/1.1 200 OK
x-testheader: Hello world!

Hello, Guest! from-Apigee
```

---

### 3. Target JSON Endpoint

```bash
curl -i http://localhost:8998/testproxy/json
```

**Expected Response**:
```json
{
  "headers": {
    "host": "mocktarget.apigee.net",
    "user-agent": "curl/..."
  },
  "message": "Hello world!"
}
```

---

### 4. Authenticated Request (API Key)

Using the test API credential generated from [`deployment-1.yaml`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/data/deployments/deployment-1.yaml) or [`developerapps.json`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/developerapps.json):

```bash
curl -i "http://localhost:8998/testproxy" \
  -H "x-api-key: test-app-key-123"
```

---

## 5. Deploying to Google Cloud Run (`cloudrun.sh`)

You can run the Apigee Emulator on **Google Cloud Run** using a multi-container sidecar architecture.

### Architecture Overview

```
                          Google Cloud Run Service
                      ┌─────────────────────────────────────────────────────────┐
                      │                                                         │
Client HTTPS (443) ──>│ [Envoy Container] (Ingress Port: 8000)                  │
                      │   │                                                     │
                      │   ├── /tester/* ─────────────> [Tester] 127.0.0.1:8082   │
                      │   │   (Web UI & API)                                    │
                      │   │                                                     │
                      │   ├── /v1/emulator/* ────────> [Apigee] 127.0.0.1:8080    │
                      │   │   (Management API)       (Deploy, Reset, Tree)      │
                      │   │                                                     │
                      │   └── /* (All other paths) ──> [Apigee] 127.0.0.1:8998    │
                      │       (Proxy Traffic)        (Message Processor)        │
                      │                                                         │
                      └─────────────────────────────────────────────────────────┘
```

---

### Deploying the Cloud Run Service

Deploy the multi-container configuration to Cloud Run:

```bash
./cloudrun.sh deploy-service
```

Optional flags:
```bash
./cloudrun.sh deploy-service \
  --project <GCP_PROJECT_ID> \
  --region europe-west1 \
  --service apigee-emulator
```

---

### Deploying Deployments to Cloud Run
 
Deploy [`data/deployments/deployment-1.yaml`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/data/deployments/deployment-1.yaml) directly to Cloud Run:

```bash
./cloudrun.sh data/deployments/deployment-1.yaml
```



### Testing & Tracing on Cloud Run

#### 1. Test Proxy Traffic

```bash
# Test using the built-in helper
./cloudrun.sh test /testproxy

# Or test directly with curl
CLOUDRUN_URL=$(./cloudrun.sh url)
curl -i "$CLOUDRUN_URL/testproxy" -H "x-api-key: test-app-key-123"
```

#### 2. Trace on Cloud Run

```bash
# Start trace session
./cloudrun.sh trace-start TestProxy

# Send test traffic
./cloudrun.sh test /testproxy

# Stop trace session and download trace.json
./cloudrun.sh trace-stop
```

---

### Cloud Run Management Commands

| Command | Description |
|---|---|
| `./cloudrun.sh status` | Check service health and list deployed proxies |
| `./cloudrun.sh url` | Print the active Cloud Run HTTPS URL |
| `./cloudrun.sh logs` | View live container logs |
| `./cloudrun.sh reset` | Clear deployed proxies and test data |
| `./cloudrun.sh delete` | Teardown Cloud Run service |

---

## 6. Apigee Emulator Tester (`/tester/` Web UI & Go Service)

[`apigee-emulator-service`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/main.go) is a lightweight Go service that provides automated bundle deployment, a test runner, and a developer Web UI (**"Apigee Emulator Tester"**).

### Running the Tester Service

```bash
# Build the binary
go build -o apigee-emulator-service .

# Run the service (default port 8085)
PORT=8085 ./apigee-emulator-service
```

Open your browser to:
```text
http://localhost:8085/tester/
```

---

### Web UI Features

- **Automatic Startup Deployment**: Automatically deploys all bundles in `data/bundles/*.zip` on startup and displays a waiting overlay while deployment completes.
- **Deep Linking**: Share and bookmark URLs like `http://localhost:8085/tester/?proxy=TestProxy`.
- **Vertical Trace Visualizer**: Step-by-step transaction inspector (Request &rarr; Target Request &rarr; Target Response &rarr; Response). Click any policy step to inspect flow variables and execution timing.
- **Google Access Token Injection (Cloud Run Workaround)**: Automatically obtains a Google Cloud access token (with `https://www.googleapis.com/auth/cloud-platform` scope) from the Cloud Run deployment's service account (or local ADC / gcloud) and injects it as `Authorization: Bearer <token>` into test requests whenever no authorization bearer token is present in the request headers.
- **Test Runner & History**: Run tests, evaluate assertions, and review historical test runs with downloadable results and traces.

---

### Test Suites & Assertions (from `deployment-1.yaml`)

Deployment manifests define test collections at the end of the file:

```yaml
tests:
  - name: testproxy-test1
    proxy: TestProxy
    path: /testproxy
    method: GET
    headers:
      x-api-key: test-api-key-12345
    assertions:
      - status.code == 200
```

In the Web UI:
- Selecting **TestProxy** displays available tests from the dropdown.
- Expected assertions are shown (e.g. `status.code == 200`).
- Clicking **"Send Request"** executes the test and captures live trace data.
- Clicking **"Test All"** runs the complete test suite across all proxies and records the run in the test history.

---

### REST API Reference

All endpoints are available under `/tester/api/`:

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/healthz` | Service health check |
| `GET` | `/tester/api/status` | Emulator & Cassandra readiness, deployed proxies, bundles |
| `GET` | `/tester/api/bundles` | List packaged ZIP bundles in `data/bundles/` |
| `GET` | `/tester/api/tests` | List test suites and assertions from deployment manifests |
| `POST` | `/tester/api/tests/run` | Execute tests, evaluate assertions, and record run history |
| `GET` | `/tester/api/tests/history` | List test run history (optional `?proxy=TestProxy`) |
| `GET` | `/tester/api/tests/history/:id` | Get detailed test run results, assertions, and full trace |
| `DELETE` | `/tester/api/tests/history` | Clear test history |
| `POST` | `/tester/api/deploy` | Deploy selected or all bundles (`{"bundles": ["..."], "reset": true}`) |
| `POST` | `/tester/api/reset` | Reset emulator state |
| `POST` | `/tester/api/test` | Execute an HTTP request against the proxy runtime with trace capture |
| `POST` | `/tester/api/trace/start` | Start debug trace session for a proxy |
| `GET` | `/tester/api/trace/transactions` | Retrieve recorded trace transactions |

#### Example: Deploy All Bundles via API

```bash
curl -X POST http://localhost:8085/tester/api/deploy \
  -H "Content-Type: application/json" \
  -d '{"reset": true}'
```

#### Example: Run Proxy Tests via API

```bash
curl -X POST http://localhost:8085/tester/api/tests/run \
  -H "Content-Type: application/json" \
  -d '{"proxy": "TestProxy"}'
```
