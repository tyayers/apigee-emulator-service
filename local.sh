#!/bin/bash
# ==============================================================================
# Apigee Emulator Local Management & Deployment Script
#
# Manages local Apigee Emulator Docker container, automates deployment YAML
# conversion and deployment with GOOGLE_CLOUD_PROJECT substitution, starts the
# Bun TypeScript server, and runs tests & traces.
#
# USAGE:
#   1. Start emulator & server:
#        ./local.sh up
#        ./local.sh start --dev
#
#   2. Deploy a deployment YAML (with automatic GOOGLE_CLOUD_PROJECT substitution):
#        ./local.sh deploy data/deployments/deployment-1.yaml
#        ./local.sh deploy --project my-gcp-project data/deployments/deployment-1.yaml
#
#   3. Deploy all deployments at once:
#        ./local.sh deploy --all
#
#   4. Run tests:
#        ./local.sh test
#        ./local.sh test REST-AI-Interactions
#
#   5. Check status, inspect active proxies, or trace:
#        ./local.sh status
#        ./local.sh tester
#        ./local.sh trace-start REST-AI-Interactions
#        ./local.sh trace-stop
#        ./local.sh reset
#        ./local.sh stop
#
#   6. Interactive menu (default when run with no arguments):
#        ./local.sh
# ==============================================================================

if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
  echo -e "\033[1;31mError: local.sh must be executed directly, not sourced.\033[0m" >&2
  echo -e "Please run:\n  \033[1;32m./local.sh\033[0m" >&2
  return 1 2>/dev/null || exit 1
fi

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$SCRIPT_DIR"
cd "$ROOT_DIR"

# ANSI Colors
RED="\033[0;31m"
GREEN="\033[0;32m"
YELLOW="\033[1;33m"
BLUE="\033[0;34m"
CYAN="\033[0;36m"
BOLD="\033[1m"
NC="\033[0m"

# Configuration defaults
PORT="${PORT:-8082}"
EMULATOR_MGMT_URL="${EMULATOR_MGMT_URL:-http://127.0.0.1:8080}"
EMULATOR_RUNTIME_URL="${EMULATOR_RUNTIME_URL:-http://127.0.0.1:8998}"
CONTAINER_NAME="${EMULATOR_CONTAINER_NAME:-apigee}"
URL_FILE="$ROOT_DIR/.local_url"
SESSION_FILE="$ROOT_DIR/.local_trace_session"

# Parameter mappings
declare -A ALL_PARAMS_MAP

# ------------------------------------------------------------------------------
# GCP Context Resolution
# ------------------------------------------------------------------------------
resolve_gcp_context() {
  if [ -z "$PROJECT_ID" ]; then
    PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-${GCP_PROJECT:-${CLOUDSDK_CORE_PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}}}"
  fi
  if [ -z "$REGION" ]; then
    REGION="${GOOGLE_CLOUD_LOCATION:-${GOOGLE_CLOUD_REGION:-${GCP_REGION:-${CLOUDSDK_COMPUTE_REGION:-$(gcloud config get-value run/region 2>/dev/null || true)}}}}"
  fi
  if [ -z "$REGION" ]; then
    REGION="global"
  fi

  if [ -n "$PROJECT_ID" ]; then
    export PROJECT_ID
    export GOOGLE_CLOUD_PROJECT="${GOOGLE_CLOUD_PROJECT:-$PROJECT_ID}"
    export GCP_PROJECT="${GCP_PROJECT:-$PROJECT_ID}"
    ALL_PARAMS_MAP["GoogleCloudProject"]="$PROJECT_ID"
    ALL_PARAMS_MAP["GOOGLE_CLOUD_PROJECT"]="$PROJECT_ID"
  fi
  if [ -n "$REGION" ]; then
    export REGION
    export GOOGLE_CLOUD_LOCATION="${GOOGLE_CLOUD_LOCATION:-$REGION}"
    export GOOGLE_CLOUD_REGION="${GOOGLE_CLOUD_REGION:-$REGION}"
    ALL_PARAMS_MAP["GoogleCloudLocation"]="$REGION"
    ALL_PARAMS_MAP["GOOGLE_CLOUD_LOCATION"]="$REGION"
  fi

  # Detect GEMINI_API_KEY if not already in env
  if [ -z "$GEMINI_API_KEY" ] && [ -f "$ROOT_DIR/.env" ]; then
    local env_val
    env_val=$(grep -E '^\s*GEMINI_API_KEY\s*=' "$ROOT_DIR/.env" | cut -d '=' -f2- | tr -d ' "\r\n' || true)
    if [ -n "$env_val" ]; then
      export GEMINI_API_KEY="$env_val"
      ALL_PARAMS_MAP["GeminiApiKey"]="$env_val"
      ALL_PARAMS_MAP["GEMINI_API_KEY"]="$env_val"
    fi
  fi
}

