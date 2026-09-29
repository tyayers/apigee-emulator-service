#!/usr/bin/env bash
# ==============================================================================
# clean.sh - Clean generated assets, reset Apigee Emulator, and start fresh
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$SCRIPT_DIR/data"
DEPLOYMENTS_DIR="$DATA_DIR/deployments"
CONTAINER_NAME="apigee"
EMULATOR_MGMT_URL="${APIGEE_EMULATOR_URL:-http://127.0.0.1:8080}"
PID_FILE="$SCRIPT_DIR/.local_server.pid"
URL_FILE="$SCRIPT_DIR/.local_url"

# Text styles
BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

# Defaults
MODE_RESET="api"        # api, recreate, or none
START_FRESH="false"     # true -> redeploy & start service after clean
DEPLOY_TARGET=""        # deployment YAML file or "all"
PROJECT_ID=""
REGION="global"

show_help() {
  echo -e "${BOLD}Usage:${NC}"
  echo "  ./clean.sh [OPTIONS]"
  echo ""
  echo -e "${BOLD}Description:${NC}"
  echo "  Removes all generated assets and build artifacts, preserving only 'data/deployments/'."
  echo "  Easily resets or recreates the Apigee Emulator, and can start fresh by regenerating"
  echo "  everything from deployment YAML."
  echo ""
  echo -e "${BOLD}Options:${NC}"
  echo "  --reset             Reset Apigee Emulator state via API (default if container is running)"
  echo "  --recreate          Destroy and recreate the Apigee Emulator Docker container (clean state)"
  echo "  --no-reset          Do not reset or touch the Apigee Emulator"
  echo "  -f, --fresh         Clean assets, reset/recreate emulator, regenerate from deployment, and start tester UI"
  echo "  -d, --deploy [FILE] Deploy specific deployment YAML after clean (default: data/deployments/deployment-1.yaml)"
  echo "  -a, --all           Deploy all deployments in data/deployments/ after clean"
  echo "  --project [ID]      Set GCP Project ID for variable substitution (default: auto-detected or aigateway-lab8)"
  echo "  --region [REGION]   Set GCP Region / Location (default: global)"
  echo "  -h, --help          Show this help message"
  echo ""
  echo -e "${BOLD}Examples:${NC}"
  echo "  # Clean all generated assets and reset emulator state:"
  echo "  ./clean.sh"
  echo ""
  echo "  # Clean assets and completely recreate the emulator container:"
  echo "  ./clean.sh --recreate"
  echo ""
  echo "  # Complete fresh start: clean, recreate container, regenerate & deploy, start UI:"
  echo "  ./clean.sh --recreate --fresh"
  echo ""
  echo "  # Clean and redeploy a specific deployment YAML:"
  echo "  ./clean.sh --deploy data/deployments/deployment-1.yaml"
}

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --reset)
      MODE_RESET="api"
      shift
      ;;
    --recreate)
      MODE_RESET="recreate"
      shift
      ;;
    --no-reset)
      MODE_RESET="none"
      shift
      ;;
    -f|--fresh)
      START_FRESH="true"
      if [ -z "$DEPLOY_TARGET" ]; then
        DEPLOY_TARGET="data/deployments/deployment-1.yaml"
      fi
      shift
      ;;
    -d|--deploy)
      START_FRESH="true"
      if [[ $# -gt 1 && ! "$2" =~ ^- ]]; then
        DEPLOY_TARGET="$2"
        shift 2
      else
        DEPLOY_TARGET="data/deployments/deployment-1.yaml"
        shift
      fi
      ;;
    -a|--all)
      START_FRESH="true"
      DEPLOY_TARGET="all"
      shift
      ;;
    --project)
      PROJECT_ID="${2:-}"
      shift 2
      ;;
    --region)
      REGION="${2:-global}"
      shift 2
      ;;
    -h|--help)
      show_help
      exit 0
      ;;
    *)
      if [ -f "$1" ]; then
        START_FRESH="true"
        DEPLOY_TARGET="$1"
        shift
      else
        echo -e "${RED}Unknown argument: $1${NC}"
        show_help
        exit 1
      fi
      ;;
  esac
done

