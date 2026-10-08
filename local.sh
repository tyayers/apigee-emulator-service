#!/bin/bash
# ==============================================================================
# Apigee Emulator Local Management & Deployment Script
#
# Manages local Apigee Emulator Docker container, automates deployment YAML
# conversion and deployment with GOOGLE_CLOUD_PROJECT substitution, starts the
# Bun TypeScript server, and runs tests & traces.
#
# USAGE:
#   1. Start emulator & server (Option 1):
#        ./local.sh --start
#        ./local.sh --start --dev
#
#   2. Deploy a deployment YAML (Option 2):
#        ./local.sh --deploy
#        ./local.sh --deploy data/deployments/deployment-1.yaml
#        ./local.sh --deploy --project my-gcp-project data/deployments/deployment-1.yaml
#
#   3. Deploy all deployments at once (Option 3):
#        ./local.sh --deploy-all
#
#   4. Run tests (Option 4):
#        ./local.sh --test
#        ./local.sh --test REST-AI-Interactions
#
#   5. Check status, inspect active proxies, or trace (Options 5-10):
#        ./local.sh --status
#        ./local.sh --ui
#        ./local.sh --reset
#        ./local.sh --recreate
#        ./local.sh --clean
#        ./local.sh --stop
#        ./local.sh --trace-start REST-AI-Interactions
#        ./local.sh --trace-stop
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
if [ -n "${EMULATOR_RUNTIME_URL:-}" ]; then
  CUSTOM_RUNTIME_URL_SET="true"
else
  CUSTOM_RUNTIME_URL_SET="false"
  EMULATOR_RUNTIME_URL=""
fi
CONTAINER_NAME="${EMULATOR_CONTAINER_NAME:-apigee}"
EMULATOR_TIMEOUT="${EMULATOR_TIMEOUT:-60}"
URL_FILE="$ROOT_DIR/.local_url"
SESSION_FILE="$ROOT_DIR/.local_trace_session"
PID_FILE="$ROOT_DIR/.local_server.pid"
LOG_FILE="$ROOT_DIR/.local_server.log"
CUSTOM_PORT_SET="false"

# Parameter mappings
declare -A ALL_PARAMS_MAP

