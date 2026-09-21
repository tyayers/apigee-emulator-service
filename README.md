# Apigee Emulator Service Guide

This repository contains setup scripts, deployment manifests, test data configurations, and tracing tools for developing, testing, and deploying Apigee proxies locally or to **Google Cloud Run** using the **Apigee Local Emulator**.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [1. Creating and Starting the Apigee Emulator Container (Local)](#1-creating-and-starting-the-apigee-emulator-container)
- [2. Deploying Proxies and Test Data Locally (`deploy.sh`)](#2-deploying-proxies-and-test-data-deploysh)
- [3. Tracing Proxy Executions and Using `trace.html`](#3-tracing-proxy-executions-and-using-tracehtml)
- [4. Test Commands: OpenAI `/v1/chat/completions` API](#4-local-test-commands-openai-v1chatcompletions-api)
- [5. Deploying to Google Cloud Run (`cloudrun.sh` & `cloudrun-service.yaml`)](#5-deploying-to-google-cloud-run-cloudrunsh--cloudrun-serviceyaml)
  - [Architecture & Port Routing](#architecture--port-routing)
  - [Cloud Run Prerequisites](#cloud-run-prerequisites)
  - [Step 1: Deploy Service to Cloud Run](#step-1-deploy-service-to-cloud-run)
  - [Step 2: Deploy Proxies & Bundles to Cloud Run](#step-2-deploy-proxies--bundles-to-cloud-run)
  - [Step 3: Test Proxy Traffic on Cloud Run](#step-3-test-proxy-traffic-on-cloud-run)
  - [Step 4: Tracing Proxy Executions on Cloud Run](#step-4-tracing-proxy-executions-on-cloud-run)
  - [Step 5: Cloud Run Service Management](#step-5-cloud-run-service-management)
  - [Interactive Menu Reference](#interactive-menu-reference)
- [6. Apigee Emulator Tester (`apigee-emulator-service` & Web UI)](#6-apigee-emulator-tester-apigee-emulator-service--web-ui)
  - [Architecture](#architecture-1)
  - [Running the Tester Locally](#running-the-tester-locally)
  - [Using the Web Tester UI (`/tester/`)](#using-the-web-tester-ui-tester)
  - [Backend REST API Reference](#backend-rest-api-reference)
  - [Containerization & Cloud Run Sidecar Deployment](#containerization--cloud-run-sidecar-deployment)

---

## Prerequisites

- **Docker** installed and running (for local emulator)
- **Google Cloud SDK (`gcloud`)** installed and authenticated (for Cloud Run)
- **AFT (Apigee Templater)** CLI tool installed
- **cURL** & **jq**
- **Python 3** with `pyyaml` (`pip install pyyaml`)

---

## 1. Creating and Starting the Apigee Emulator Container

The Apigee Emulator runs as a local Docker container exposing management endpoints and proxy routes.

### Create the Container
To create the Docker container instance, run:

```bash
./create.sh
```

Or run the Docker command directly:

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
- **Port `8998`**: Apigee Message Processor Runtime (all proxy basepath traffic).

---

## 2. Deploying Proxies and Test Data Locally (`deploy.sh`)

The [`deploy.sh`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/deploy.sh) script compiles AFT YAML files into proxy bundles, generates environment configs, packages local test data, and deploys everything into the local emulator.

### Run Deployment

```bash
# Deploy default TestProxy
./deploy.sh proxies/TestProxy.yaml

# Deploy an AI template
./deploy.sh templates/REST-AI-Completions.yaml

# Deploy all templates
./deploy.sh --all

# Or run interactively
./deploy.sh
```

### What `deploy.sh` Does
1. **Compiles Proxies**: Uses `aft` to build proxy bundles and extracts them into `dist/bundle/`.
2. **Generates Environment Configuration**: Creates minimal `env.json` and `deployments.json` for environment `test`.
3. **Deploys Test Data**: Packages local test data files ([`datacollectors.json`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/datacollectors.json), [`developerapps.json`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/developerapps.json), [`developers.json`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/developers.json), [`maps.json`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/maps.json), [`products.json`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/products.json)) and posts them to `http://localhost:8080/v1/emulator/setup/tests`.
4. **Deploys Proxy Bundle**: Packages `bundle.zip` and posts it to `http://localhost:8080/v1/emulator/deploy?environment=test`.

---

## 3. Tracing Proxy Executions and Using `trace.html`

The Apigee Emulator includes a built-in tracing facility. You can record execution traces and view them interactively in [`trace.html`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/trace.html).

### Step 1: Start a Trace Session
Start a trace session for the active proxy (e.g. `TestProxy` or `REST-AI-Completions`):

```bash
./trace_start.sh TestProxy
```

### Step 2: Send Request(s)
Send API requests to your proxy endpoint (e.g., `http://localhost:8998/testproxy` or `http://localhost:8998/v1/chat/completions`).

### Step 3: Fetch Trace Transactions
Stop tracing and save recorded transactions to `trace.json`:

```bash
./trace_stop.sh
```

### Step 4: Inspect in Visualizer (`trace.html`)
Open [`trace.html`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/trace.html) in any web browser:

- Click **"Open trace.json"** and select `trace.json` (or drag and drop the file).
- Inspect request details, execution step timelines, policy execution states, OAS validation, KVM lookups, JavaScript variables, and DataCapture metrics.

### Useful Management & Inspection Commands

```bash
# Get deployment tree (installed proxies and status)
curl -s "http://localhost:8080/v1/emulator/tree" | jq .

# Get loaded KVM maps in test environment
curl -s "http://localhost:8080/v1/emulator/test/maps" | jq .

# Reset emulator (clears deployed proxies & test data)
curl -s -X POST "http://localhost:8080/v1/emulator/reset"
```

---

## 4. Local Test Commands: OpenAI `/v1/chat/completions` API

The default test deployment uses the OpenAI Chat Completions proxy (`/v1/chat/completions`).

- **Endpoint**: `http://localhost:8080/v1/chat/completions`
- **Authentication**: `x-api-key: test-api-key-12345` (configured in `developerapps.json`)
- **Configured Models** (from `products.json`):
  - `gemini-3.6-flash`
  - `claude-sonnet-5`
  - `gemini-3.6-flash-lite`

Below are `curl` test commands covering operations supported by the OpenAI Chat Completions API specification:

### 1. Basic Chat Completion (Non-Streaming)

```bash
curl -i -X POST "http://localhost:8080/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "x-api-key: test-api-key-12345" \
  -d '{
    "model": "gemini-3.6-flash",
    "messages": [
      {
        "role": "user",
        "content": "Explain quantum computing in one concise sentence."
      }
    ]
  }'
```

---

### 2. Streaming Chat Completion (`stream: true`)

```bash
curl -i -N -X POST "http://localhost:8080/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "x-api-key: test-api-key-12345" \
  -d '{
    "model": "gemini-3.6-flash",
    "stream": true,
    "messages": [
      {
        "role": "user",
        "content": "Write a short 4-line poem about space exploration."
      }
    ]
  }'
```

---

### 3. System Prompt & Hyperparameter Sampling (`temperature`, `top_p`, `seed`)

```bash
curl -i -X POST "http://localhost:8080/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "x-api-key: test-api-key-12345" \
  -d '{
    "model": "gemini-3.6-flash",
    "temperature": 0.7,
    "top_p": 0.95,
    "seed": 42,
    "messages": [
      {
        "role": "system",
        "content": "You are a helpful software engineering assistant who answers strictly in bullet points."
      },
      {
        "role": "user",
        "content": "What are 3 benefits of using microservices?"
      }
    ]
  }'
```

---

### 4. Multi-Turn Conversation History

```bash
curl -i -X POST "http://localhost:8080/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "x-api-key: test-api-key-12345" \
  -d '{
    "model": "gemini-3.6-flash",
    "messages": [
      {
        "role": "system",
        "content": "You are a helpful assistant."
      },
      {
        "role": "user",
        "content": "My favorite fruit is mangos."
      },
      {
        "role": "assistant",
        "content": "Mangos are delicious and full of vitamins! How can I help you today?"
      },
      {
        "role": "user",
        "content": "What is my favorite fruit?"
      }
    ]
  }'
```

---

### 5. Alternative Model Test: Claude Sonnet 5

```bash
curl -i -X POST "http://localhost:8080/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "x-api-key: test-api-key-12345" \
  -d '{
    "model": "claude-sonnet-5",
    "messages": [
      {
        "role": "user",
        "content": "Summarize the theory of relativity in 20 words or less."
      }
    ]
  }'
```

---

### 6. Alternative Model Test: Gemini 3.6 Flash Lite

```bash
curl -i -X POST "http://localhost:8080/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "x-api-key: test-api-key-12345" \
  -d '{
    "model": "gemini-3.6-flash-lite",
    "messages": [
      {
        "role": "user",
        "content": "Give me a synonym for fast."
      }
    ]
  }'
```

---

### 7. Structured Output / JSON Mode (`response_format`)

```bash
curl -i -X POST "http://localhost:8080/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "x-api-key: test-api-key-12345" \
  -d '{
    "model": "gemini-3.6-flash",
    "response_format": { "type": "json_object" },
    "messages": [
      {
        "role": "system",
        "content": "You are a helpful assistant designed to output JSON."
      },
      {
        "role": "user",
        "content": "List 3 capitals of European countries in JSON format with keys country and capital."
      }
    ]
  }'
```

---

### 8. Tool / Function Calling (`tools` and `tool_choice`)

```bash
curl -i -X POST "http://localhost:8080/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "x-api-key: test-api-key-12345" \
  -d '{
    "model": "gemini-3.6-flash",
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "get_current_weather",
          "description": "Get the current weather for a given location",
          "parameters": {
            "type": "object",
            "properties": {
              "location": {
                "type": "string",
                "description": "The city and state, e.g. San Francisco, CA"
              },
              "unit": {
                "type": "string",
                "enum": ["celsius", "fahrenheit"]
              }
            },
            "required": ["location"]
          }
        }
      }
    ],
    "tool_choice": "auto",
    "messages": [
      {
        "role": "user",
        "content": "What is the weather like in Tokyo right now?"
      }
    ]
  }'
```

---

### 9. Submitting Tool Call Output (Function Response)

```bash
curl -i -X POST "http://localhost:8080/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "x-api-key: test-api-key-12345" \
  -d '{
    "model": "gemini-3.6-flash",
    "messages": [
      {
        "role": "user",
        "content": "What is the weather like in Tokyo?"
      },
      {
        "role": "assistant",
        "tool_calls": [
          {
            "id": "call_12345",
            "type": "function",
            "function": {
              "name": "get_current_weather",
              "arguments": "{\"location\": \"Tokyo\"}"
            }
          }
        ]
      },
      {
        "role": "tool",
        "tool_call_id": "call_12345",
        "content": "{\"temperature\": \"18C\", \"condition\": \"Sunny\"}"
      }
    ]
  }'
```

---

### 10. Multimodal Input (Text + Image URL)

```bash
curl -i -X POST "http://localhost:8080/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "x-api-key: test-api-key-12345" \
  -d '{
    "model": "gemini-3.6-flash",
    "messages": [
      {
        "role": "user",
        "content": [
          {
            "type": "text",
            "text": "What is depicted in this image?"
          },
          {
            "type": "image_url",
            "image_url": {
              "url": "https://upload.wikimedia.org/wikipedia/commons/thumb/d/dd/Gfp-wisconsin-madison-the-nature-boardwalk.jpg/2560px-Gfp-wisconsin-madison-the-nature-boardwalk.jpg"
            }
          }
        ]
      }
    ]
  }'
```

---

### 11. Generation Limits & Penalties (`max_tokens`, `stop`, `presence_penalty`, `frequency_penalty`)

```bash
curl -i -X POST "http://localhost:8080/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "x-api-key: test-api-key-12345" \
  -d '{
    "model": "gemini-3.6-flash",
    "max_tokens": 50,
    "presence_penalty": 0.5,
    "frequency_penalty": 0.5,
    "stop": ["END", "\n\n"],
    "messages": [
      {
        "role": "user",
        "content": "Count from 1 to 20 slowly."
      }
    ]
  }'
```

---

## 5. Deploying to Google Cloud Run (`cloudrun.sh` & `cloudrun-service.yaml`)

You can run the Apigee Emulator on **Google Cloud Run** using a multi-container deployment (sidecar architecture). This allows hosting a persistent Apigee Emulator in the cloud to test proxies, automate CI/CD pipeline validations, or share an emulator instance with your team.

---

### Architecture & Port Routing

Cloud Run terminates external HTTPS requests on port **443** and forwards traffic to a single designated ingress container port. 

Because the Apigee Emulator listens on two separate internal ports—**8080** for the Management API and **8998** for runtime proxy traffic—we deploy an **Envoy reverse proxy** as the ingress container. Both containers run in the same Cloud Run instance pod and communicate over `localhost`:

```
                          Google Cloud Run Service
                      ┌─────────────────────────────────────────────────────────┐
                      │                                                         │
Client HTTPS (443) ──>│ [Envoy Container] (Ingress Port: 8000)                  │
                      │   │                                                     │
                      │   ├── /v1/emulator/* ──────> [Apigee] 127.0.0.1:8080    │
                      │   │   (Management API)       (Deploy, Reset, Tree, etc.)│
                      │   │                                                     │
                      │   ├── x-apigee-target: mgmt ─> [Apigee] 127.0.0.1:8080   │
                      │   │                                                     │
                      │   └── /* (All other paths) ─> [Apigee] 127.0.0.1:8998    │
                      │       (Proxy Traffic)        (Message Processor)        │
                      │                                                         │
                      └─────────────────────────────────────────────────────────┘
```

#### Key Architecture Specifications ([`cloudrun-service.yaml`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/cloudrun-service.yaml))

- **Ingress Container (`envoy`)**:
  - Image: `docker.io/envoyproxy/envoy:v1.31-latest`
  - Ingress Port: `8000` (Cloud Run maps external HTTPS port 443 here).
  - Routes `/v1/emulator/*` and `/emulator/*` to Management (`127.0.0.1:8080`).
  - Routes all proxy runtime paths (`/*`) to Apigee Message Processor (`127.0.0.1:8998`).
  - `stream_idle_timeout: 0s` and upstream `timeout: 0s` to support long-running LLM streaming responses (Server-Sent Events).
  - `per_connection_buffer_limit_bytes: 104857600` (100MB) to allow large proxy bundles and test data uploads without `413 Payload Too Large`.
  - Native health check endpoint `/healthz` returning direct `200 OK`.
- **Sidecar Container (`apigee`)**:
  - Image: `gcr.io/apigee-release/hybrid/apigee-emulator:2.0.1`
  - Resources: `2000m` CPU limits, `4Gi` RAM.
  - Startup Probe: TCP check on port `8080` to allow the internal Cassandra datastore 15–25s to initialize before Envoy opens traffic.
- **Service Annotations**:
  - `run.googleapis.com/execution-environment: gen2` (Required for multi-container).
  - `run.googleapis.com/container-dependencies: '{"envoy":["apigee"]}'` (Guarantees Envoy waits for Apigee to be fully healthy).
  - `autoscaling.knative.dev/minScale: "1"` & `maxScale: "1"` with `run.googleapis.com/cpu-throttling: "false"` (Ensures the container instance remains warm so deployed proxies and Cassandra state are preserved).

---

### Cloud Run Prerequisites

Before deploying to Cloud Run, ensure you have:

1. **Google Cloud SDK (`gcloud`)** installed and authenticated:
   ```bash
   gcloud auth login
   gcloud config set project <YOUR_PROJECT_ID>
   ```
2. **Cloud Run API** enabled in your GCP project:
   ```bash
   gcloud services enable run.googleapis.com
   ```
3. Required local tools installed: `aft`, `python3` (with `pyyaml`), `curl`, `zip`, `unzip`, `jq`.

---

### Step 1: Deploy Service to Cloud Run

Use [`cloudrun.sh`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/cloudrun.sh) to deploy the Envoy + Apigee multi-container service to Cloud Run:

```bash
./cloudrun.sh deploy-service
```

#### Custom Project, Region, or Service Name
You can pass custom parameters or set environment variables:

```bash
# Via CLI flags:
./cloudrun.sh deploy-service \
  --project my-gcp-project \
  --region europe-west1 \
  --service apigee-emulator

# Or via environment variables:
export GCP_PROJECT="my-gcp-project"
export GCP_REGION="europe-west1"
export SERVICE_NAME="apigee-emulator"
./cloudrun.sh deploy-service
```

#### What the Command Does:
1. Deploys the multi-container configuration from [`cloudrun-service.yaml`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/cloudrun-service.yaml) via `gcloud run services replace`.
2. Binds `roles/run.invoker` to `allUsers` to permit direct HTTP access (or informs you if your organization policy enforces authenticated calls).
3. Polls the Cloud Run HTTPS service URL (`/v1/emulator/tree`) until Apigee passes startup checks.
4. Caches the resulting Cloud Run service URL in `.cloudrun_url` so future proxy deployments target it automatically.

---

### Step 2: Deploy Proxies & Bundles to Cloud Run

The [`cloudrun.sh`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/cloudrun.sh) script automatically handles compilation, packaging, test data injection, and uploading to your Cloud Run emulator. It supports both **AFT YAML files** and **pre-built ZIP bundles**.

#### Deploying AFT YAML Files (Proxies, Templates, Features)

```bash
# 1. Deploy the basic test proxy
./cloudrun.sh proxies/TestProxy.yaml

# 2. Deploy the OpenAI AI Chat Completions template
./cloudrun.sh templates/REST-AI-Completions.yaml

# 3. Deploy a specific feature proxy
./cloudrun.sh features/ai-endpoint-completions.yaml

# 4. Deploy multiple YAML proxies together
./cloudrun.sh proxies/TestProxy.yaml templates/REST-AI-Completions.yaml

# 5. Deploy ALL templates in the templates/ folder at once
./cloudrun.sh --all
```

#### Deploying Pre-Built ZIP Bundles

If you already have exported Apigee bundles:

```bash
# Deploy an Apigee proxy bundle ZIP (containing apiproxy/...)
./cloudrun.sh dist/TestProxy.zip

# Deploy an Apigee environment bundle ZIP (containing src/main/apigee/...)
./cloudrun.sh path/to/environment-bundle.zip
```

#### What Happens During Proxy Deployment:
1. **Compilation**: YAML files are compiled to Apigee bundles via `aft` (TargetEndpoints are automatically sanitized to prevent routing conflicts).
2. **Bundle Generation**: Assembles `env.json` and `deployments.json` for environment `test`.
3. **Dynamic API Product Authorization**: Inspects all deployed proxies and injects them into [`products.json`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/products.json) with appropriate model configurations so that the test API key is authorized immediately.
4. **Emulator Reset & Setup**: Calls `POST <CLOUDRUN_URL>/v1/emulator/reset` and uploads [`testdata.zip`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/dist/testdata.zip) to `<CLOUDRUN_URL>/v1/emulator/setup/tests`.
5. **Deployment**: Uploads `bundle.zip` to `<CLOUDRUN_URL>/v1/emulator/deploy?environment=test`.
6. **Summary**: Queries `<CLOUDRUN_URL>/v1/emulator/tree` and prints all active endpoints on Cloud Run.

---

### Step 3: Test Proxy Traffic on Cloud Run

Once deployed, traffic is routed through Envoy directly to the Apigee Message Processor on Cloud Run.

#### Using the Built-In Test Helper:

```bash
./cloudrun.sh test /testproxy
```

#### Using `curl` Directly with Cloud Run HTTPS URL:

```bash
# Retrieve the service URL
CLOUDRUN_URL=$(./cloudrun.sh url)

# 1. Test basic proxy
curl -i "$CLOUDRUN_URL/testproxy" \
  -H "x-api-key: test-api-key-12345"

# 2. Test OpenAI Chat Completions (REST-AI-Completions proxy)
curl -i -X POST "$CLOUDRUN_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "x-api-key: test-api-key-12345" \
  -d '{
    "model": "gemini-3.6-flash",
    "messages": [
      {
        "role": "user",
        "content": "Hello from Cloud Run!"
      }
    ]
  }'

# 3. Test Streaming SSE Chat Completion (timeout: 0s supported by Envoy)
curl -N -i -X POST "$CLOUDRUN_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "x-api-key: test-api-key-12345" \
  -d '{
    "model": "gemini-3.6-flash",
    "stream": true,
    "messages": [
      {
        "role": "user",
        "content": "Tell me a short poem about the cloud."
      }
    ]
  }'
```

#### Authenticated Cloud Run Services (`--auth`)
If your organization requires IAM authentication (blocks `allUsers`), add `--auth` to automatically attach a GCP identity token:

```bash
./cloudrun.sh test /testproxy --auth
```
Or with manual `curl`:
```bash
curl -i "$CLOUDRUN_URL/testproxy" \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  -H "x-api-key: test-api-key-12345"
```

---

### Step 4: Tracing Proxy Executions on Cloud Run

You can record execution traces on Cloud Run and visualize them locally in [`trace.html`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/trace.html).

#### 1. Start Trace Session on Cloud Run
```bash
./cloudrun.sh trace-start TestProxy
# (Or omit proxy name to auto-detect the active proxy)
```

#### 2. Send Test Traffic
```bash
./cloudrun.sh test /testproxy
# Or send your curl request to $CLOUDRUN_URL
```

#### 3. Stop Trace & Download `trace.json`
```bash
./cloudrun.sh trace-stop
```
This fetches all trace transactions from Cloud Run and writes them to [`trace.json`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/trace.json).

#### 4. Visualize Transactions
Open [`trace.html`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/trace.html) in your browser:
```bash
# On Linux:
xdg-open trace.html

# On macOS:
open trace.html
```
Click **"Open trace.json"** and select `trace.json` to inspect step-by-step policy execution timelines, latency, and variables.

---

### Step 5: Cloud Run Service Management

| Command | Description |
|---|---|
| `./cloudrun.sh status` | Check service health (`/healthz`) and list deployed proxies (`/v1/emulator/tree`). |
| `./cloudrun.sh url` | Print the active Cloud Run service HTTPS URL. |
| `./cloudrun.sh logs` | Tail live logs from both Envoy and Apigee containers in Cloud Run. |
| `./cloudrun.sh reset` | Clear all deployed proxies and test data from the Cloud Run emulator. |
| `./cloudrun.sh delete` | Teardown and delete the Cloud Run service from your GCP project. |
| `./cloudrun.sh --list` | List all available local proxies, templates, and features. |

---

### Interactive Menu Reference

Running [`./cloudrun.sh`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/cloudrun.sh) with no arguments launches an interactive terminal interface:

```text
================================================================
             Apigee Emulator on Cloud Run Menu                 
================================================================
Current Service URL: https://apigee-emulator-xxxxxx-ew.a.run.app

  1) Deploy Containers to Cloud Run (Envoy + Apigee Emulator)
  2) Deploy default proxy (proxies/TestProxy.yaml)
  3) Browse & deploy proxies (proxies/*.yaml)
  4) Browse & deploy templates (templates/*.yaml)
  5) Browse & deploy features (features/*.yaml)
  6) Browse & deploy ZIP bundles (dist/*.zip)
  7) Deploy ALL templates
  8) Check Cloud Run service status & active endpoints
  9) Test proxy traffic (/testproxy)
 10) Start trace recording
 11) Stop trace recording & save trace.json
 12) Open Apigee Emulator Tester Web UI (/tester/)
  Q) Quit

Enter selection [1-12, Q] (default 1):
```

---

### 6. Apigee Emulator Tester (`apigee-emulator-service` & Web UI)

[`apigee-emulator-service`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/main.go) is a lightweight Go service (zero heavy external dependencies) that provides programmatic management, deployment orchestration, and an interactive developer Web UI (**"Apigee Emulator Tester"**) for the Apigee Local Emulator.

### Features Overview

- **Interactive Web UI (`/tester/`)**: Clean, responsive developer interface inspired by Postman.
- **Deep Linking & Shareable URLs**: Pass `?proxy=ProxyName` in the URL to automatically select and configure a proxy. Clicking any proxy immediately updates the URL for seamless sharing and refreshing.
- **Proxy & Bundle Management**:
  - Live status indicator showing Apigee Emulator and Cassandra database readiness.
  - One-click deployment of pre-packaged bundles (`data/bundles/*.zip`) with automatic bundle sanitization (ensures compatible `<RouteRule>` endpoints and strips unsupported local auth configurations).
  - Synchronizes dynamic test environment configs, API products, and developer app credentials (`starter-app-key-123`, `test-api-key-12345`).
- **Postman-like Test Runner**:
  - Select any deployed proxy and HTTP method (`GET`, `POST`, `PUT`, `DELETE`, etc.).
  - Load pre-configured sample request presets defined in [`data/deployments/`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/data/deployments/).
  - Custom header key-value table and JSON request body editor.
  - Real-time response inspection: HTTP status code, response time (ms), response payload size, formatted JSON body, and response headers.
- **Built-in Rich Vertical Trace Visualizer**:
  - Automatically activates an Apigee debug trace session when sending test traffic.
  - Parses transaction events into a vertical execution pipeline (Request PreFlow &rarr; Target Request &rarr; Target Response &rarr; Client Response).
  - Shows total policy execution time, status, and target flow.
  - Click any policy step (e.g. `OAS-Validation`, `KVM-LoadConfig`, `VA-VerifyKey`, `JS-TransformPayload`) to toggle an expanded inspector showing all extracted variables, properties, and runtime conditions.
  - Includes a Raw JSON viewer and one-click download for `trace.json`.

---

### Running the Service Locally

#### 1. Compile and Run with Go

```bash
# Build the binary
go build -o apigee-emulator-service .

# Start the service (runs on port 8085 by default or configured via PORT)
PORT=8085 ./apigee-emulator-service
```

#### 2. Access the Web UI

Open your browser to:
```text
http://localhost:8085/tester/
```
*(Note: `/manage/` automatically redirects to `/tester/` for backward compatibility).*

Quick links available from the UI sidebar:
- Built-in visualizer: [`http://localhost:8085/tester/trace.html`](http://localhost:8085/tester/trace.html)
- JSON trace tree: [`http://localhost:8085/tester/viewer.html`](http://localhost:8085/tester/viewer.html)
- Apigee Emulator Tree: [`http://localhost:8080/v1/emulator/tree`](http://localhost:8080/v1/emulator/tree)

---

### Backend REST API Reference

The service exposes the following endpoints under `/tester/api` (with `/manage/api` maintained for backward compatibility):

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/healthz` | Health check endpoint returning `{"status": "ok"}`. |
| `GET` | `/tester/api/status` | Current status of emulator, Cassandra readiness, deployed proxies, and available bundles. |
| `GET` | `/tester/api/bundles` | List all packaged ZIP bundles in `data/bundles/`. |
| `GET` | `/tester/api/tests` | List test request presets extracted from `data/deployments/*.yaml`. |
| `POST` | `/tester/api/deploy` | Deploys selected or all bundles and synchronizes test data (accepts `{"bundles": ["..."], "reset": true}`). |
| `POST` | `/tester/api/reset` | Resets Apigee emulator state to a clean slate. |
| `POST` | `/tester/api/test` | Executes an HTTP request against the Apigee runtime port with optional automated trace capture. |
| `POST` | `/tester/api/trace/start` | Initiates an Apigee debug trace session for a specific proxy. |
| `GET` | `/tester/api/trace/transactions` | Retrieves recorded transaction trace entries for a session ID. |

#### Example: Deploy All Bundles via API

```bash
curl -X POST http://localhost:8085/tester/api/deploy \
  -H "Content-Type: application/json" \
  -d '{"reset": true}'
```

#### Example: Execute Test Request with Trace Capture

```bash
curl -X POST http://localhost:8085/tester/api/test \
  -H "Content-Type: application/json" \
  -d '{
    "proxy": "TestProxy",
    "method": "GET",
    "path": "/testproxy",
    "headers": {
      "x-api-key": "test-api-key-12345"
    },
    "recordTrace": true
  }'
```

---

### Containerization & Cloud Run Sidecar Deployment

The service is packaged as a lightweight Docker container based on `alpine:3.19` using multi-stage Go compilation:

- **Image Dockerfile**: [`Dockerfile`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/Dockerfile)
- **Packaged Assets**: Pre-compiled bundles in `/app/data/bundles/`, test presets in `/app/data/deployments/`, static UI in `/app/public/`, and test environment definitions.

In Cloud Run, it runs as a sidecar container alongside `apigee` and `envoy`:

```text
                  Cloud Run Service (Port 443 / 8000)
                                   │
                                   ▼
                    ┌───────────────────────────────┐
                    │    Envoy Ingress Container    │
                    └───────┬───────────────┬───────┘
                            │               │
         ┌──────────────────┴──┐         ┌──┴──────────────────┐
         │ /tester, /manage    │         │ /v1/emulator/* (8080)
         │                     │         │ /* (Runtime 8998)   │
         ▼                     ▼         ▼                     ▼
┌───────────────────────────────┐     ┌───────────────────────────────┐
│     Tester Sidecar (8082)     │     │    Apigee Emulator Sidecar    │
│  (UI, Test Runner, Bundles)   │     │ (Management & Message Proc)   │
└───────────────────────────────┘     └───────────────────────────────┘
```

When deployed to Cloud Run, access the tester directly at:
```text
https://<cloud-run-service-url>/tester/
```