echo -e "${BOLD}======================================================${NC}"
echo -e "${BOLD}       Apigee Emulator Clean & Reset Utility          ${NC}"
echo -e "${BOLD}======================================================${NC}"

# 1. Stop local tester server if running
echo -e "\n${BOLD}[1/3] Checking running tester services...${NC}"
stopped_any="false"
if [ -f "$PID_FILE" ]; then
  pid=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo -e "Stopping local tester server (PID: $pid)..."
    kill -TERM "$pid" 2>/dev/null || true
    sleep 0.5
    kill -9 "$pid" 2>/dev/null || true
    stopped_any="true"
  fi
  rm -f "$PID_FILE"
fi

remaining_pids=$(pgrep -f "bun.*src/index\.ts" 2>/dev/null || true)
if [ -n "$remaining_pids" ]; then
  echo -e "Stopping remaining local tester service processes ($remaining_pids)..."
  for rpid in $remaining_pids; do
    kill -TERM "$rpid" 2>/dev/null || true
  done
  sleep 0.5
  for rpid in $remaining_pids; do
    if kill -0 "$rpid" 2>/dev/null; then
      kill -9 "$rpid" 2>/dev/null || true
    fi
  done
  stopped_any="true"
fi
rm -f "$URL_FILE"

if [ "$stopped_any" = "true" ]; then
  echo -e "${GREEN}✓ Local tester service stopped.${NC}"
else
  echo -e "${BLUE}• No running local tester service detected.${NC}"
fi

# 2. Clean generated assets, preserving only data/deployments
echo -e "\n${BOLD}[2/3] Cleaning generated assets...${NC}"