# ------------------------------------------------------------------------------
# Parameter Parsing
# ------------------------------------------------------------------------------
parse_parameters_flag() {
  local p_arg="$1"
  if [ -z "$p_arg" ]; then
    return 0
  fi
  IFS=',' read -ra pairs <<< "$p_arg"
  for pair in "${pairs[@]}"; do
    if [[ "$pair" == *=* ]]; then
      local k="${pair%%=*}"
      local v="${pair#*=}"
      ALL_PARAMS_MAP["$k"]="$v"
      export "$k"="$v"
      if [ "$k" = "project" ] || [ "$k" = "GoogleCloudProject" ] || [ "$k" = "GOOGLE_CLOUD_PROJECT" ]; then
        PROJECT_ID="$v"
        export PROJECT_ID="$v"
        export GOOGLE_CLOUD_PROJECT="$v"
      fi
    fi
  done
}

# ------------------------------------------------------------------------------
# Discovery Functions
# ------------------------------------------------------------------------------
get_available_deployments() {
  find data/deployments -maxdepth 1 \( -name "*.yaml" -o -name "*.yml" \) -type f 2>/dev/null | sort
}

get_available_bundles() {
  find data/bundles -maxdepth 1 -name "*.zip" -type f 2>/dev/null | sort
}

# ------------------------------------------------------------------------------
# Prerequisites Checking
# ------------------------------------------------------------------------------
check_prereqs() {
  local missing=()
  for cmd in docker bun curl jq; do
    if ! command -v "$cmd" &>/dev/null; then
      missing+=("$cmd")
    fi
  done

  if [ ${#missing[@]} -gt 0 ]; then
    echo -e "${RED}Error: Missing required tools: ${missing[*]}${NC}" >&2
    echo "Please install them before continuing." >&2
    exit 1
  fi
}

# ------------------------------------------------------------------------------
# Emulator Container Lifecycle
# ------------------------------------------------------------------------------
ensure_emulator_running() {
  check_prereqs

  # Check if docker daemon is running
  if ! docker info &>/dev/null; then
    echo -e "${RED}Error: Docker daemon is not running.${NC}" >&2
    exit 1
  fi

  # Check if container exists
  if ! docker ps -a --format '{{.Names}}' | grep -Eq "^${CONTAINER_NAME}\$"; then
    echo -e "${YELLOW}Apigee emulator container '${CONTAINER_NAME}' does not exist.${NC}"
    if [ -f "$ROOT_DIR/create.sh" ]; then
      echo -e "${BLUE}Creating container using ./create.sh...${NC}"
      "$ROOT_DIR/create.sh"
    else
      echo -e "${BLUE}Creating container ${CONTAINER_NAME}...${NC}"
      docker create --name "$CONTAINER_NAME" \
        -p 8080:8080 \
        -p 8998:8998 \
        gcr.io/apigee-release/hybrid/apigee-emulator:2.0.1
    fi
  fi

  # Check if container is running
  if ! docker ps --format '{{.Names}}' | grep -Eq "^${CONTAINER_NAME}\$"; then
    echo -e "${BLUE}Starting container ${CONTAINER_NAME}...${NC}"
    docker start "$CONTAINER_NAME"
    echo -e "${BLUE}Waiting for Apigee Emulator to become ready...${NC}"
    local tries=0
    local max_tries=30
    while ! curl -s -f "$EMULATOR_MGMT_URL/v1/emulator/health" &>/dev/null; do
      sleep 1
      tries=$((tries + 1))
      if [ "$tries" -ge "$max_tries" ]; then
        echo -e "${RED}Timeout waiting for Apigee Emulator to respond at $EMULATOR_MGMT_URL${NC}" >&2
        exit 1
      fi
    done
    echo -e "${GREEN}Apigee Emulator container is ready.${NC}"
  fi
}

# ------------------------------------------------------------------------------
# Service Management Commands
# ------------------------------------------------------------------------------
start_server() {
  local dev_mode="$1"
  ensure_emulator_running
  resolve_gcp_context

  echo -e "${BOLD}Starting Apigee Emulator Service on port ${PORT}...${NC}"
  if [ -n "$PROJECT_ID" ]; then
    echo -e "  • ${BOLD}Project:${NC} ${CYAN}$PROJECT_ID${NC}"
  fi
  echo -e "  • ${BOLD}Web UI:${NC}  ${GREEN}http://localhost:${PORT}/tester/${NC}\n"

  if [ "$dev_mode" = "true" ]; then
    PORT="$PORT" bun --watch run src/index.ts
  else
    PORT="$PORT" bun run src/index.ts
  fi
}

deploy_resource() {
  local target="$1"
  local reset="${2:-true}"

  ensure_emulator_running
  resolve_gcp_context

  if [ -z "$target" ]; then
    target="data/deployments/deployment-1.yaml"
  fi

  if [ ! -f "$target" ]; then
    echo -e "${RED}Error: File not found: $target${NC}" >&2
    exit 1
  fi

  echo -e "${BOLD}Deploying resource to local Apigee Emulator:${NC} ${CYAN}$target${NC}"
  if [ -n "$PROJECT_ID" ]; then
    echo -e "  • ${BOLD}Google Cloud Project:${NC} ${GREEN}$PROJECT_ID${NC}"
  fi

  local reset_flag="--reset"
  if [ "$reset" = "false" ]; then
    reset_flag="--no-reset"
  fi

  # Run the Bun TypeScript deployer directly
  GOOGLE_CLOUD_PROJECT="$PROJECT_ID" \
  GOOGLE_CLOUD_LOCATION="$REGION" \
  PORT="$PORT" \
  bun run src/index.ts --deploy "$target" $reset_flag --no-server

  echo -e "\n${GREEN}Deployment finished successfully.${NC}"
  echo -e "Open tester UI: ${CYAN}http://localhost:${PORT}/tester/${NC}"
}

deploy_all() {
  ensure_emulator_running
  resolve_gcp_context

  echo -e "${BOLD}Deploying all deployments from data/deployments/...${NC}"
  local deps
  deps=$(get_available_deployments)
  if [ -z "$deps" ]; then
    echo -e "${YELLOW}No deployment YAML files found in data/deployments/.${NC}"
    exit 0
  fi

  for dep in $deps; do
    echo -e "\n------------------------------------------------------------"
    deploy_resource "$dep" "true"
  done
}

run_tests() {
  local proxy_name="$1"
  resolve_gcp_context

  echo -e "${BOLD}Running tests against local Apigee Emulator...${NC}"

  # Check if server is running on PORT
  if curl -s -f "http://localhost:${PORT}/tester/api/status" &>/dev/null; then
    if [ -n "$proxy_name" ]; then
      echo -e "${BLUE}Executing tests for proxy '$proxy_name' via API...${NC}"
      curl -s -X POST "http://localhost:${PORT}/tester/api/tests/run" \
        -H "Content-Type: application/json" \
        -d "{\"proxy\": \"$proxy_name\"}" | jq .
    else
      echo -e "${BLUE}Executing all tests via API...${NC}"
      curl -s -X POST "http://localhost:${PORT}/tester/api/tests/run" \
        -H "Content-Type: application/json" \
        -d "{}" | jq .
    fi
  else
    # Run test runner via CLI
    GOOGLE_CLOUD_PROJECT="$PROJECT_ID" \
    GOOGLE_CLOUD_LOCATION="$REGION" \
    PORT="$PORT" \
    bun run src/index.ts --test ${proxy_name:+"$proxy_name"} --no-server
  fi
}

check_status() {
  resolve_gcp_context

  echo -e "${BOLD}Local Apigee Emulator Status:${NC}"
  echo -e "  • ${BOLD}Docker Container:${NC} " $(docker ps --filter "name=${CONTAINER_NAME}" --format '{{.Status}}' 2>/dev/null || echo "Not running")
  echo -e "  • ${BOLD}Management API:${NC}   $EMULATOR_MGMT_URL"
  echo -e "  • ${BOLD}Runtime Port:${NC}     $EMULATOR_RUNTIME_URL"
  echo -e "  • ${BOLD}Tester Port:${NC}      http://localhost:${PORT}/tester/"
  if [ -n "$PROJECT_ID" ]; then
    echo -e "  • ${BOLD}GCP Project:${NC}      ${CYAN}$PROJECT_ID${NC}"
  fi

  # Check health
  local health
  health=$(curl -s "$EMULATOR_MGMT_URL/v1/emulator/health" 2>/dev/null || true)
  if [ -n "$health" ]; then
    echo -e "\n${BOLD}Emulator Health:${NC} ${GREEN}$health${NC}"
  else
    echo -e "\n${YELLOW}Emulator management API is offline.${NC}"
  fi

  # Query Tester API if server is up
  local tester_status
  tester_status=$(curl -s "http://localhost:${PORT}/tester/api/status" 2>/dev/null || true)
  if [ -n "$tester_status" ]; then
    echo -e "\n${BOLD}Deployed Proxies & Bundles (from Tester Service):${NC}"
    echo "$tester_status" | jq -r '.bundles[] | "  • \(.proxyName) (Deployed: \(.isDeployed), Routes: \(.targetRoutes | join(", ")))"' 2>/dev/null || true
  else
    # Query Emulator directly for deployment tree
    local tree
    tree=$(curl -s "$EMULATOR_MGMT_URL/v1/emulator/deployments" 2>/dev/null || true)
    if [ -n "$tree" ]; then
      echo -e "\n${BOLD}Emulator Deployment Tree:${NC}"
      echo "$tree" | jq . 2>/dev/null || echo "$tree"
    fi
  fi
}

reset_emulator() {
  echo -e "${YELLOW}Resetting Apigee Emulator state...${NC}"
  curl -s -X POST "$EMULATOR_MGMT_URL/v1/emulator/reset"
  echo -e "\n${GREEN}Emulator state reset completed.${NC}"
}

stop_all() {
  echo -e "${YELLOW}Stopping Apigee Emulator container...${NC}"
  docker stop "$CONTAINER_NAME" 2>/dev/null || true
  echo -e "${GREEN}Stopped.${NC}"
}

start_trace() {
  local proxy_name="$1"
  if [ -z "$proxy_name" ]; then
    echo -e "${RED}Usage: ./local.sh trace-start <PROXY_NAME>${NC}" >&2
    exit 1
  fi
  echo -e "${BLUE}Starting debug trace session for ${BOLD}$proxy_name${NC}...${NC}"
  local session
  session=$(curl -s -X POST "$EMULATOR_MGMT_URL/v1/emulator/environments/test/apiproxies/$proxy_name/trace/sessions")
  echo "$session" > "$SESSION_FILE"
  local session_id
  session_id=$(echo "$session" | jq -r '.id // empty' 2>/dev/null || true)
  if [ -n "$session_id" ]; then
    echo -e "${GREEN}Trace session active:${NC} $session_id"
    echo -e "Send traffic to http://localhost:8998 and then run: ${CYAN}./local.sh trace-stop${NC}"
  else
    echo -e "${RED}Failed to start trace session:${NC} $session"
  fi
}

stop_trace() {
  if [ ! -f "$SESSION_FILE" ]; then
    echo -e "${YELLOW}No active trace session file found.${NC}"
    return 0
  fi
  local session_data
  session_data=$(cat "$SESSION_FILE")
  local session_id
  session_id=$(echo "$session_data" | jq -r '.id // empty' 2>/dev/null || true)
  local proxy_name
  proxy_name=$(echo "$session_data" | jq -r '.apiproxy // empty' 2>/dev/null || true)

  if [ -z "$session_id" ] || [ -z "$proxy_name" ]; then
    echo -e "${RED}Invalid session data in $SESSION_FILE${NC}" >&2
    return 1
  fi

  echo -e "${BLUE}Stopping trace session $session_id for $proxy_name...${NC}"
  curl -s -X POST "$EMULATOR_MGMT_URL/v1/emulator/environments/test/apiproxies/$proxy_name/trace/sessions/$session_id/stop" >/dev/null || true

  echo -e "${BLUE}Downloading recorded trace transactions...${NC}"
  curl -s "$EMULATOR_MGMT_URL/v1/emulator/environments/test/apiproxies/$proxy_name/trace/sessions/$session_id/transactions" > trace.json
  rm -f "$SESSION_FILE"
  echo -e "${GREEN}Transactions saved to trace.json.${NC}"
  echo -e "Open ${CYAN}http://localhost:${PORT}/tester/${NC} to visualize."
}

# ------------------------------------------------------------------------------
# Help Function
# ------------------------------------------------------------------------------
show_help() {
  echo -e "${BOLD}Usage:${NC}"
  echo "  ./local.sh [COMMAND] [OPTIONS] [FILE.yaml...]"
  echo ""
  echo -e "${BOLD}Commands:${NC}"
  echo "  up, start              Start Apigee container and launch Bun server"
  echo "  deploy [FILE...]       Deploy a deployment YAML or bundle (default: deployment-1.yaml)"
  echo "  test [PROXY]           Run proxy tests against local runtime"
  echo "  status                 Check container health, deployed proxies, and tester UI"
  echo "  tester, ui             Print and open Tester Web UI in browser"
  echo "  trace-start [PROXY]    Start trace recording session for a proxy"
  echo "  trace-stop             Stop trace session and download trace.json"
  echo "  reset                  Reset local emulator state"
  echo "  logs                   View Docker container logs"
  echo "  stop                   Stop Apigee container"
  echo ""
  echo -e "${BOLD}Options:${NC}"
  echo "  -a, --all              Deploy all deployments in 'data/deployments/'"
  echo "  -l, --list             List available deployments and bundles"
  echo "  --project [ID]         Set GCP Project ID for {GOOGLE_CLOUD_PROJECT} substitution"
  echo "  --region [REGION]      Set GCP Region / Location (default: global)"
  echo "  --port [PORT]          Set tester server port (default: 8082)"
  echo "  --dev                  Run server in Bun watch/dev mode"
  echo "  -p, --parameters P     Pass additional parameters (key=val,key2=val2)"
  echo "  -h, --help             Show this help message"
  echo ""
  echo -e "${BOLD}Examples:${NC}"
  echo "  # 1. Start server with automatic project detection:"
  echo "  ./local.sh up"
  echo ""
  echo "  # 2. Deploy deployment-1.yaml with specific project ID:"
  echo "  ./local.sh deploy --project aigateway-lab3 data/deployments/deployment-1.yaml"
  echo ""
  echo "  # 3. Run tests for a deployed proxy:"
  echo "  ./local.sh test REST-AI-Interactions"
  echo ""
  echo "  # 4. Check status and deployed proxies:"
  echo "  ./local.sh status"
}

# ------------------------------------------------------------------------------
# Interactive Menu
# ------------------------------------------------------------------------------
interactive_menu() {
  resolve_gcp_context
  echo -e "${BOLD}======================================================${NC}"
  echo -e "${BOLD}       Apigee Emulator Local Management Menu          ${NC}"
  echo -e "${BOLD}======================================================${NC}"
  if [ -n "$PROJECT_ID" ]; then
    echo -e "  Current GCP Project: ${CYAN}$PROJECT_ID${NC}"
  fi
  echo ""
  echo "  1) Start Local Server & Emulator (up)"
  echo "  2) Deploy deployment-1.yaml"
  echo "  3) Deploy all deployments (--all)"
  echo "  4) Run Test Suite"
  echo "  5) Check Status & Deployed Proxies"
  echo "  6) Open Tester Web UI in Browser"
  echo "  7) Reset Emulator State"
  echo "  8) Stop Emulator Container"
  echo "  9) Exit"
  echo ""
  read -rp "Select an option [1-9] (default: 1): " choice
  choice="${choice:-1}"

  case "$choice" in
    1) start_server false ;;
    2) deploy_resource "data/deployments/deployment-1.yaml" "true" ;;
    3) deploy_all ;;
    4) run_tests ;;
    5) check_status ;;
    6)
      local url="http://localhost:${PORT}/tester/"
      echo -e "Opening ${CYAN}$url${NC}..."
      if command -v xdg-open &>/dev/null; then
        xdg-open "$url" 2>/dev/null || true
      elif command -v open &>/dev/null; then
        open "$url" 2>/dev/null || true
      fi
      ;;
    7) reset_emulator ;;
    8) stop_all ;;
    9) exit 0 ;;
    *) echo -e "${RED}Invalid choice.${NC}" ;;
  esac
}

