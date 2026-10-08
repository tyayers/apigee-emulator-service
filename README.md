# Apigee Emulator Service Guide

This repository provides tools, scripts, and a lightweight web service for building, testing, tracing, and deploying Apigee proxies locally or to **Google Cloud Run** using the **Apigee Local Emulator**.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [1. Creating and Starting the Apigee Emulator Container](#1-creating-and-starting-the-apigee-emulator-container)
- [2. Managing & Deploying Locally (`local.sh`)](#2-managing--deploying-locally-localsh)
  - [Interactive Menu](#interactive-menu)
  - [Starting the Emulator & Web UI](#starting-the-emulator--web-ui)
  - [Deploying Deployment Manifests Directly](#deploying-deployment-manifests-directly)
  - [Testing & Tracing Locally](#testing--tracing-locally)
  - [Local Management Commands](#local-management-commands)
- [3. Tracing Proxy Executions with `trace.html`](#3-tracing-proxy-executions-with-tracehtml)
- [4. Testing TestProxy Endpoints](#4-testing-testproxy-endpoints)
- [5. Deploying to Google Cloud Run (`cloudrun.sh`)](#5-deploying-to-google-cloud-run-cloudrunsh)
  - [Architecture Overview](#architecture-overview)
  - [Deploying the Cloud Run Service](#deploying-the-cloud-run-service)
  - [Deploying TestProxy to Cloud Run](#deploying-testproxy-to-cloud-run)
  - [Testing & Tracing on Cloud Run](#testing--tracing-on-cloud-run)
  - [Cloud Run Management Commands](#cloud-run-management-commands)
- [6. Apigee Emulator Tester (`/tester/` Web UI & Bun TypeScript Service)](#6-apigee-emulator-tester-tester-web-ui--bun-typescript-service)
  - [Running the Tester Service](#running-the-tester-service)
  - [Web UI Features](#web-ui-features)
  - [Test Suites & Assertions (from `deployment-1.yaml`)](#test-suites--assertions-from-deployment-1yaml)
  - [REST API Reference](#rest-api-reference)
  - [Running Unit & Integration Tests](#running-unit--integration-tests)

---

## Prerequisites

The following tools are required in your Linux / Cloud Shell environment:

1. **Bun (v1.1+)** – Fast JavaScript & TypeScript runtime used for the test runner and deployment compiler:
   ```bash
   curl -fsSL https://bun.sh/install | bash
   export PATH="$HOME/.bun/bin:$PATH"
   ```
2. **Apigee Templater (`aft`)** – CLI tool for compiling and bundling Apigee proxies:
   ```bash
   curl -sSL https://raw.githubusercontent.com/apigee/apigee-templater/main/install.sh | bash
   export PATH="$HOME/.local/bin:$HOME/.aft/bin:$PATH"
   ```
3. **Docker** – Required for running the Apigee Local Emulator container:
   ```bash
   docker --version
   ```
4. **cURL & jq** – CLI utilities for HTTP requests and JSON formatting:
   ```bash
   sudo apt-get update && sudo apt-get install -y curl jq
   ```
5. **Google Cloud SDK (`gcloud`)** – Optional, required when deploying to Google Cloud Run or auto-detecting `GOOGLE_CLOUD_PROJECT`.

---

## 1. Creating and Starting the Apigee Emulator Container

The Apigee Emulator runs as a local Docker container exposing management endpoints and runtime proxy traffic.

### Create the Container

Run [`create.sh`](create.sh):

```bash
./create.sh
```

Or execute the Docker command directly:

```bash
docker create --name apigee \
  -p 8080:8080 \
  -p 8888:8998 \
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
- **Port `8888`**: Apigee Message Processor Runtime (proxy traffic, mapped to container port 8998).

---

## 2. Managing & Deploying Locally (`local.sh`)

[`local.sh`](local.sh) is the local counterpart to `cloudrun.sh`. It automatically discovers or accepts your GCP Project ID, substitutes `{GOOGLE_CLOUD_PROJECT}` in deployment manifests, manages the Docker emulator container, compiles and deploys resources using Bun TypeScript, and provides commands for testing and tracing.

Each menu item (1–10) in `./local.sh` has a corresponding `--parameter` flag that can be passed directly from the CLI.

### Interactive Menu
Run `./local.sh` with no arguments to bring up the interactive console:
```bash
./local.sh
```

### Starting the Emulator & Web UI (Option 1)
Start the Apigee emulator container and launch the Bun TypeScript tester server in the background:
```bash
./local.sh --start

# Or with live auto-reload on file edits:
./local.sh --start --dev
```

### Deploying Deployment Manifests Directly (Options 2 & 3)
Deploy a deployment YAML with automatic GCP project substitution:
```bash
# Deploys default data/deployments/deployment-1.yaml (Option 2):
./local.sh --deploy

# Deploys a specific deployment YAML:
./local.sh --deploy data/deployments/deployment-1.yaml

# Or explicitly specify the GCP Project ID:
./local.sh --deploy --project my-gcp-project data/deployments/deployment-1.yaml

# Deploy all deployments in data/deployments/ at once (Option 3):
./local.sh --deploy-all
```

### Testing & Tracing Locally (Option 4)
```bash
# Run tests for all deployed proxies (Option 4):
./local.sh --test

# Run tests for a specific proxy:
./local.sh --test REST-AI-Interactions

# Start a trace session for a proxy:
./local.sh --trace-start REST-AI-Interactions

# Stop trace and save to trace.json:
./local.sh --trace-stop
```

### Local Management Commands (Menu Options 1–10)

| Option | CLI Flag Parameter | Positional Command | Description |
|---|---|---|---|
| **1** | `./local.sh --start` / `--up` | `./local.sh start` / `up` | Start emulator container and launch Bun server in background |
| **2** | `./local.sh --deploy [FILE]` | `./local.sh deploy [FILE]` | Deploy deployment YAML with `{GOOGLE_CLOUD_PROJECT}` substitution (default: `deployment-1.yaml`) |
| **3** | `./local.sh --deploy-all` | `./local.sh deploy-all` / `-a` | Deploy all deployments in `data/deployments/` |
| **4** | `./local.sh --test [PROXY]` | `./local.sh test [PROXY]` | Execute proxy tests and assertion evaluations |
| **5** | `./local.sh --status` | `./local.sh status` | Check Docker container, emulator health, and deployed proxies |
| **6** | `./local.sh --ui` / `--tester` | `./local.sh tester` / `ui` | Open Tester Web UI at `http://localhost:8082/tester/` in browser |
| **7** | `./local.sh --reset` | `./local.sh reset` | Clear deployed proxies and reset emulator state via API |
| **8** | `./local.sh --recreate` | `./local.sh recreate` | Destroy and recreate emulator container with fresh state (`-p 8888:8998`) |
| **9** | `./local.sh --clean` | `./local.sh clean` | Remove generated assets, reset emulator, or start fresh (`clean.sh`) |
| **10** | `./local.sh --stop` | `./local.sh stop` | Stop all services (emulator Docker container & local tester) |
| — | `./local.sh --logs` | `./local.sh logs` | Follow Docker container logs |
| — | `./local.sh --trace-start [P]` | `./local.sh trace-start [P]` | Start debug trace session for proxy |
| — | `./local.sh --trace-stop` | `./local.sh trace-stop` | Stop trace session and save transactions to `trace.json` |

---

### Cloud Run Management Commands (`cloudrun.sh` Menu Options 1–10)

| Option | CLI Flag Parameter | Positional Command | Description |
|---|---|---|---|
| **1** | `./cloudrun.sh --deploy-service` / `--start` | `./cloudrun.sh deploy-service` | Deploy Envoy + Apigee Emulator + Manager + all deployments to Cloud Run |
| **2** | `./cloudrun.sh --deploy [FILE]` | `./cloudrun.sh deploy [FILE]` | Deploy default (`deployment-1.yaml`) or specified deployment / bundle |
| **3** | `./cloudrun.sh --browse-deployments` | — | Browse and select a deployment YAML to deploy |
| **4** | `./cloudrun.sh --browse-bundles` | — | Browse and select a ZIP bundle to deploy |
| **5** | `./cloudrun.sh --deploy-all` / `-a` | `./cloudrun.sh deploy-all` | Deploy all deployments in `data/deployments/` to Cloud Run |
| **6** | `./cloudrun.sh --status` | `./cloudrun.sh status` | Check Cloud Run service URL, health, and deployed proxies |
| **7** | `./cloudrun.sh --test [PATH]` | `./cloudrun.sh test [PATH]` | Send a test request to deployed proxy (default: `/testproxy`) |
| **8** | `./cloudrun.sh --trace-start [P]` | `./cloudrun.sh trace-start [P]` | Start debug trace recording session on Cloud Run |
| **9** | `./cloudrun.sh --trace-stop` | `./cloudrun.sh trace-stop` | Stop trace session and download `trace.json` |
| **10** | `./cloudrun.sh --tester` / `--ui` | `./cloudrun.sh tester` / `ui` | Display and open Cloud Run Tester Web UI in browser |
| — | `./cloudrun.sh --logs` | `./cloudrun.sh logs` | Tail Cloud Run service logs |
| — | `./cloudrun.sh --reset` | `./cloudrun.sh reset` | Reset Apigee emulator state on Cloud Run |
| — | `./cloudrun.sh --delete` | `./cloudrun.sh delete` | Delete the Cloud Run service |

To execute complete deployment to Cloud Run in one non-interactive command:
```bash
./cloudrun.sh --deploy-service --project <PROJECT_ID> --parameters "GEMINI_API_KEY=<KEY>"
```

---

## 3. Tracing Proxy Executions with `trace.html`

The emulator includes built-in debug tracing. You can record execution traces and view them interactively in [`trace.html`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/trace.html).

### Step 1: Start a Trace Session

```bash
./emulator/trace_start.sh TestProxy
```

### Step 2: Send Request to Proxy

```bash
curl -i http://localhost:8888/testproxy
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

Once `TestProxy` is deployed, it listens on port **8888** with basepath `/testproxy`.

### 1. Basic Request

```bash
curl -i http://localhost:8888/testproxy
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
curl -i "http://localhost:8888/testproxy?message=from-Apigee"
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
curl -i http://localhost:8888/testproxy/json
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
curl -i "http://localhost:8888/testproxy" \
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

## 6. Apigee Emulator Tester (`/tester/` Web UI & Bun TypeScript Service)

`apigee-emulator-service` is a Bun TypeScript service that provides automated template and deployment YAML conversion, bundle deployment, a test runner, and a developer Web UI (**"Apigee Emulator Tester"**).

### Running the Tester Service

```bash
# Install dependencies
bun install

# Start the service (default port 8082, or specify PORT)
bun run start

# Or run in development mode with live watch/reload
bun run dev

# Or deploy a deployment manifest and run tests directly in CLI mode
bun run src/index.ts --deploy data/deployments/deployment-1.yaml --no-server
```

Open your browser to:
```text
http://localhost:8082/tester/
```

---

### Web UI Features

- **Automatic Startup Deployment**: Automatically deploys all bundles in `data/bundles/*.zip` on startup and displays a waiting overlay while deployment completes.
- **Deep Linking**: Share and bookmark URLs like `http://localhost:8082/tester/?proxy=REST-AI-Interactions`.
- **Vertical Trace Visualizer**: Step-by-step transaction inspector (Request &rarr; Target Request &rarr; Target Response &rarr; Response). Click any policy step to inspect flow variables and execution timing.
- **Google Access Token Injection (Cloud Run Workaround)**: Automatically obtains a Google Cloud access token (with `https://www.googleapis.com/auth/cloud-platform` scope) from the Cloud Run deployment's service account (or local ADC / gcloud) and injects it as `Authorization: Bearer <token>` into test requests whenever no authorization bearer token is present in the request headers.
- **Test Runner & History**: Run tests, evaluate assertions, and review historical test runs with downloadable results and traces.

---

### Test Suites & Assertions (from `deployment-1.yaml`)

Deployment manifests define test collections at the end of the file:

```yaml
tests:
  - name: interactions-test1
    description: Tests the Gemini Interactions API
    proxy: REST-AI-Interactions
    path: /v1beta/interactions
    method: POST
    headers:
      x-api-key: test-app-key-123
    body: |
      {
        "model": "gemini-3.5-flash-lite",
        "input": "What is the capital of France?"
      }
    assertions:
      - response.status == 200
```

In the Web UI:
- Selecting **REST-AI-Interactions** displays available tests from the dropdown.
- Expected assertions are shown (e.g. `response.status == 200`).
- Clicking **"Send Request"** executes the test and captures live trace data.
- Clicking **"Test All"** runs the complete test suite across all proxies and records the run in the test history.

---

### REST API Reference

All endpoints are available under `/tester/api/`:

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/healthz` | Service health check |
| `GET` | `/tester/api/status` | Emulator readiness, deployed proxies, products, apps, bundles |
| `GET` | `/tester/api/bundles` | List packaged ZIP bundles in `data/bundles/` |
| `GET` | `/tester/api/deployments` | List available deployment YAML manifests |
| `GET` | `/tester/api/tests` | List test suites and assertions from deployment manifests |
| `POST` | `/tester/api/tests/run` | Execute tests, evaluate assertions, and record run history |
| `GET` | `/tester/api/tests/history` | List test run history (optional `?proxy=ProxyName`) |
| `GET` | `/tester/api/tests/history/:id` | Get detailed test run results, assertions, and full trace |
| `DELETE` | `/tester/api/tests/history` | Clear test history |
| `POST` | `/tester/api/deploy` | Deploy deployment YAML (`{"yaml": "...", "reset": true}`) or bundles (`{"bundles": ["..."], "reset": true}`) |
| `POST` | `/tester/api/reset` | Reset emulator state |
| `POST` | `/tester/api/test` | Execute an HTTP request against the proxy runtime with trace capture |
| `POST` | `/tester/api/trace/start` | Start debug trace session for a proxy |
| `GET` | `/tester/api/trace/transactions` | Retrieve recorded trace transactions |

#### Example 1: Deploy a Deployment Manifest via API

```bash
# Convert and deploy deployment YAML directly
curl -X POST http://localhost:8082/tester/api/deploy \
  -H "Content-Type: application/json" \
  -d "{\"yaml\": $(jq -Rs . < data/deployments/deployment-1.yaml), \"reset\": true}"
```

#### Example 2: Deploy All Existing Bundles via API

```bash
curl -X POST http://localhost:8082/tester/api/deploy \
  -H "Content-Type: application/json" \
  -d '{"reset": true}'
```

#### Example 3: Run Proxy Tests via API

```bash
curl -X POST http://localhost:8082/tester/api/tests/run \
  -H "Content-Type: application/json" \
  -d '{"proxy": "REST-AI-Interactions"}'
```

---

### Running Unit & Integration Tests

Run the built-in Bun test suite:
```bash
bun test
```