# ------------------------------------------------------------------------------
# Port Resolution
# ------------------------------------------------------------------------------
resolve_emulator_runtime_url() {
  if [ "$CUSTOM_RUNTIME_URL_SET" = "true" ] && [ -n "$EMULATOR_RUNTIME_URL" ]; then
    return 0
  fi
  # Auto-detect mapped port from Docker container if running
  local mapped_port
  mapped_port=$(docker port "$CONTAINER_NAME" 8998/tcp 2>/dev/null | head -n 1 | sed 's/.*://' | tr -d ' \r\n' || true)
  if [ -n "$mapped_port" ]; then
    EMULATOR_RUNTIME_URL="http://127.0.0.1:${mapped_port}"
  elif [ -z "$EMULATOR_RUNTIME_URL" ]; then
    EMULATOR_RUNTIME_URL="http://127.0.0.1:8888"
  fi
  export EMULATOR_RUNTIME_URL
}
is_tester_service() {
  local p="$1"
  local res
  res=$(curl -s -f --max-time 1 "http://localhost:${p}/tester/api/status" 2>/dev/null || true)
  if [[ "$res" =~ \"online\":[[:space:]]*true ]]; then
    return 0
  fi
  return 1
}

resolve_active_port() {
  if [ "$CUSTOM_PORT_SET" = "true" ]; then
    return 0
  fi
  if [ -f "$URL_FILE" ]; then
    local saved_url saved_port
    saved_url=$(cat "$URL_FILE" 2>/dev/null || true)
    saved_port=$( (echo "$saved_url" | grep -oE ':[0-9]+' | tr -d ':') || true)
    if [ -n "$saved_port" ]; then
      if is_tester_service "$saved_port"; then
        PORT="$saved_port"
        return 0
      fi
    fi
  fi
  if ! is_tester_service "$PORT"; then
    local p
    for ((p=8082; p<=8092; p++)); do
      if is_tester_service "$p"; then
        PORT="$p"
        return 0
      fi
    done
  fi
  return 0
}

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
# Emulator Container Lifecycle & Readiness
# ------------------------------------------------------------------------------
check_emulator_ready() {
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "$EMULATOR_MGMT_URL/v1/emulator/tree" 2>/dev/null || echo "000")
  if [ "$code" = "200" ]; then
    return 0
  fi
  return 1
}

wait_for_emulator_ready() {
  local max_seconds="${1:-$EMULATOR_TIMEOUT}"
  local elapsed=0

  while [ "$elapsed" -lt "$max_seconds" ]; do
    if check_emulator_ready; then
      echo -ne "\r\033[K"
      return 0
    fi

    # Check if container died mid-boot
    if ! docker ps --format '{{.Names}}' | grep -Eq "^${CONTAINER_NAME}\$"; then
      echo -e "\n${YELLOW}Notice: Container stopped during boot. Attempting docker start...${NC}"
      docker start "$CONTAINER_NAME" 2>/dev/null || true
    fi

    sleep 1
    elapsed=$((elapsed + 1))
    echo -ne "\r${BLUE}Waiting for Apigee Emulator to become ready... (${elapsed}s / ${max_seconds}s)${NC}  "
  done
  echo -ne "\r\033[K"
  return 1
}

diagnose_emulator_failure() {
  echo -e "\n${RED}======================================================${NC}"
  echo -e "${RED}  Apigee Emulator Readiness Failure Diagnostics        ${NC}"
  echo -e "${RED}======================================================${NC}"
  echo -e "• Target Management URL: ${CYAN}$EMULATOR_MGMT_URL/v1/emulator/tree${NC}"

  # 1. Container status
  local container_status
  container_status=$(docker inspect -f '{{.State.Status}} (ExitCode: {{.State.ExitCode}})' "$CONTAINER_NAME" 2>/dev/null || echo "not found")
  echo -e "• Container Status:      ${YELLOW}$container_status${NC}"

  # 2. Port 8080 listener check
  local port_holder
  port_holder=$( (lsof -i :8080 2>/dev/null || ss -tulpn | grep 8080 2>/dev/null) | head -n 2 || true)
  if [ -n "$port_holder" ]; then
    echo -e "• Port 8080 Listener:\n$port_holder"
  fi

  # 3. HTTP response code
  local resp_code
  resp_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "$EMULATOR_MGMT_URL/v1/emulator/tree" 2>/dev/null || echo "Connection failed / refused")
  echo -e "• Last HTTP Status Code: ${YELLOW}$resp_code${NC}"

  # 4. Recent container logs
  echo -e "\n${BOLD}Recent Container Logs (last 20 lines):${NC}"
  docker logs --tail 20 "$CONTAINER_NAME" 2>&1 || true

  echo -e "\n${BOLD}Remediation Suggestions:${NC}"
  echo -e "  1) Run ${CYAN}./local.sh recreate${NC} to destroy and recreate the container cleanly."
  echo -e "  2) Restart container manually: ${CYAN}docker restart $CONTAINER_NAME${NC}"
  echo -e "  3) Inspect full logs: ${CYAN}docker logs $CONTAINER_NAME${NC}"
  echo -e "  4) If the machine is slow or busy, increase timeout: ${CYAN}EMULATOR_TIMEOUT=90 ./local.sh up${NC}"
  echo -e "${RED}======================================================${NC}\n"
}

configure_emulator_container() {
  docker exec "$CONTAINER_NAME" sh -c '
    if [ -f /opt/apigee/apigee-emulator/conf/keymanagement.properties ]; then
      sed -i "s/kms_cache_memory_element_enable=true/kms_cache_memory_element_enable=false/" /opt/apigee/apigee-emulator/conf/keymanagement.properties
      grep -q "kms_entity_cache_ttl_seconds" /opt/apigee/apigee-emulator/conf/keymanagement.properties || echo -e "\nkms_entity_cache_ttl_seconds=0" >> /opt/apigee/apigee-emulator/conf/keymanagement.properties
    fi
  ' 2>/dev/null || true
}