# ------------------------------------------------------------------------------
# CLI Argument Parsing
# ------------------------------------------------------------------------------
COMMAND=""
TARGET_FILE=""
DEV_MODE="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      show_help
      exit 0
      ;;
    up|start)
      COMMAND="start"
      shift
      ;;
    deploy)
      COMMAND="deploy"
      shift
      ;;
    test)
      COMMAND="test"
      shift
      ;;
    status)
      COMMAND="status"
      shift
      ;;
    tester|ui)
      COMMAND="ui"
      shift
      ;;
    reset)
      COMMAND="reset"
      shift
      ;;
    stop)
      COMMAND="stop"
      shift
      ;;
    logs)
      COMMAND="logs"
      shift
      ;;
    trace-start)
      COMMAND="trace-start"
      shift
      if [ -n "$1" ] && [[ "$1" != -* ]]; then
        TARGET_FILE="$1"
        shift
      fi
      ;;
    trace-stop)
      COMMAND="trace-stop"
      shift
      ;;
    --dev)
      DEV_MODE="true"
      shift
      ;;
    -a|--all)
      COMMAND="deploy-all"
      shift
      ;;
    -l|--list)
      echo -e "${BOLD}Available Deployments in data/deployments/:${NC}"
      get_available_deployments
      echo -e "\n${BOLD}Available Bundles in data/bundles/:${NC}"
      get_available_bundles
      exit 0
      ;;
    --project)
      shift
      PROJECT_ID="$1"
      export PROJECT_ID
      export GOOGLE_CLOUD_PROJECT="$1"
      ALL_PARAMS_MAP["GoogleCloudProject"]="$1"
      ALL_PARAMS_MAP["GOOGLE_CLOUD_PROJECT"]="$1"
      shift
      ;;
    --region)
      shift
      REGION="$1"
      export REGION
      export GOOGLE_CLOUD_LOCATION="$1"
      shift
      ;;
    --port)
      shift
      PORT="$1"
      export PORT
      shift
      ;;
    -p|--parameters)
      shift
      parse_parameters_flag "$1"
      shift
      ;;
    *)
      if [ -z "$COMMAND" ] && [ -f "$1" ]; then
        COMMAND="deploy"
        TARGET_FILE="$1"
        shift
      elif [ -z "$TARGET_FILE" ]; then
        TARGET_FILE="$1"
        shift
      else
        shift
      fi
      ;;
  esac
done

case "$COMMAND" in
  start)
    start_server "$DEV_MODE"
    ;;
  deploy)
    deploy_resource "$TARGET_FILE" "true"
    ;;
  deploy-all)
    deploy_all
    ;;
  test)
    run_tests "$TARGET_FILE"
    ;;
  status)
    check_status
    ;;
  ui)
    echo -e "Web UI URL: ${CYAN}http://localhost:${PORT}/tester/${NC}"
    if command -v xdg-open &>/dev/null; then
      xdg-open "http://localhost:${PORT}/tester/" 2>/dev/null || true
    elif command -v open &>/dev/null; then
      open "http://localhost:${PORT}/tester/" 2>/dev/null || true
    fi
    ;;
  reset)
    reset_emulator
    ;;
  stop)
    stop_all
    ;;
  logs)
    docker logs -f "$CONTAINER_NAME"
    ;;
  trace-start)
    start_trace "$TARGET_FILE"
    ;;
  trace-stop)
    stop_trace
    ;;
  "")
    interactive_menu
    ;;
  *)
    echo -e "${RED}Unknown command: $COMMAND${NC}" >&2
    show_help
    exit 1
    ;;
esac