deleted_count=0
if [ -d "$DATA_DIR" ]; then
  for item in "$DATA_DIR"/*; do
    [ -e "$item" ] || continue
    base=$(basename "$item")
    if [ "$base" != "deployments" ]; then
      rm -rf "$item"
      echo -e "  • Removed ${YELLOW}data/$base${NC}"
      deleted_count=$((deleted_count + 1))
    fi
  done

  # Check any hidden items in data/
  shopt -s nullglob
  for item in "$DATA_DIR"/.*; do
    base=$(basename "$item")
    if [ "$base" != "." ] && [ "$base" != ".." ] && [ "$base" != "deployments" ]; then
      rm -rf "$item"
      echo -e "  • Removed ${YELLOW}data/$base${NC}"
      deleted_count=$((deleted_count + 1))
    fi
  done
  shopt -u nullglob
fi

# Clean root build & runtime artifacts
ROOT_ARTIFACTS=(
  "dist"
  "proxies"
  "bundles"
  "templates"
  "datacollectors"
  "developerapps"
  "developers"
  "maps"
  "products"
  "tests.json"
  "trace.json"
  ".trace_session"
  ".local_trace_session"
  ".local_url"
  ".local_server.pid"
  ".local_server.log"
  ".cloudrun_url"
  ".cloudrun_trace_session"
  "lab-participants.json"
  "lab-usage.json"
)

for art in "${ROOT_ARTIFACTS[@]}"; do
  target="$SCRIPT_DIR/$art"
  if [ -e "$target" ]; then
    rm -rf "$target"
    echo -e "  • Removed ${YELLOW}$art${NC}"
    deleted_count=$((deleted_count + 1))
  fi
done

echo -e "${GREEN}✓ Asset clean complete ($deleted_count item(s) cleaned).${NC}"
echo -e "${GREEN}✓ Preserved: ${CYAN}data/deployments/${NC}"

# 3. Reset or recreate Apigee Emulator
echo -e "\n${BOLD}[3/3] Apigee Emulator state management...${NC}"
container_running="false"
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER_NAME}$"; then
  container_running="true"
fi

case "$MODE_RESET" in
  recreate)
    echo -e "${YELLOW}Recreating Apigee Emulator container '${CONTAINER_NAME}'...${NC}"
    if [ -x "$SCRIPT_DIR/local.sh" ]; then
      "$SCRIPT_DIR/local.sh" recreate
    else
      docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
      if [ -f "$SCRIPT_DIR/create.sh" ]; then
        "$SCRIPT_DIR/create.sh"
      else
        docker create --name "$CONTAINER_NAME" -p 8080:8080 -p 8998:8998 -p 9042:9042 gcr.io/apigee-release/hybrid/apigee-emulator:2.0.1
      fi
      docker start "$CONTAINER_NAME" >/dev/null
    fi
    echo -e "${GREEN}✓ Apigee Emulator container recreated cleanly.${NC}"
    ;;
  api)
    if [ "$container_running" = "true" ]; then
      echo -e "Resetting emulator state via API (${CYAN}$EMULATOR_MGMT_URL/v1/emulator/reset${NC})..."
      resp=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$EMULATOR_MGMT_URL/v1/emulator/reset" 2>/dev/null || echo "failed")
      if [ "$resp" = "201" ] || [ "$resp" = "200" ]; then
        echo -e "${GREEN}✓ Emulator state reset successfully.${NC}"
      else
        echo -e "${YELLOW}! API reset returned status $resp.${NC}"
      fi
      echo -e "Restarting emulator container to clear in-memory runtime caches..."
      docker restart "$CONTAINER_NAME" >/dev/null 2>&1 || true
      max_retries=30
      retry=0
      while [ $retry -lt $max_retries ]; do
        code=$(curl -s -o /dev/null -w "%{http_code}" "$EMULATOR_MGMT_URL/v1/emulator/status" 2>/dev/null || true)
        if [ "$code" = "200" ] || [ "$code" = "404" ]; then
          break
        fi
        sleep 1
        retry=$((retry + 1))
      done
      echo -e "${GREEN}✓ Emulator container ready.${NC}"
    else
      echo -e "${BLUE}• Emulator container '${CONTAINER_NAME}' is not running.${NC}"
      echo -e "  Start it anytime with: ${CYAN}./local.sh up${NC} or ${CYAN}./clean.sh --fresh${NC}"
    fi
    ;;
  none)
    echo -e "${BLUE}• Emulator reset skipped (--no-reset).${NC}"
    ;;
esac

# 4. Optional: Start fresh by regenerating and deploying
if [ "$START_FRESH" = "true" ]; then
  echo -e "\n${BOLD}======================================================${NC}"
  echo -e "${BOLD}       Regenerating & Starting Fresh                  ${NC}"
  echo -e "${BOLD}======================================================${NC}"

  # Ensure emulator is running
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER_NAME}$"; then
    echo -e "${BLUE}Starting emulator container '${CONTAINER_NAME}'...${NC}"
    docker start "$CONTAINER_NAME" 2>/dev/null || {
      if [ -x "$SCRIPT_DIR/local.sh" ]; then
        "$SCRIPT_DIR/local.sh" recreate
      fi
    }
  fi

  # Deploy target
  EXTRA_ARGS=()
  if [ -n "$PROJECT_ID" ]; then
    EXTRA_ARGS+=(--project "$PROJECT_ID")
  fi
  if [ -n "$REGION" ]; then
    EXTRA_ARGS+=(--region "$REGION")
  fi

  if [ "$DEPLOY_TARGET" = "all" ]; then
    echo -e "Deploying all deployments from data/deployments/..."
    "$SCRIPT_DIR/local.sh" deploy --all "${EXTRA_ARGS[@]}"
  else
    echo -e "Deploying ${CYAN}${DEPLOY_TARGET}${NC}..."
    "$SCRIPT_DIR/local.sh" deploy "${EXTRA_ARGS[@]}" "$DEPLOY_TARGET"
  fi

  # Start server in background if not already running
  echo -e "\nLaunching local tester service..."
  "$SCRIPT_DIR/local.sh" start "${EXTRA_ARGS[@]}"
else
  echo -e "\n${BOLD}Done! Everything is clean.${NC}"
  echo -e "To start fresh and regenerate assets from deployment YAML, run:"
  echo -e "  ${CYAN}./local.sh deploy data/deployments/deployment-1.yaml${NC}"
  echo -e "  ${CYAN}./local.sh start${NC}"
  echo -e "Or next time, run in one step:"
  echo -e "  ${CYAN}./clean.sh --fresh${NC} (or ${CYAN}./clean.sh --recreate --fresh${NC})"
fi