recreate_emulator() {
  check_prereqs
  echo -e "${YELLOW}Recreating Apigee Emulator container '${CONTAINER_NAME}'...${NC}"
  docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
  if [ -f "$ROOT_DIR/create.sh" ]; then
    echo -e "${BLUE}Creating container using ./create.sh...${NC}"
    "$ROOT_DIR/create.sh"
  else
    echo -e "${BLUE}Creating container ${CONTAINER_NAME}...${NC}"
    docker create --name "$CONTAINER_NAME" \
      -p 8080:8080 \
      -p 8888:8998 \
      -p 9042:9042 \
      gcr.io/apigee-release/hybrid/apigee-emulator:2.0.1
  fi
  echo -e "${BLUE}Starting container ${CONTAINER_NAME}...${NC}"
  docker start "$CONTAINER_NAME" >/dev/null
  configure_emulator_container
  if wait_for_emulator_ready "$EMULATOR_TIMEOUT"; then
    echo -e "${GREEN}✓ Apigee Emulator container recreated and ready.${NC}"
  else
    diagnose_emulator_failure
    exit 1
  fi
}

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
        -p 8888:8998 \
        -p 9042:9042 \
        gcr.io/apigee-release/hybrid/apigee-emulator:2.0.1
    fi
  fi

  # Check if container is running
  if ! docker ps --format '{{.Names}}' | grep -Eq "^${CONTAINER_NAME}\$"; then
    echo -e "${BLUE}Starting container ${CONTAINER_NAME}...${NC}"
    docker start "$CONTAINER_NAME" >/dev/null
    configure_emulator_container
  fi

  # Check if emulator is already responding
  if check_emulator_ready; then
    resolve_emulator_runtime_url
    return 0
  fi

  echo -e "${BLUE}Waiting for Apigee Emulator to become ready...${NC}"
  if wait_for_emulator_ready "$EMULATOR_TIMEOUT"; then
    echo -e "${GREEN}✓ Apigee Emulator container is ready.${NC}"
    resolve_emulator_runtime_url
    return 0
  fi

  # First attempt timed out: Attempt automatic restart retry
  echo -e "\n${YELLOW}Emulator not responding within ${EMULATOR_TIMEOUT}s. Attempting automatic container restart...${NC}"
  docker restart "$CONTAINER_NAME" >/dev/null 2>&1 || true

  if wait_for_emulator_ready "$EMULATOR_TIMEOUT"; then
    echo -e "${GREEN}✓ Apigee Emulator recovered and is ready.${NC}"
    return 0
  fi

  # Failed after retry: Print diagnostics
  diagnose_emulator_failure
  echo -e "${RED}Timeout waiting for Apigee Emulator to respond at $EMULATOR_MGMT_URL/v1/emulator/tree${NC}" >&2
  exit 1
}

