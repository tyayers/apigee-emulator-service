# Tutorial: Automated Testing of Apigee Proxies and Deployments with the Apigee Emulator

Welcome to the hands-on tutorial for automating proxy testing with the **Apigee Local Emulator** and the [`apigee-emulator-service`](https://github.com/tyayers/apigee-emulator-service).

In this tutorial, you will learn how to:
1. Define testable proxies and deployment manifests with built-in assertion suites.
2. Run automated test runs locally against the Apigee emulator.
3. Integrate automated emulator tests into **CI/CD pipelines** (e.g. GitHub Actions).
4. Deploy and execute automated tests on **Google Cloud Run** for shared team sandboxes and preview environments.
5. Understand how emulator testing fits into a comprehensive QA strategy alongside integration and UAT tests in **Apigee X** or **Apigee hybrid**.

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

The deployment manifest [`data/deployments/deployment-1.yaml`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/data/deployments/deployment-1.yaml) packages proxies (`TestProxy`), API products, developer test applications, and automated test suites together in a single file:

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

## 2. Local Testing

### Step 1: Start the Apigee Emulator Container

Start the local Docker container running Apigee Local Runtime:

```bash
# Clone the repository if you haven't already
git clone https://github.com/tyayers/apigee-emulator-service.git
cd apigee-emulator-service

# Create and start the emulator container
./create.sh
docker start apigee
```

Verify that the emulator is ready:
```bash
curl -s http://localhost:8080/v1/emulator/tree | jq .
# Returns [] (empty array indicating healthy, ready runtime)
```

---

### Step 2: Deploy and Convert Assets with `deploy.sh`

Deploy [`deployment-1.yaml`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/data/deployments/deployment-1.yaml) to your local emulator:

```bash
./deploy.sh data/deployments/deployment-1.yaml
```

Under the hood, `deploy.sh`:
- Compiles `TestProxy` with `aft`.
- Generates compliant API products and developer app credentials.
- Resets the emulator and deploys the bundle to the `test` environment on port **8998**.

Test the proxy manually:
```bash
curl -i http://localhost:8998/testproxy
```

Output:
```http
HTTP/1.1 200 OK
x-testheader: Hello world!
Content-Type: text/plain; charset=utf-8

Hello, Guest! Hello world!
```

---

### Step 3: Run the Emulator Tester Service & Web UI

Start the lightweight Go service providing automated startup deployment, the test runner, and the web interface:

```bash
# Compile and run
go build -o apigee-emulator-service .
PORT=8085 ./apigee-emulator-service
```

Open your browser to:
```text
http://localhost:8085/tester/
```

- When the service starts, it automatically deploys all pre-compiled bundles in `data/bundles/` and displays a wait dialog.
- The **Tests** dropdown displays the tests extracted from `deployment-1.yaml` (`testproxy-test1`).
- The assertions pane shows the expected rules: `status.code == 200`.
- Clicking **"Send Request"** executes the call and loads the full vertical debug trace.
- Clicking **"Test All"** runs the automated test runner across all proxies.

---

### Step 4: Run Automated Tests via REST API

You can trigger test suites programmatically using the service's REST API:

```bash
# Run all tests for TestProxy
curl -s -X POST http://localhost:8085/tester/api/tests/run \
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
          - 8998:8998

    steps:
      - name: Checkout Code
        uses: actions/checkout@v4

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.21'

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - name: Install Dependencies
        run: |
          pip install pyyaml
          # Install aft (Apigee Templater) CLI
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

      - name: Convert Deployment Manifests to Local Assets
        run: |
          ./deploy.sh --convert

      - name: Start Apigee Emulator Tester Service
        run: |
          go build -o apigee-emulator-service .
          PORT=8085 ./apigee-emulator-service &
          sleep 5

      - name: Run Automated Test Suites
        run: |
          RESPONSE=$(curl -s -X POST http://localhost:8085/tester/api/tests/run \
            -H "Content-Type: application/json" \
            -d '{}')
          
          echo "$RESPONSE" | jq .
          
          FAILED=$(echo "$RESPONSE" | jq '.failed')
          if [ "$FAILED" -ne 0 ]; then
            echo "::error::Automated test suite failed ($FAILED tests failed)!"
            exit 1
          fi
          echo "All automated emulator tests passed successfully!"
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

Deploy the multi-container configuration using [`cloudrun.sh`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/cloudrun.sh):

```bash
# Deploy service
./cloudrun.sh deploy-service
```

---

### Step 2: Deploy TestProxy and Deployment Manifests to Cloud Run

```bash
# Deploy deployment-1.yaml
./cloudrun.sh data/deployments/deployment-1.yaml
```

This compiles `TestProxy`, packages the test credentials, resets the remote emulator, and deploys the revision to Cloud Run.

---

### Step 3: Run Cloud Run Automated Tests & Trace Recording

Run tests directly against the Cloud Run instance:

```bash
# Retrieve service URL
CLOUDRUN_URL=$(./cloudrun.sh url)

# Run automated tests against the Cloud Run deployment
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

The resulting `trace.json` file can be opened in [`trace.html`](file:///home/tyayers/projects/tyayers/apigee-emulator-service/trace.html) to inspect policy execution timings and variables.

---

### Cloud Run Tester Screenshot

You can access the full interactive developer interface in your browser at `https://<your-cloud-run-url>/tester/`:

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
| **Local / Developer Inner Loop** | Local Emulator (`deploy.sh`, `/tester/`) | Policy syntax, JavaScript logic, AssignMessage transformations, KVM lookups, Mock target flows. |
| **Pull Request / CI/CD** | Emulator Container in GitHub Actions | Automated regression tests (`status.code == 200`, JSON assertions), branch bundle validation. |
| **Team Sandbox / Review** | Emulator on Google Cloud Run | Manual inspection, shared review, webhook integration, trace debugging without local Docker. |
| **Integration & UAT** | Real Apigee X / Hybrid Orgs (Non-Prod) | Mutual TLS (mTLS), Cloud KMS integration, real third-party backends, Cloud Armor / WAF, GCP IAM roles. |

By catching 90%+ of policy logic and schema errors during the emulator phase, deployments to real Apigee X and hybrid organizations become significantly faster, cleaner, and less prone to rollbacks.

---

## Summary & Useful Commands Reference

| Task | Command |
|---|---|
| **Start Local Emulator** | `./create.sh && docker start apigee` |
| **Deploy Manifest Locally** | `./deploy.sh data/deployments/deployment-1.yaml` |
| **Convert Manifests to Bundles** | `./deploy.sh --convert` |
| **Start Tester Service** | `PORT=8085 ./apigee-emulator-service` |
| **Run Automated Tests (API)** | `curl -X POST http://localhost:8085/tester/api/tests/run -d '{"proxy":"TestProxy"}'` |
| **Deploy to Cloud Run** | `./cloudrun.sh deploy-service` |
| **Deploy Manifest to Cloud Run** | `./cloudrun.sh data/deployments/deployment-1.yaml` |
| **Test Cloud Run Endpoint** | `./cloudrun.sh test /testproxy` |

For more details and source code, visit the GitHub repository:
👉 **[https://github.com/tyayers/apigee-emulator-service](https://github.com/tyayers/apigee-emulator-service)**
