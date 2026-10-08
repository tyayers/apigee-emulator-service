# Tutorial: Automated Testing of Apigee Proxies and Deployments with the Apigee Emulator

Welcome to the hands-on tutorial for automating proxy testing with the **Apigee Local Emulator** and the [`apigee-emulator-service`](https://github.com/tyayers/apigee-emulator-service).

In this tutorial, you will learn how to:
1. Define testable proxies and deployment manifests with built-in assertion suites.
2. Run automated test runs locally against the Apigee emulator.
3. Integrate automated emulator tests into **CI/CD pipelines** (e.g. GitHub Actions).
4. Deploy and execute automated tests on **Google Cloud Run** for shared team sandboxes and preview environments.
5. Understand how emulator testing fits into a comprehensive QA strategy alongside integration and UAT tests in **Apigee X** or **Apigee hybrid**.

---

## Prerequisites

Before getting started, make sure you have the following prerequisites installed in your Linux shell (or Google Cloud Shell):

1. **Bun (v1.1+)** – High-performance JavaScript/TypeScript runtime used by the tester service and deployment compiler:
   ```bash
   curl -fsSL https://bun.sh/install | bash
   export PATH="$HOME/.bun/bin:$PATH"
   ```
2. **Apigee Templater (`aft`)** – CLI tool for compiling and building Apigee proxy bundles:
   ```bash
   curl -sSL https://raw.githubusercontent.com/apigee/apigee-templater/main/install.sh | bash
   export PATH="$HOME/.local/bin:$HOME/.aft/bin:$PATH"
   ```
3. **Docker** – Required for running the Apigee Local Emulator container:
   ```bash
   docker --version
   ```
4. **cURL & jq** – Command-line tools for making requests and inspecting JSON responses:
   ```bash
   sudo apt-get update && sudo apt-get install -y curl jq
   ```
5. **Google Cloud SDK (`gcloud`)** – Authenticated with your GCP project (required for Cloud Run deployment):
   ```bash
   gcloud auth login
   ```

---

## The Testing Strategy: Shift-Left with the Emulator

In traditional Apigee development, verifying a proxy change often requires deploying directly to a cloud evaluation or development environment in Apigee X or hybrid. While essential for end-to-end integration, this introduces slow feedback loops (deploying revisions over cloud management APIs, queue times, and risk of disrupting shared dev environments).

```
                      Apigee Testing Pyramid
                   ┌───────────────────────────┐
                   │   Real Apigee X / Hybrid  │  ◄── UAT, End-to-End & Prod Verification
                   │  Integration & System QA  │      (mTLS, real backend services, IAM)
                   └─────────────┬─────────────┘
                                 │
                   ┌─────────────┴─────────────┐
                   │    Apigee Local Emulator  │  ◄── Automated Regression & Policy Testing
                   │ (Local / CI/CD / Cloud Run)│      (Assertions, traces, KVMs, zero quota)
                   └─────────────┬─────────────┘
                                 │
                   ┌─────────────┴─────────────┐
                   │   Unit & Linter Checks    │  ◄── Syntax validation, schema checks
                   │     (aft lint, mocha)     │
                   └───────────────────────────┘
```

The **Apigee Emulator** provides a complete, local Apigee runtime (Message Processor, Cassandra datastore, and local management APIs). By testing against the emulator:
- **Instant Feedback**: Bundles deploy in under 2 seconds.
- **Automated Assertions**: Validate status codes, response payloads, headers, and debug trace steps automatically.
- **Zero Cloud Cost**: No Apigee API call quotas consumed, no network ingress/egress charges.
- **Safe Sandboxing**: State is completely isolated and can be cleanly reset (`POST /v1/emulator/reset`) between test runs.

---

## 1. Defining Proxies & Deployment Manifests

The repository [tyayers/apigee-emulator-service](https://github.com/tyayers/apigee-emulator-service) uses **Apigee Templater (AFT)** syntax.

### The Deployment Manifest: `deployment-1.yaml`

The deployment manifest [`data/deployments/deployment-1.yaml`](data/deployments/deployment-1.yaml) packages proxies (`TestProxy`), API products, developer test applications, and automated test suites together in a single file:

```yaml
# data/deployments/deployment-1.yaml (Excerpt)
gateway: apigee
name: deployment-1
type: deployment

proxies:
  - name: TestProxy
    # ... proxy configuration ...

products:
  - name: test-product
    displayName: Test Product
    environments:
      - default-dev
    operations:
      - apiSource: TestProxy
        operations:
          - name: /json
            methods: []

users:
  - name: test@example.com
    apps:
      - name: Test App
        products:
          - test-product
        credentials:
          - consumerKey: test-app-key-123
            status: approved

tests:
  - name: testproxy-test1
    proxy: TestProxy
    path: /testproxy
    method: GET
    headers:
      x-api-key: test-app-key-123
    assertions:
      - status.code == 200
```

Notice the **`tests:`** block at the end: it defines the automated test case, target path, required credentials, and assertions (`status.code == 200`).

---

## 2. Local Testing with `local.sh`

The [`local.sh`](local.sh) script orchestrates the local testing workflow. Every action in the interactive menu (1–10) can be invoked directly with dedicated `--parameter` flags.

### Step 1: Start the Local Emulator & Tester Service

Start the Apigee Local Runtime container and launch the Bun TypeScript tester service in the background:

```bash
# Clone the repository
git clone https://github.com/tyayers/apigee-emulator-service.git
cd apigee-emulator-service

# Start the emulator and background tester service (Option 1)
./local.sh --start
```

`./local.sh --start` automatically:
- Checks prerequisites (`docker`, `bun`, `curl`, `jq`).
- Creates or starts the `apigee` Docker container (with runtime port mapped to `8888:8998` and management port `8080:8080`).
- Waits for emulator readiness.
- Starts the Bun TypeScript tester server in the background on port `8082`.

You can check status at any time:
```bash
./local.sh --status
```

---

### Step 2: Deploy Deployment Manifests with `local.sh`

Deploy [`deployment-1.yaml`](data/deployments/deployment-1.yaml) to your local emulator:

```bash
# Deploy deployment-1.yaml (Option 2)
./local.sh --deploy data/deployments/deployment-1.yaml

# Or deploy all available manifests at once (Option 3)
./local.sh --deploy-all
```

Under the hood, `./local.sh --deploy`:
- Compiles `TestProxy` with `aft`.
- Substitutes `{GOOGLE_CLOUD_PROJECT}` with your active project.
- Generates compliant API products and developer app credentials.
- Resets the emulator and deploys the bundle to the `test` environment on runtime port **8888**.

Test the proxy endpoint directly:
```bash
curl -i http://localhost:8888/testproxy
```

Output:
```http
HTTP/1.1 200 OK
x-testheader: Hello world!
Content-Type: text/plain; charset=utf-8

Hello, Guest! Hello world!
```

---

### Step 3: Run the Tester Web UI

Open the interactive web interface in your browser:

```bash
# Open tester Web UI (Option 6)
./local.sh --ui
```

Or open directly in your browser:
```text
http://localhost:8082/tester/
```

- The UI displays loaded deployment manifests, active proxies, and test suites extracted from `deployment-1.yaml` (`testproxy-test1`).
- The assertions pane shows configured validation rules: `status.code == 200`.
- Clicking **"Send Request"** executes the call against the local emulator runtime and renders the debug trace.
- Clicking **"Test All"** runs the full automated test suite across all proxies.

---

### Step 4: Run Automated Tests via CLI or REST API

Run the automated test runner directly from your shell:

```bash
# Run all tests (Option 4)
./local.sh --test

# Run tests for a specific proxy
./local.sh --test TestProxy
```

You can also trigger tests programmatically via the Tester REST API:

```bash
# Run all tests for TestProxy via API
curl -s -X POST http://localhost:8082/tester/api/tests/run \
  -H "Content-Type: application/json" \
  -d '{"proxy": "TestProxy"}' | jq .
```

Example JSON response:
```json
{
  "total": 1,
  "passed": 1,
  "failed": 0,
  "results": [
    {
      "testName": "testproxy-test1",
      "proxy": "TestProxy",
      "method": "GET",
      "path": "/testproxy",
      "statusCode": 200,
      "passed": true,
      "durationMs": 42,
      "assertions": [
        {
          "assertion": "status.code == 200",
          "passed": true,
          "actual": "200"
        }
      ]
    }
  ]
}
```

---

## 3. Automated Testing in CI/CD Pipelines

Running the Apigee Emulator inside your CI/CD pipeline lets you catch policy misconfigurations, broken JavaScript, or regressed response codes on every Pull Request—before code reaches real environments.

### GitHub Actions Workflow Example

Create `.github/workflows/emulator-test.yml`:

```yaml
name: Apigee Emulator Automated Tests

on:
  push:
    branches: [ main ]
  pull_request:
    branches: [ main ]

jobs:
  test:
    runs-on: ubuntu-latest

    services:
      apigee-emulator:
        image: gcr.io/apigee-release/hybrid/apigee-emulator:2.0.1
        ports:
          - 8080:8080
          - 8888:8998

    steps:
      - name: Checkout Code
        uses: actions/checkout@v4

      - name: Set up Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install aft (Apigee Templater) CLI
        run: |
          curl -sSL https://raw.githubusercontent.com/apigee/apigee-templater/main/install.sh | bash
          echo "$HOME/.aft/bin" >> $GITHUB_PATH

      - name: Wait for Emulator Readiness
        run: |
          echo "Waiting for Apigee Emulator..."
          for i in {1..30}; do
            if curl -s http://localhost:8080/v1/emulator/tree > /dev/null; then
              echo "Apigee Emulator is ready!"
              break
            fi
            sleep 2
          done

      - name: Deploy Deployment Manifest
        run: |
          ./local.sh --deploy data/deployments/deployment-1.yaml

      - name: Run Automated Test Suites
        run: |
          ./local.sh --test
```

---

## 4. Cloud Run Testing Deployment

Running the Apigee Emulator on Google Cloud Run enables a persistent, multi-container sandbox in the cloud for team members, automated branch previews, and external webhook verification.

### Architecture Overview

On Cloud Run, an **Envoy** ingress container handles HTTPS routing and proxies:
- `/tester/*` &rarr; `apigee-emulator-service` (Web UI & Test Runner on port 8082).
- `/v1/emulator/*` &rarr; Apigee Management API (port 8080).
- `/*` &rarr; Apigee Runtime Message Processor (port 8998).

```
                      Google Cloud Run (HTTPS 443)
                                  │
                                  ▼
                   ┌─────────────────────────────┐
                   │   Envoy Ingress Container   │
                   └──────┬───────────────┬──────┘
                          │               │
      ┌───────────────────┴──┐         ┌──┴──────────────────┐
      │ /tester/             │         │ /v1/emulator/* (8080)
      │                      │         │ /* (Runtime 8998)   │
      ▼                      ▼         ▼                     ▼
┌─────────────────────────────┐     ┌─────────────────────────────┐
│    Tester Service (8082)    │     │   Apigee Emulator (8080)    │
│  (UI, Test Runner, History) │     │ (Runtime & Local Cassandra) │
└─────────────────────────────┘     └─────────────────────────────┘
```

---

### Step 1: Deploy Service to Cloud Run

Deploy the multi-container configuration using [`cloudrun.sh`](cloudrun.sh):

```bash
# Deploy service to Cloud Run
./cloudrun.sh deploy-service
```

---

### Step 2: Deploy TestProxy and Deployment Manifests to Cloud Run

```bash
# Deploy deployment-1.yaml to Cloud Run
./cloudrun.sh deploy data/deployments/deployment-1.yaml
```

This compiles `TestProxy` with `aft`, packages the test credentials, resets the remote emulator, and deploys the revision to Cloud Run.

---

### Step 3: Run Cloud Run Automated Tests & Trace Recording

Run tests directly against the Cloud Run instance:

```bash
# Retrieve service URL
CLOUDRUN_URL=$(./cloudrun.sh url)

# Run automated tests against the Cloud Run deployment via REST API
curl -s -X POST "$CLOUDRUN_URL/tester/api/tests/run" \
  -H "Content-Type: application/json" \
  -d '{"proxy": "TestProxy"}' | jq .

# Test proxy traffic with the built-in CLI helper
./cloudrun.sh test /testproxy

# Record debug traces in Cloud Run
./cloudrun.sh trace-start TestProxy
./cloudrun.sh test /testproxy
./cloudrun.sh trace-stop
```

The resulting `trace.json` file can be opened in [`trace.html`](trace.html) to inspect policy execution timings and variables.

---

### Cloud Run Tester Screenshot

You can access the full interactive developer interface in your browser at `https://<your-cloud-run-url>/tester/` (or via `./cloudrun.sh ui`):

> [!NOTE]
> **Cloud Run Deployment Screenshot**
>
> *(Insert your Cloud Run deployment screenshot here)*
>
> ![Apigee Emulator Tester on Cloud Run](images/cloudrun-tester.png)

---

## 5. Complementing Apigee X & Hybrid Integration Testing

Automated emulator testing is designed to accelerate development, not replace end-to-end testing in real environments:

| Testing Stage | Environment | What is Validated |
|---|---|---|
| **Local / Developer Inner Loop** | Local Emulator (`local.sh`, `/tester/`) | Policy syntax, JavaScript logic, AssignMessage transformations, KVM lookups, Mock target flows. |
| **Pull Request / CI/CD** | Emulator Container in GitHub Actions | Automated regression tests (`status.code == 200`, JSON assertions), branch bundle validation. |
| **Team Sandbox / Review** | Emulator on Google Cloud Run (`cloudrun.sh`) | Manual inspection, shared review, webhook integration, trace debugging without local Docker. |
| **Integration & UAT** | Real Apigee X / Hybrid Orgs (Non-Prod) | Mutual TLS (mTLS), Cloud KMS integration, real third-party backends, Cloud Armor / WAF, GCP IAM roles. |

By catching 90%+ of policy logic and schema errors during the emulator phase, deployments to real Apigee X and hybrid organizations become significantly faster, cleaner, and less prone to rollbacks.

---

## Summary & Useful Commands Reference

| Task | Local (`local.sh`) | Cloud Run (`cloudrun.sh`) |
|---|---|---|
| **Start / Deploy Service** | `./local.sh --start` | `./cloudrun.sh deploy-service` |
| **Deploy Manifest** | `./local.sh --deploy data/deployments/deployment-1.yaml` | `./cloudrun.sh deploy data/deployments/deployment-1.yaml` |
| **Deploy All Manifests** | `./local.sh --deploy-all` | `./cloudrun.sh --all` |
| **Run Automated Tests** | `./local.sh --test [PROXY]` | `curl -X POST "$URL/tester/api/tests/run"` |
| **Test Proxy Endpoint** | `curl -i http://localhost:8888/testproxy` | `./cloudrun.sh test /testproxy` |
| **Check Status & Health** | `./local.sh --status` | `./cloudrun.sh status` |
| **Open Tester Web UI** | `./local.sh --ui` | `./cloudrun.sh ui` |
| **Record Debug Trace** | `./local.sh --trace-start [PROXY]` / `--trace-stop` | `./cloudrun.sh trace-start [PROXY]` / `trace-stop` |
| **Reset Emulator State** | `./local.sh --reset` | `./cloudrun.sh reset` |
| **Recreate Container** | `./local.sh --recreate` | — |
| **Clean Generated Assets** | `./local.sh --clean` | — |
| **Stop All Services** | `./local.sh --stop` | — |

For more details and source code, visit the GitHub repository:
👉 **[https://github.com/tyayers/apigee-emulator-service](https://github.com/tyayers/apigee-emulator-service)**