# ------------------------------------------------------------------------------
# Service Management Commands
# ------------------------------------------------------------------------------
start_server() {
  local dev_mode="$1"
  ensure_emulator_running
  resolve_gcp_context

  # Check if tester service is already running
  if [ -f "$PID_FILE" ]; then
    local old_pid
    old_pid=$(cat "$PID_FILE" 2>/dev/null || true)
    if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
      resolve_active_port
      echo -e "${YELLOW}Apigee Emulator Service is already running (PID: $old_pid).${NC}"
      echo -e "  • ${BOLD}Web UI:${NC}  ${GREEN}http://localhost:${PORT}/${NC}"
      echo -e "  • ${BOLD}Hint:${NC}    Call ${CYAN}./local.sh stop${NC} to stop all services.\n"
      return 0
    fi
  fi

  rm -f "$URL_FILE"

  echo -e "${BOLD}Starting Apigee Emulator Service...${NC}"
  if [ -n "$PROJECT_ID" ]; then
    echo -e "  • ${BOLD}Project:${NC} ${CYAN}$PROJECT_ID${NC}"
  fi
  echo -e "  • ${BOLD}Waiting for service to bind and start...${NC}"

  resolve_emulator_runtime_url

  if [ "$dev_mode" = "true" ]; then
    setsid env PORT="$PORT" EMULATOR_RUNTIME_URL="$EMULATOR_RUNTIME_URL" bun --watch run src/index.ts </dev/null > "$LOG_FILE" 2>&1 &
  else
    setsid env PORT="$PORT" EMULATOR_RUNTIME_URL="$EMULATOR_RUNTIME_URL" bun run src/index.ts </dev/null > "$LOG_FILE" 2>&1 &
  fi
  local bun_pid=$!
  echo "$bun_pid" > "$PID_FILE"

  local tries=0
  local max_tries=100
  local final_url=""

  while [ $tries -lt $max_tries ]; do
    if ! kill -0 "$bun_pid" 2>/dev/null; then
      echo -e "${RED}Error: Server process exited unexpectedly.${NC}" >&2
      if [ -f "$LOG_FILE" ]; then
        echo -e "${YELLOW}Server logs:${NC}" >&2
        tail -n 25 "$LOG_FILE" >&2
      fi
      rm -f "$URL_FILE" "$PID_FILE"
      return 1
    fi

    if [ -f "$URL_FILE" ]; then
      final_url="$(cat "$URL_FILE" 2>/dev/null || true)"
      if [ -n "$final_url" ]; then
        break
      fi
    fi

    # Fallback port check if URL_FILE was not written yet
    local p
    for ((p=PORT; p<=PORT+10; p++)); do
      if is_tester_service "$p"; then
        final_url="http://localhost:${p}/"
        echo "$final_url" > "$URL_FILE" 2>/dev/null || true
        break 2
      fi
    done

    sleep 0.1
    tries=$((tries + 1))
  done

  if [ -n "$final_url" ]; then
    local final_port
    final_port=$( (echo "$final_url" | grep -oE ':[0-9]+' | tr -d ':') || echo "$PORT")
    PORT="$final_port"
    echo -e "\n${GREEN}✓ Apigee Emulator Service is running in the background.${NC}"
    echo -e "  • ${BOLD}Web UI:${NC}  ${GREEN}${final_url}${NC}"
    echo -e "  • ${BOLD}Logs:${NC}    tail -f ${LOG_FILE}"
    echo -e "  • ${BOLD}Hint:${NC}    Call ${CYAN}./local.sh stop${NC} to stop all services (emulator and tester).\n"
  else
    echo -e "\n${YELLOW}Warning: Could not confirm server startup URL within timeout.${NC}"
    echo -e "  • ${BOLD}Hint:${NC}    Call ${CYAN}./local.sh stop${NC} to stop all services.\n"
  fi
}

deploy_resource() {
  local target="$1"
  local reset="${2:-true}"

  ensure_emulator_running
  resolve_gcp_context
  resolve_active_port

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

  resolve_emulator_runtime_url

  # Run the Bun TypeScript deployer directly
  GOOGLE_CLOUD_PROJECT="$PROJECT_ID" \
  GOOGLE_CLOUD_LOCATION="$REGION" \
  PORT="$PORT" \
  EMULATOR_RUNTIME_URL="$EMULATOR_RUNTIME_URL" \
  bun run src/index.ts --deploy "$target" $reset_flag --no-server

  echo -e "\n${GREEN}Deployment finished successfully.${NC}"
  echo -e "Open Hub UI: ${CYAN}http://localhost:${PORT}/${NC}"
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
  resolve_active_port
  resolve_emulator_runtime_url

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
    EMULATOR_RUNTIME_URL="$EMULATOR_RUNTIME_URL" \
    bun run src/index.ts --test ${proxy_name:+"$proxy_name"} --no-server
  fi
}

check_status() {
  resolve_gcp_context
  resolve_active_port
  resolve_emulator_runtime_url

  local tester_pid=""
  if [ -f "$PID_FILE" ]; then
    tester_pid=$(cat "$PID_FILE" 2>/dev/null || true)
    if [ -n "$tester_pid" ] && ! kill -0 "$tester_pid" 2>/dev/null; then
      tester_pid=""
    fi
  fi
  if [ -z "$tester_pid" ]; then
    tester_pid=$(pgrep -f "bun.*src/index\.ts" 2>/dev/null | head -n 1 || true)
  fi

  echo -e "${BOLD}Local Apigee Emulator Status:${NC}"
  echo -e "  • ${BOLD}Docker Container:${NC} " $(docker ps --filter "name=${CONTAINER_NAME}" --format '{{.Status}}' 2>/dev/null || echo "Not running")
  echo -e "  • ${BOLD}Tester Service:${NC}   " $([ -n "$tester_pid" ] && echo "Running (PID: $tester_pid)" || echo "Not running")
  echo -e "  • ${BOLD}Management API:${NC}   $EMULATOR_MGMT_URL"
  echo -e "  • ${BOLD}Runtime Port:${NC}     $EMULATOR_RUNTIME_URL"
  echo -e "  • ${BOLD}Web UI:${NC}           http://localhost:${PORT}/"
  if [ -n "$PROJECT_ID" ]; then
    echo -e "  • ${BOLD}GCP Project:${NC}      ${CYAN}$PROJECT_ID${NC}"
  fi

  # Check health
  local health_code
  health_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "$EMULATOR_MGMT_URL/v1/emulator/tree" 2>/dev/null || echo "000")
  if [ "$health_code" = "200" ]; then
    echo -e "\n${BOLD}Emulator Health:${NC} ${GREEN}Online (Management API ready)${NC}"
  else
    echo -e "\n${YELLOW}Emulator management API is offline or not responding (HTTP ${health_code}).${NC}"
  fi

  # Query Tester API if server is up
  local tester_status
  tester_status=$(curl -s --max-time 2 "http://localhost:${PORT}/tester/api/status" 2>/dev/null || true)
  if [ -n "$tester_status" ]; then
    echo -e "\n${BOLD}Deployed Proxies & Bundles (from Tester Service):${NC}"
    echo "$tester_status" | jq -r '.bundles[] | "  • \(.proxyName) (Deployed: \(.isDeployed), Routes: \(.targetRoutes | join(", ")))"' 2>/dev/null || true
  else
    # Query Emulator directly for deployment tree
    local tree
    tree=$(curl -s --max-time 2 "$EMULATOR_MGMT_URL/v1/emulator/tree" 2>/dev/null || true)
    if [ -n "$tree" ] && [ "$tree" != "[]" ]; then
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
  echo -e "${YELLOW}Stopping all local services...${NC}"

  # 1. Stop local tester service via PID file if present
  local stopped_tester="false"
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE" 2>/dev/null || true)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo -e "${YELLOW}Stopping Apigee Emulator Tester service (PID: $pid)...${NC}"
      kill -TERM "$pid" 2>/dev/null || true
      local w=0
      while [ $w -lt 30 ] && kill -0 "$pid" 2>/dev/null; do
        sleep 0.1
        w=$((w + 1))
      done
      if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
      fi
      stopped_tester="true"
    fi
    rm -f "$PID_FILE"
  fi

  # 2. Kill any other local tester service processes running bun src/index.ts
  local remaining_pids
  remaining_pids=$(pgrep -f "bun.*src/index\.ts" 2>/dev/null || true)
  if [ -n "$remaining_pids" ]; then
    echo -e "${YELLOW}Stopping remaining local tester service processes ($remaining_pids)...${NC}"
    for rpid in $remaining_pids; do
      kill -TERM "$rpid" 2>/dev/null || true
    done
    sleep 0.5
    for rpid in $remaining_pids; do
      if kill -0 "$rpid" 2>/dev/null; then
        kill -9 "$rpid" 2>/dev/null || true
      fi
    done
    stopped_tester="true"
  fi

  rm -f "$URL_FILE" "$PID_FILE"

  if [ "$stopped_tester" = "true" ]; then
    echo -e "${GREEN}✓ Local tester service stopped.${NC}"
  else
    echo -e "${BLUE}Local tester service was not running.${NC}"
  fi

  # 3. Stop Apigee Emulator Docker container
  echo -e "${YELLOW}Stopping Apigee Emulator container...${NC}"
  docker stop "$CONTAINER_NAME" 2>/dev/null || true
  echo -e "${GREEN}✓ Emulator container stopped.${NC}"
  echo -e "${GREEN}All local services stopped.${NC}"
}

start_trace() {
  local proxy_name="$1"
  resolve_emulator_runtime_url
  if [ -z "$proxy_name" ]; then
    echo -e "${RED}Usage: ./local.sh trace-start <PROXY_NAME>${NC}" >&2
    exit 1
  fi
  echo -e "${BLUE}Starting debug trace session for ${BOLD}$proxy_name${NC}...${NC}"
  local session
  session=$(curl -s -X POST "$EMULATOR_MGMT_URL/v1/emulator/trace?proxyName=${proxy_name}")
  echo "$session" > "$SESSION_FILE"
  local session_id
  session_id=$(echo "$session" | jq -r '.name // .id // empty' 2>/dev/null || true)
  if [ -n "$session_id" ]; then
    echo -e "${GREEN}Trace session active:${NC} $session_id"
    echo -e "Send traffic to ${EMULATOR_RUNTIME_URL} and then run: ${CYAN}./local.sh trace-stop${NC}"
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
  session_id=$(echo "$session_data" | jq -r '.name // .id // empty' 2>/dev/null || true)

  if [ -z "$session_id" ]; then
    echo -e "${RED}Invalid session data in $SESSION_FILE${NC}" >&2
    return 1
  fi

  echo -e "${BLUE}Downloading recorded trace transactions for session $session_id...${NC}"
  curl -s "$EMULATOR_MGMT_URL/v1/emulator/trace/transactions?sessionid=$session_id" > trace.json
  rm -f "$SESSION_FILE"
  echo -e "${GREEN}Transactions saved to trace.json.${NC}"
  resolve_active_port
  echo -e "Open ${CYAN}http://localhost:${PORT}/${NC} to visualize."
}

# ------------------------------------------------------------------------------
# Help Function
# ------------------------------------------------------------------------------
show_help() {
  echo -e "${BOLD}Usage:${NC}"
  echo "  ./local.sh [OPTION | COMMAND] [ARGUMENTS]"
  echo ""
  echo -e "${BOLD}Menu Options (1-10):${NC}"
  echo "  1)  --start, --up                 Start Apigee container and launch local tester service in background"
  echo "  2)  --deploy [FILE]               Deploy a deployment YAML or bundle (default: data/deployments/deployment-1.yaml)"
  echo "  3)  --deploy-all, -a, --all       Deploy all deployments in 'data/deployments/'"
  echo "  4)  --test [PROXY]                Run proxy tests against local runtime (all or specific proxy)"
  echo "  5)  --status                      Check container health, deployed proxies, and tester UI"
  echo "  6)  --ui, --tester                Print and open Tester Web UI in browser"
  echo "  7)  --reset                       Reset local emulator state via API"
  echo "  8)  --recreate                    Destroy and recreate emulator container with fresh state"
  echo "  9)  --clean [OPTIONS]             Remove generated assets, reset emulator, or start fresh (clean.sh)"
  echo "  10) --stop                        Stop all services (emulator container & local tester)"
  echo ""
  echo -e "${BOLD}Additional Commands & Options:${NC}"
  echo "  --logs, logs                      View Docker container logs"
  echo "  --trace-start [PROXY]             Start trace recording session for a proxy"
  echo "  --trace-stop                      Stop trace session and download trace.json"
  echo "  -l, --list                        List available deployments and bundles"
  echo "  --project [ID]                    Set GCP Project ID for {GOOGLE_CLOUD_PROJECT} substitution"
  echo "  --region [REGION]                 Set GCP Region / Location (default: global)"
  echo "  --port [PORT]                     Set tester server port (default: 8082)"
  echo "  --dev                             Run server in Bun watch/dev mode"
  echo "  -p, --parameters P                Pass additional parameters (key=val,key2=val2)"
  echo "  -h, --help                        Show this help message"
  echo ""
  echo -e "${BOLD}Note:${NC} Positional commands without dashes (e.g. 'start', 'deploy', 'test', 'status') are also supported."
  echo ""
  echo -e "${BOLD}Examples:${NC}"
  echo "  # Start server and emulator in background (Option 1):"
  echo "  ./local.sh --start"
  echo ""
  echo "  # Deploy deployment-1.yaml (Option 2):"
  echo "  ./local.sh --deploy data/deployments/deployment-1.yaml"
  echo ""
  echo "  # Deploy all deployments (Option 3):"
  echo "  ./local.sh --deploy-all"
  echo ""
  echo "  # Run proxy tests (Option 4):"
  echo "  ./local.sh --test REST-AI-Interactions"
  echo ""
  echo "  # Check status (Option 5):"
  echo "  ./local.sh --status"
  echo ""
  echo "  # Open Web UI (Option 6):"
  echo "  ./local.sh --ui"
  echo ""
  echo "  # Reset emulator state (Option 7):"
  echo "  ./local.sh --reset"
  echo ""
  echo "  # Recreate emulator container (Option 8):"
  echo "  ./local.sh --recreate"
  echo ""
  echo "  # Clean generated assets (Option 9):"
  echo "  ./local.sh --clean"
  echo ""
  echo "  # Stop all services (Option 10):"
  echo "  ./local.sh --stop"
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
  echo "  1) Start Local Server & Emulator in Background   (--start / --up)"
  echo "  2) Deploy deployment-1.yaml                     (--deploy [FILE])"
  echo "  3) Deploy all deployments                       (--deploy-all)"
  echo "  4) Run Test Suite                               (--test [PROXY])"
  echo "  5) Check Status & Deployed Proxies              (--status)"
  echo "  6) Open Tester Web UI in Browser                (--ui / --tester)"
  echo "  7) Reset Emulator State (API reset)             (--reset)"
  echo "  8) Recreate Emulator Container (Fresh State)    (--recreate)"
  echo "  9) Clean Generated Assets & Reset Emulator      (--clean)"
  echo "  10) Stop All Services (Emulator & Tester)       (--stop)"
  echo "  11) Exit"
  echo ""
  read -rp "Select an option [1-11] (default: 1): " choice
  choice="${choice:-1}"

  case "$choice" in
    1) start_server false ;;
    2) deploy_resource "data/deployments/deployment-1.yaml" "true" ;;
    3) deploy_all ;;
    4) run_tests ;;
    5) check_status ;;
    6)
      resolve_active_port
      local url="http://localhost:${PORT}/"
      echo -e "Opening ${CYAN}$url${NC}..."
      if command -v xdg-open &>/dev/null; then
        xdg-open "$url" 2>/dev/null || true
      elif command -v open &>/dev/null; then
        open "$url" 2>/dev/null || true
      fi
      ;;
    7) reset_emulator ;;
    8) recreate_emulator ;;
    9) "$ROOT_DIR/clean.sh" ;;
    10) stop_all ;;
    11) exit 0 ;;
    *) echo -e "${RED}Invalid choice.${NC}" ;;
  esac
}

# ------------------------------------------------------------------------------
# CLI Argument Parsing
# ------------------------------------------------------------------------------
COMMAND=""
TARGET_FILE=""
DEV_MODE="false"
CLEAN_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      show_help
      exit 0
      ;;
    --start|--up|up|start)
      COMMAND="start"
      shift
      ;;
    --deploy|deploy)
      COMMAND="deploy"
      shift
      if [ -n "${1:-}" ] && [[ "$1" != -* ]]; then
        TARGET_FILE="$1"
        shift
      fi
      ;;
    --deploy-all|deploy-all|-a|--all)
      COMMAND="deploy-all"
      shift
      ;;
    --test|test)
      COMMAND="test"
      shift
      if [ -n "${1:-}" ] && [[ "$1" != -* ]]; then
        TARGET_FILE="$1"
        shift
      fi
      ;;
    --status|status)
      COMMAND="status"
      shift
      ;;
    --ui|--tester|tester|ui)
      COMMAND="ui"
      shift
      ;;
    --reset|reset)
      COMMAND="reset"
      shift
      ;;
    --recreate|recreate)
      COMMAND="recreate"
      shift
      ;;
    --clean|clean)
      COMMAND="clean"
      shift
      CLEAN_ARGS=("$@")
      break
      ;;
    --stop|stop)
      COMMAND="stop"
      shift
      ;;
    --logs|logs)
      COMMAND="logs"
      shift
      ;;
    --trace-start|trace-start)
      COMMAND="trace-start"
      shift
      if [ -n "${1:-}" ] && [[ "$1" != -* ]]; then
        TARGET_FILE="$1"
        shift
      fi
      ;;
    --trace-stop|trace-stop)
      COMMAND="trace-stop"
      shift
      ;;
    --dev)
      DEV_MODE="true"
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
      CUSTOM_PORT_SET="true"
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
    resolve_active_port
    echo -e "Web UI URL: ${CYAN}http://localhost:${PORT}/${NC}"
    if command -v xdg-open &>/dev/null; then
      xdg-open "http://localhost:${PORT}/" 2>/dev/null || true
    elif command -v open &>/dev/null; then
      open "http://localhost:${PORT}/" 2>/dev/null || true
    fi
    ;;
  reset)
    reset_emulator
    ;;
  recreate)
    recreate_emulator
    ;;
  clean)
    exec "$ROOT_DIR/clean.sh" "${CLEAN_ARGS[@]}"
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
