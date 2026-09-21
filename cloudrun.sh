#!/bin/bash
# ==============================================================================
# Apigee Emulator Cloud Run Deployment & Management Script
#
# Deploys the Apigee Emulator with an Envoy ingress sidecar to Google Cloud Run,
# and automates proxy compilation and deployment (both YAML and ZIP bundles)
# as well as traffic testing and tracing against the Cloud Run endpoint.
#
# USAGE:
#   1. Deploy containers to Cloud Run:
#        ./cloudrun.sh deploy-service --project --region
#
#   2. Deploy a YAML proxy, template, or feature to Cloud Run:
#        ./cloudrun.sh proxies/TestProxy.yaml
#        ./cloudrun.sh templates/REST-AI-Completions.yaml
#        ./cloudrun.sh features/ai-endpoint-completions.yaml
#
#   3. Deploy a ZIP bundle to Cloud Run:
#        ./cloudrun.sh dist/TestProxy.zip
#
#   4. Deploy all templates at once:
#        ./cloudrun.sh --all
#
#   5. Check status, inspect active proxies, or test traffic:
#        ./cloudrun.sh status
#        ./cloudrun.sh test /testproxy
#        ./cloudrun.sh trace-start [PROXY_NAME]
#        ./cloudrun.sh trace-stop
#
#   6. Interactive menu (default when run with no arguments):
#        ./cloudrun.sh
# ==============================================================================

if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
  echo -e "\033[1;31mError: cloudrun.sh must be executed directly, not sourced.\033[0m" >&2
  echo -e "Please run:\n  \033[1;32m./cloudrun.sh\033[0m" >&2
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
SERVICE_NAME="${SERVICE_NAME:-apigee-emulator}"
SERVICE_YAML="${SERVICE_YAML:-$ROOT_DIR/cloudrun-service.yaml}"
URL_FILE="$ROOT_DIR/.cloudrun_url"
SESSION_FILE="$ROOT_DIR/.cloudrun_trace_session"

# Discover GCP Project & Region
resolve_gcp_context() {
  if [ -z "$PROJECT_ID" ]; then
    PROJECT_ID="${GCP_PROJECT:-${CLOUDSDK_CORE_PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}}"
  fi
  if [ -z "$REGION" ]; then
    REGION="${GCP_REGION:-${CLOUDSDK_COMPUTE_REGION:-$(gcloud config get-value run/region 2>/dev/null || true)}}"
  fi
  if [ -z "$REGION" ]; then
    REGION="europe-west1"
  fi
}

# ------------------------------------------------------------------------------
# Service URL Resolution & Authenticated Curl Wrapper
# ------------------------------------------------------------------------------
get_service_url() {
  if [ -n "$CLOUDRUN_URL" ]; then
    echo "$CLOUDRUN_URL" | sed 's:/*$::'
    return 0
  fi

  if [ -f "$URL_FILE" ]; then
    local cached_url
    cached_url=$(cat "$URL_FILE" 2>/dev/null | tr -d '[:space:]')
    if [ -n "$cached_url" ]; then
      echo "$cached_url" | sed 's:/*$::'
      return 0
    fi
  fi

  resolve_gcp_context
  if [ -n "$PROJECT_ID" ] && command -v gcloud &>/dev/null; then
    local queried_url
    queried_url=$(gcloud run services describe "$SERVICE_NAME" \
      --region "$REGION" \
      --project "$PROJECT_ID" \
      --format 'value(status.url)' 2>/dev/null || true)
    if [ -n "$queried_url" ]; then
      echo "$queried_url" | tr -d '[:space:]' | sed 's:/*$::' > "$URL_FILE"
      echo "$queried_url" | tr -d '[:space:]' | sed 's:/*$::'
      return 0
    fi
  fi

  return 1
}

curl_cr() {
  local auth_header=()
  if [[ "$USE_AUTH" == "true" ]] && command -v gcloud &>/dev/null; then
    local token
    token=$(gcloud auth print-identity-token 2>/dev/null || true)
    if [ -n "$token" ]; then
      auth_header=(-H "Authorization: Bearer $token")
    fi
  fi
  curl "${auth_header[@]}" "$@"
}

# ------------------------------------------------------------------------------
# Prerequisites Checking
# ------------------------------------------------------------------------------
check_proxy_prereqs() {
  local missing=()
  for cmd in aft curl zip unzip python3; do
    if ! command -v "$cmd" &>/dev/null; then
      missing+=("$cmd")
    fi
  done

  if [ ${#missing[@]} -gt 0 ]; then
    echo -e "${RED}Error: Missing required build tool(s): ${missing[*]}${NC}" >&2
    echo "Please install the missing tools and try again." >&2
    exit 1
  fi

  if ! python3 -c "import yaml" &>/dev/null; then
    echo -e "${RED}Error: Python module 'pyyaml' is required.${NC}" >&2
    echo "Please install it with: pip3 install pyyaml" >&2
    exit 1
  fi
}

check_service_prereqs() {
  if ! command -v gcloud &>/dev/null; then
    echo -e "${RED}Error: 'gcloud' CLI is required to deploy to Cloud Run.${NC}" >&2
    exit 1
  fi
}

# ------------------------------------------------------------------------------
# Discovery Helpers
# ------------------------------------------------------------------------------
get_available_proxies() {
  find proxies -maxdepth 1 -name "*.yaml" -type f 2>/dev/null | sort
}

get_available_templates() {
  find templates -maxdepth 1 -name "*.yaml" -type f 2>/dev/null | sort
}

get_available_features() {
  find features -maxdepth 1 -name "*.yaml" -type f 2>/dev/null | sort
}

get_available_zips() {
  find dist -maxdepth 1 -name "*.zip" -type f 2>/dev/null | grep -v "bundle.zip" | grep -v "testdata.zip" | sort
}

# ------------------------------------------------------------------------------
# Help / Usage Function
# ------------------------------------------------------------------------------
show_help() {
  echo -e "${BOLD}Usage:${NC}"
  echo "  ./cloudrun.sh [COMMAND] [OPTIONS] [FILES...]"
  echo ""
  echo -e "${BOLD}Service Management Commands:${NC}"
  echo "  deploy-service, up     Deploy Envoy + Apigee Emulator service to Cloud Run"
  echo "  status                 Check service URL, health, and currently deployed proxies"
  echo "  url                    Display current Cloud Run service URL"
  echo "  tester, manage         Open/display the Apigee Emulator Tester Web UI URL"
  echo "  logs                   Tail Cloud Run service logs"
  echo "  reset                  Reset Apigee emulator state on Cloud Run"
  echo "  delete                 Delete the Cloud Run service"
  echo ""
  echo -e "${BOLD}Proxy & Traffic Commands:${NC}"
  echo "  deploy [FILE...]       Deploy YAML proxy/template/feature or ZIP bundle(s)"
  echo "  test [PATH]            Send a test request to deployed proxy (e.g. /testproxy)"
  echo "  trace-start [PROXY]    Start trace recording session on Cloud Run"
  echo "  trace-stop             Stop trace session and download trace.json"
  echo ""
  echo -e "${BOLD}Options:${NC}"
  echo "  -a, --all              Deploy all templates from 'templates/' to Cloud Run"
  echo "  -l, --list             List available proxies, templates, and features"
  echo "  --project PROJECT_ID   Override GCP Project ID"
  echo "  --region REGION        Override Cloud Run region (default: europe-west1)"
  echo "  --service SERVICE_NAME Override Cloud Run service name (default: apigee-emulator)"
  echo "  --url URL              Directly target an existing Cloud Run or custom URL"
  echo "  --auth                 Send gcloud identity token with all requests"
  echo "  -h, --help             Show this help message"
  echo ""
  echo -e "${BOLD}Examples:${NC}"
  echo "  # 1. Deploy the containers to Cloud Run:"
  echo "  ./cloudrun.sh deploy-service"
  echo ""
  echo "  # 2. Deploy a YAML proxy or template to Cloud Run:"
  echo "  ./cloudrun.sh proxies/TestProxy.yaml"
  echo "  ./cloudrun.sh templates/REST-AI-Completions.yaml"
  echo ""
  echo "  # 3. Deploy a ZIP bundle to Cloud Run:"
  echo "  ./cloudrun.sh dist/TestProxy.zip"
  echo ""
  echo "  # 4. Deploy all templates at once:"
  echo "  ./cloudrun.sh --all"
  echo ""
  echo "  # 5. Test proxy traffic on Cloud Run:"
  echo "  ./cloudrun.sh test /testproxy"
  echo ""
  echo "  # 6. Record and inspect trace on Cloud Run:"
  echo "  ./cloudrun.sh trace-start TestProxy"
  echo "  ./cloudrun.sh test /testproxy"
  echo "  ./cloudrun.sh trace-stop"
}

# ------------------------------------------------------------------------------
# 1. Manager Container Image Build & Push
# ------------------------------------------------------------------------------
build_and_push_manager_image() {
  local image="$1"
  local registry_host
  registry_host=$(echo "$image" | cut -d/ -f1)

  echo -e "\n${BOLD}Building and pushing Apigee Emulator Manager image:${NC} ${CYAN}$image${NC}"

  # Method A: Local Docker (fastest, avoids Cloud Build GCS IAM bucket errors)
  if command -v docker &>/dev/null && docker info >/dev/null 2>&1; then
    echo -e "  ${BLUE}Building container image locally using Docker...${NC}"
    if docker build --no-cache -t "$image" "$ROOT_DIR"; then
      echo -e "  ${BLUE}Configuring Docker authentication for ${registry_host}...${NC}"
      gcloud auth configure-docker "$registry_host" --quiet 2>/dev/null || true

      echo -e "  ${BLUE}Pushing image to ${image}...${NC}"
      if docker push "$image"; then
        echo -e "  ${GREEN}✓ Successfully built and pushed image using local Docker.${NC}"
        return 0
      else
        echo -e "  ${YELLOW}Notice: 'docker push' failed. Falling back to Cloud Build...${NC}"
      fi
    else
      echo -e "  ${YELLOW}Notice: 'docker build' failed. Falling back to Cloud Build...${NC}"
    fi
  fi

  # Method B: Google Cloud Build (runs in GCP)
  echo -e "  ${BLUE}Building via Google Cloud Build in project: ${BOLD}$PROJECT_ID${NC}...${NC}"
  if ! gcloud builds submit --project "$PROJECT_ID" --tag "$image" "$ROOT_DIR"; then
    echo -e "\n${RED}Error: Cloud Build submission failed in project '$PROJECT_ID'.${NC}" >&2
    local p_num
    p_num=$(gcloud projects describe "$PROJECT_ID" --format="value(projectNumber)" 2>/dev/null || true)
    if [ -n "$p_num" ]; then
      echo -e "${YELLOW}If you encountered a 403 'storage.objects.get' permission denied error, run:${NC}" >&2
      echo -e "  ${CYAN}gcloud projects add-iam-policy-binding $PROJECT_ID \\${NC}" >&2
      echo -e "  ${CYAN}  --member=\"serviceAccount:${p_num}-compute@developer.gserviceaccount.com\" \\${NC}" >&2
      echo -e "  ${CYAN}  --role=\"roles/storage.objectViewer\"${NC}\n" >&2
    fi
    exit 1
  fi
  echo -e "  ${GREEN}✓ Cloud Build succeeded.${NC}"
}

# ------------------------------------------------------------------------------
# 2. Service Deployment to Cloud Run
# ------------------------------------------------------------------------------
deploy_cloudrun_service() {
  check_service_prereqs
  resolve_gcp_context

  if [ -z "$PROJECT_ID" ]; then
    echo -e "${RED}Error: No GCP Project configured or specified.${NC}" >&2
    echo "Please set via: gcloud config set project <PROJECT_ID> or pass --project <PROJECT_ID>" >&2
    exit 1
  fi

  if [ ! -f "$SERVICE_YAML" ]; then
    echo -e "${RED}Error: Service manifest file not found: $SERVICE_YAML${NC}" >&2
    exit 1
  fi

  echo -e "${BOLD}Deploying Apigee Emulator + Envoy + Manager to Cloud Run...${NC}"
  echo -e "  ${BOLD}Project:${NC} $PROJECT_ID"
  echo -e "  ${BOLD}Region:${NC}  $REGION"
  echo -e "  ${BOLD}Service:${NC} $SERVICE_NAME"
  echo -e "  ${BOLD}Config:${NC}  $SERVICE_YAML\n"

  # 1. Compile deployment bundles from data/deployments/ using aft if available
  if command -v aft &>/dev/null; then
    echo -e "${BLUE}Compiling proxy bundles from data/deployments/ with aft...${NC}"
    mkdir -p "$ROOT_DIR/data/bundles"
    for dep_yaml in "$ROOT_DIR"/data/deployments/*.yaml "$ROOT_DIR"/data/deployments/*.yml; do
      if [ -f "$dep_yaml" ]; then
        local dep_base
        dep_base="$(basename "$dep_yaml")"
        echo -e "  Compiling deployment: $dep_base"
        local tmp_dep_dir
        tmp_dep_dir=$(mktemp -d /tmp/aft-cr-dep-XXXXXX)
        if aft -i "$dep_yaml" -f zip -o "$tmp_dep_dir" --no-animation; then
          for pzip in "$tmp_dep_dir"/*.zip; do
            if [ -f "$pzip" ]; then
              cp "$pzip" "$ROOT_DIR/data/bundles/"
              echo -e "  • Bundle created: $(basename "$pzip")"
            fi
          done
        fi
        rm -rf "$tmp_dep_dir"
      fi
    done
    if [ -f "$ROOT_DIR/proxies/TestProxy.yaml" ]; then
      echo -e "  Compiling TestProxy -> data/bundles/TestProxy.zip"
      aft -i "$ROOT_DIR/proxies/TestProxy.yaml" -o "$ROOT_DIR/data/bundles/TestProxy.zip" --no-animation 2>/dev/null || true
    fi
  fi

  # 2. Build & push Manager container image (using timestamp tag to guarantee Cloud Run creates a new revision)
  local build_tag="v$(date +%Y%m%d%H%M%S)"
  local manager_image="${MANAGER_IMAGE:-gcr.io/$PROJECT_ID/apigee-emulator-manager:$build_tag}"
  build_and_push_manager_image "$manager_image"
  if [ -z "$MANAGER_IMAGE" ] && command -v docker &>/dev/null; then
    docker tag "$manager_image" "gcr.io/$PROJECT_ID/apigee-emulator-manager:latest" 2>/dev/null || true
    docker push "gcr.io/$PROJECT_ID/apigee-emulator-manager:latest" 2>/dev/null || true
  fi

  # 3. Render service manifest with manager image
  local tmp_manifest
  tmp_manifest=$(mktemp /tmp/cloudrun-manifest-XXXXXX.yaml)
  sed "s|MANAGER_IMAGE_PLACEHOLDER|$manager_image|g" "$SERVICE_YAML" > "$tmp_manifest"

  # 4. Apply service manifest using gcloud
  echo -e "\n${BLUE}Submitting Cloud Run service configuration...${NC}"
  gcloud run services replace "$tmp_manifest" \
    --project "$PROJECT_ID" \
    --region "$REGION"
  rm -f "$tmp_manifest"

  # Attempt to allow unauthenticated access for ease of proxy testing
  echo -e "\n${BLUE}Configuring access policy...${NC}"
  if gcloud run services add-iam-policy-binding "$SERVICE_NAME" \
    --project "$PROJECT_ID" \
    --region "$REGION" \
    --member="allUsers" \
    --role="roles/run.invoker" >/dev/null 2>&1; then
    echo -e "${GREEN}✓ Public unauthenticated access enabled (allUsers).${NC}"
  else
    echo -e "${YELLOW}Note: Organization policy prevents 'allUsers'. Use --auth flag when connecting.${NC}"
    USE_AUTH="true"
  fi

  # Retrieve assigned URL
  local cr_url
  cr_url=$(gcloud run services describe "$SERVICE_NAME" \
    --project "$PROJECT_ID" \
    --region "$REGION" \
    --format 'value(status.url)' 2>/dev/null || true)

  if [ -z "$cr_url" ]; then
    echo -e "${RED}Error: Failed to obtain Cloud Run service URL.${NC}" >&2
    exit 1
  fi

  cr_url=$(echo "$cr_url" | tr -d '[:space:]' | sed 's:/*$::')
  echo "$cr_url" > "$URL_FILE"

  echo -e "\n${BLUE}Waiting for Apigee Emulator to initialize Cassandra and Envoy ingress...${NC}"
  local ready=0
  local retries=40
  for ((i=1; i<=retries; i++)); do
    local code
    code=$(curl_cr -s -o /dev/null -w "%{http_code}" "$cr_url/v1/emulator/tree" 2>/dev/null || true)
    if [ "$code" = "200" ] || [ "$code" = "201" ]; then
      ready=1
      break
    fi
    echo -ne "."
    sleep 3
  done
  echo ""

  if [ "$ready" -ne 1 ]; then
    echo -e "${YELLOW}Warning: Apigee emulator readiness check timed out. It may still be finishing startup.${NC}"
    echo -e "You can check status with: \033[1;32m./cloudrun.sh status\033[0m"
  else
    echo -e "${GREEN}✓ Apigee Emulator, Envoy, and Tester UI are healthy and ready on Cloud Run!${NC}"
  fi

  echo -e "\n${BOLD}================================================================${NC}"
  echo -e "${BOLD}Cloud Run Service URL:${NC} ${CYAN}$cr_url${NC}"
  echo -e "${BOLD}Apigee Emulator Tester UI:${NC} ${GREEN}$cr_url/tester/${NC}"
  echo -e "${BOLD}Next Steps:${NC}"
  echo -e "  1. Open ${GREEN}$cr_url/tester/${NC} in your browser to inspect proxies, deploy bundles, and run interactive tests with traces."
  echo -e "  2. Or deploy additional proxies via CLI:"
  echo -e "     \033[1;32m./cloudrun.sh proxies/TestProxy.yaml\033[0m"
  echo -e "${BOLD}================================================================${NC}\n"
}

# ------------------------------------------------------------------------------
# 2. Status & Health Check
# ------------------------------------------------------------------------------
check_status() {
  local cr_url
  if ! cr_url=$(get_service_url); then
    echo -e "${RED}Error: Could not resolve Cloud Run service URL.${NC}" >&2
    echo "Deploy the service first via: ./cloudrun.sh deploy-service" >&2
    exit 1
  fi

  echo -e "${BOLD}Cloud Run Service Status:${NC}"
  echo -e "  ${BOLD}URL:${NC} $cr_url"

  echo -ne "  ${BOLD}Health (/healthz):${NC} "
  local hz_code
  hz_code=$(curl_cr -s -o /tmp/hz_resp.txt -w "%{http_code}" "$cr_url/healthz" 2>/dev/null || true)
  if [ "$hz_code" = "200" ]; then
    echo -e "${GREEN}OK (HTTP 200)${NC}"
  else
    echo -e "${RED}Failed (HTTP $hz_code)${NC}"
  fi

  echo -ne "  ${BOLD}Tester UI (/tester/):${NC} "
  local mg_code
  mg_code=$(curl_cr -s -o /dev/null -w "%{http_code}" "$cr_url/tester/" 2>/dev/null || true)
  if [ "$mg_code" = "200" ]; then
    echo -e "${GREEN}Available ($cr_url/tester/)${NC}"
  else
    echo -e "${YELLOW}HTTP $mg_code ($cr_url/tester/)${NC}"
  fi

  echo -ne "  ${BOLD}Emulator Management (/v1/emulator/tree):${NC} "
  local tree_resp tree_code
  tree_resp=$(curl_cr -s -w "\n%{http_code}" "$cr_url/v1/emulator/tree" 2>/dev/null || true)
  tree_code=$(echo "$tree_resp" | tail -n1)
  tree_body=$(echo "$tree_resp" | sed '$d')

  if [ "$tree_code" = "200" ]; then
    echo -e "${GREEN}Ready (HTTP 200)${NC}"
    echo -e "\n${BOLD}Deployed Proxies:${NC}"
    python3 -c "
import json, sys
try:
    tree = json.loads('''$tree_body''')
    if isinstance(tree, list) and len(tree) > 0:
        for ep in tree:
            app = ep.get('application', '')
            base = ep.get('basePath', '').lstrip('/')
            print(f'  • {app}: $cr_url/{base}')
    else:
        print('  (No proxies currently deployed)')
except Exception as e:
    print(f'  Unable to parse deployment tree: {e}')
"
  else
    echo -e "${RED}Not ready or error (HTTP $tree_code)${NC}"
    [ -n "$tree_body" ] && echo "$tree_body"
  fi
}

# ------------------------------------------------------------------------------
# 3. Proxy & Bundle Deployment to Cloud Run
# ------------------------------------------------------------------------------
sanitize_target_endpoints() {
  local target_dir="$1"
  python3 -c "
import glob, os, xml.etree.ElementTree as ET

td = '$target_dir/apiproxy'
target_xmls = glob.glob(f'{td}/targets/*.xml')
targets = [os.path.splitext(os.path.basename(f))[0] for f in target_xmls]

for proxy_file in glob.glob(f'{td}/proxies/*.xml'):
    try:
        tree = ET.parse(proxy_file)
        root = tree.getroot()
        changed = False
        for rr in root.findall('RouteRule'):
            te = rr.find('TargetEndpoint')
            if te is not None and te.text and te.text not in targets:
                if 'googlecloud' in targets:
                    te.text = 'googlecloud'
                    changed = True
                elif len(targets) > 0:
                    te.text = targets[0]
                    changed = True
                else:
                    rr.remove(te)
                    changed = True
        if changed:
            tree.write(proxy_file, encoding='utf-8', xml_declaration=True)
    except Exception as e:
        print(f'Warning during sanitization of {proxy_file}: {e}')
"
}

deploy_proxies_to_cloudrun() {
  local targets=("$@")
  check_proxy_prereqs

  local cr_url
  if ! cr_url=$(get_service_url); then
    echo -e "${RED}Error: Cloud Run service URL not found.${NC}" >&2
    echo -e "Please deploy the service first:\n  \033[1;32m./cloudrun.sh deploy-service\033[0m" >&2
    exit 1
  fi

  echo -e "${BOLD}Target Cloud Run Instance:${NC} ${CYAN}$cr_url${NC}\n"

  # Verify Cloud Run service is responding
  echo -ne "${BLUE}Checking Cloud Run service readiness...${NC}"
  local ready_code
  ready_code=$(curl_cr -s -o /dev/null -w "%{http_code}" "$cr_url/v1/emulator/tree" 2>/dev/null || true)
  if [ "$ready_code" != "200" ]; then
    echo ""
    echo -e "${RED}Error: Cloud Run emulator at $cr_url is not ready (HTTP $ready_code).${NC}" >&2
    echo "Check logs with: ./cloudrun.sh logs" >&2
    exit 1
  fi
  echo -e " ${GREEN}✓ Ready${NC}"

  local dist_dir="$ROOT_DIR/dist"
  local bundle_dir="$dist_dir/bundle"
  local env_dir="$bundle_dir/src/main/apigee/environments/test"
  local proxies_dir="$bundle_dir/src/main/apigee/apiproxies"

  # Validate test data files
  local testdata_files=("datacollectors.json" "developerapps.json" "developers.json" "maps.json" "products.json")
  for td in "${testdata_files[@]}"; do
    if [ ! -f "$ROOT_DIR/$td" ]; then
      echo -e "${RED}Error: Required test data file missing: $td${NC}" >&2
      exit 1
    fi
  done

  mkdir -p "$dist_dir"
  rm -rf "$bundle_dir"
  mkdir -p "$proxies_dir"
  mkdir -p "$env_dir"

  local deployed_proxies=()

  for target in "${targets[@]}"; do
    if [ ! -f "$target" ]; then
      echo -e "${RED}Error: File not found: $target${NC}" >&2
      exit 1
    fi

    # --------------------------------------------------------------------------
    # Case A: ZIP Bundle Deployment
    # --------------------------------------------------------------------------
    if [[ "$target" == *.zip ]]; then
      echo -e "\n${BLUE}Processing ZIP bundle: '${BOLD}$target${NC}${BLUE}'...${NC}"
      local zip_info
      zip_info=$(python3 -c "
import zipfile, os, sys, xml.etree.ElementTree as ET

zip_path = '$target'
proxies_dir = '$proxies_dir'
bundle_dir = '$bundle_dir'

with zipfile.ZipFile(zip_path, 'r') as z:
    names = z.namelist()
    # Check if full environment bundle
    if any(n.startswith('src/main/apigee/') for n in names):
        z.extractall(bundle_dir)
        print('MODE:ENV_BUNDLE')
        sys.exit(0)

    # Check if proxy bundle (apiproxy/)
    if any(n.startswith('apiproxy/') for n in names):
        proxy_name = None
        for n in names:
            if n.startswith('apiproxy/') and n.endswith('.xml') and n.count('/') == 1:
                try:
                    root = ET.fromstring(z.read(n))
                    proxy_name = root.attrib.get('name')
                except Exception:
                    pass
                if not proxy_name:
                    proxy_name = os.path.splitext(os.path.basename(n))[0]
                break
        if not proxy_name:
            proxy_name = os.path.splitext(os.path.basename(zip_path))[0]

        target_dir = os.path.join(proxies_dir, proxy_name)
        os.makedirs(target_dir, exist_ok=True)
        z.extractall(target_dir)
        print(f'MODE:PROXY_BUNDLE:{proxy_name}')
        sys.exit(0)

    print('MODE:UNKNOWN')
")

      if [[ "$zip_info" == MODE:ENV_BUNDLE* ]]; then
        echo -e "${GREEN}✓ Extracted complete environment bundle.${NC}"
        # Extract proxy names from apiproxies directory
        while IFS= read -r p; do
          [ -n "$p" ] && deployed_proxies+=("$p")
        done < <(find "$proxies_dir" -mindepth 1 -maxdepth 1 -type d -exec basename {} \;)
      elif [[ "$zip_info" == MODE:PROXY_BUNDLE:* ]]; then
        local p_name
        p_name="${zip_info#MODE:PROXY_BUNDLE:}"
        deployed_proxies+=("$p_name")
        echo -e "${GREEN}✓ Successfully staged proxy bundle '$p_name'.${NC}"
      else
        echo -e "${RED}Error: Unrecognized ZIP format in $target. Must contain 'apiproxy/' or 'src/main/apigee/'.${NC}" >&2
        exit 1
      fi

    # --------------------------------------------------------------------------
    # Case B: YAML Template / Proxy / Feature Deployment (aft)
    # --------------------------------------------------------------------------
    elif [[ "$target" == *.yaml || "$target" == *.yml ]]; then
      local is_deployment
      is_deployment=$(python3 -c "
import yaml
try:
    with open('$target') as f:
        d = yaml.safe_load(f)
    if isinstance(d, dict) and (d.get('type') == 'deployment' or 'templates' in d or 'deployments' in '$target'):
        print('true')
    else:
        print('false')
except:
    print('false')
")
      if [ "$is_deployment" = "true" ]; then
        echo -e "\n${BLUE}Compiling deployment from '$target' with aft...${NC}"
        local tmp_dep_dir
        tmp_dep_dir=$(mktemp -d /tmp/aft-cr-dep-XXXXXX)
        if aft -i "$target" -f zip -o "$tmp_dep_dir" --no-animation; then
          for pzip in "$tmp_dep_dir"/*.zip; do
            if [ -f "$pzip" ]; then
              local pname
              pname="$(basename "$pzip" .zip)"
              local target_proxy_dir="$proxies_dir/$pname"
              mkdir -p "$target_proxy_dir"
              unzip -q -o "$pzip" -d "$target_proxy_dir"
              sanitize_target_endpoints "$target_proxy_dir"
              deployed_proxies+=("$pname")
              echo -e "${GREEN}✓ Successfully compiled $pname from deployment${NC}"
            fi
          done
          # Merge test data into dist_dir
          python3 -c "
import json, os
for fname in ['products.json', 'developers.json', 'developerapps.json']:
    src = os.path.join('$tmp_dep_dir', fname)
    dst = os.path.join('$dist_dir', fname)
    if os.path.exists(src):
        try:
            with open(src) as f: s_data = json.load(f)
            d_data = []
            if os.path.exists(dst):
                with open(dst) as f: d_data = json.load(f)
            elif os.path.exists(os.path.join('$ROOT_DIR', fname)):
                with open(os.path.join('$ROOT_DIR', fname)) as f: d_data = json.load(f)
            key = 'name' if fname != 'developers.json' else 'email'
            merged = {item.get(key): item for item in d_data if isinstance(item, dict) and key in item}
            for item in s_data:
                if isinstance(item, dict) and key in item:
                    merged[item[key]] = item

            if fname == 'products.json':
                for prod in merged.values():
                    envs = prod.get('environments', [])
                    if isinstance(envs, list):
                        if 'test' not in envs: envs.append('test')
                    else: envs = ['test']
                    prod['environments'] = envs
                    if 'operationGroup' in prod or 'llmOperationGroup' in prod:
                        prod.pop('proxies', None)
                        prod.pop('apiResources', None)

            with open(dst, 'w') as f:
                json.dump(list(merged.values()), f, indent=2)
            print(f'  • Merged {fname} from deployment')
        except Exception as e:
            print(f'  • Warning merging {fname}: {e}')
"
        else
          echo -e "${RED}Error: Failed to compile deployment $target with aft.${NC}" >&2
          rm -rf "$tmp_dep_dir"
          exit 1
        fi
        rm -rf "$tmp_dep_dir"
      else
        local proxy_name
        proxy_name=$(python3 -c "
import yaml
with open('$target') as f:
    data = yaml.safe_load(f)
print(data.get('name', '') if isinstance(data, dict) else '')
")
        if [ -z "$proxy_name" ]; then
          proxy_name="$(basename "$target" .yaml)"
          proxy_name="$(basename "$proxy_name" .yml)"
        fi

        echo -e "\n${BLUE}Compiling proxy '${BOLD}$proxy_name${NC}${BLUE}' from '$target'...${NC}"
        local zip_path="$dist_dir/$proxy_name.zip"
        aft -i "$target" -o "$zip_path" --no-animation

        local target_proxy_dir="$proxies_dir/$proxy_name"
        mkdir -p "$target_proxy_dir"
        unzip -q -o "$zip_path" -d "$target_proxy_dir"
        sanitize_target_endpoints "$target_proxy_dir"
        deployed_proxies+=("$proxy_name")
        echo -e "${GREEN}✓ Successfully compiled $proxy_name${NC}"
      fi
    fi
  done

  # Generate environment and deployment JSON descriptors
  local proxies_json
  proxies_json=$(python3 -c "import sys, json; print(json.dumps(sys.argv[1:]))" "${deployed_proxies[@]}")

  cat << EOF > "$env_dir/env.json"
{
  "name": "test"
}
EOF

  cat << EOF > "$env_dir/deployments.json"
{
  "proxies": $proxies_json
}
EOF

  cp "$ROOT_DIR/datacollectors.json" "$env_dir/datacollectors.json"

  # Package final deployment bundle
  local deploy_zip="$dist_dir/bundle.zip"
  (cd "$bundle_dir" && zip -q -r "$deploy_zip" src)

  # Reset emulator state on Cloud Run
  echo -e "\n${BLUE}Resetting Apigee Emulator state on Cloud Run...${NC}"
  local reset_code
  reset_code=$(curl_cr -s -o /tmp/cr_reset.txt -w "%{http_code}" -X POST "$cr_url/v1/emulator/reset")
  if [ "$reset_code" != "200" ] && [ "$reset_code" != "201" ]; then
    echo -e "${RED}Error: Failed to reset emulator on Cloud Run (HTTP $reset_code):${NC}" >&2
    cat /tmp/cr_reset.txt >&2
    exit 1
  fi

  # Prepare dynamic products.json ensuring all deployed proxies are authorized
  python3 -c "
import json, os

prod_path = '$dist_dir/products.json' if os.path.exists('$dist_dir/products.json') else '$ROOT_DIR/products.json'
with open(prod_path) as f:
    products = json.load(f)

proxies = json.loads('''$proxies_json''')

for prod in products:
    envs = prod.get('environments', [])
    if isinstance(envs, list):
        if 'test' not in envs: envs.append('test')
    else: envs = ['test']
    prod['environments'] = envs

    # In Apigee, if operationGroup or llmOperationGroup is set,
    # proxies and apiResources MUST NOT be set
    prod.pop('proxies', None)
    prod.pop('apiResources', None)

    op_group = prod.get('operationGroup')
    if not isinstance(op_group, dict):
        op_group = {'operationConfigType': 'proxy', 'operationConfigs': []}
        prod['operationGroup'] = op_group
    existing_ops = op_group.get('operationConfigs', [])
    if not isinstance(existing_ops, list):
        existing_ops = []
        op_group['operationConfigs'] = existing_ops
    existing_sources = {c.get('apiSource') for c in existing_ops if isinstance(c, dict)}

    for p in proxies:
        if p not in existing_sources:
            existing_ops.append({
                'apiSource': p,
                'operations': [{'resource': '/'}],
                'quota': {}
            })
            existing_sources.add(p)

    llm_group = prod.get('llmOperationGroup')
    if not isinstance(llm_group, dict):
        llm_group = {'operationConfigType': 'proxy', 'operationConfigs': []}
        prod['llmOperationGroup'] = llm_group
    existing_llm_ops = llm_group.get('operationConfigs', [])
    if not isinstance(existing_llm_ops, list):
        existing_llm_ops = []
        llm_group['operationConfigs'] = existing_llm_ops
    existing_llm_sources = {c.get('apiSource') for c in existing_llm_ops if isinstance(c, dict)}

    for p in proxies:
        if p not in existing_llm_sources:
            for model in ['gemini-3.6-flash', 'claude-sonnet-5', 'gemini-3.6-flash-lite']:
                existing_llm_ops.append({
                    'apiSource': p,
                    'llmOperations': [{'resource': '/', 'model': model}],
                    'llmTokenQuota': {}
                })
            existing_llm_sources.add(p)

# Ensure all products referenced by developer apps exist in products
app_path = '$dist_dir/developerapps.json' if os.path.exists('$dist_dir/developerapps.json') else '$ROOT_DIR/developerapps.json'
if os.path.exists(app_path):
    try:
        with open(app_path) as af:
            apps = json.load(af)
        existing_pnames = {p.get('name') for p in products if isinstance(p, dict)}
        for app in apps:
            if isinstance(app, dict):
                prods_in_app = list(app.get('apiProducts', []))
                for cred in app.get('credentials', []):
                    if isinstance(cred, dict):
                        for cred_p in cred.get('apiProducts', []):
                            if isinstance(cred_p, dict) and 'apiproduct' in cred_p:
                                prods_in_app.append(cred_p['apiproduct'])
                            elif isinstance(cred_p, str):
                                prods_in_app.append(cred_p)
                for req_p in prods_in_app:
                    if req_p and req_p not in existing_pnames:
                        products.append({
                            'name': req_p,
                            'displayName': req_p,
                            'approvalType': 'auto',
                            'environments': ['test'],
                            'operationGroup': {
                                'operationConfigType': 'proxy',
                                'operationConfigs': [{'apiSource': p, 'operations': [{'resource': '/'}], 'quota': {}} for p in proxies]
                            }
                        })
                        existing_pnames.add(req_p)
    except Exception as e:
        print(f'  • Warning verifying app products: {e}')

with open('$dist_dir/products.json', 'w') as f:
    json.dump(products, f, indent=2)
"

  # Package test data zip
  local testdata_zip="$dist_dir/testdata.zip"
  (
    cd "$ROOT_DIR"
    zip -q "$testdata_zip" datacollectors.json developerapps.json developers.json maps.json
    for f in products.json developerapps.json developers.json; do
      if [ -f "$dist_dir/$f" ]; then
        (cd "$dist_dir" && zip -q -u "$testdata_zip" "$f")
      fi
    done
  )

  echo -e "${BLUE}Uploading test data (Products, Developer Apps, KVMs) to Cloud Run...${NC}"
  local test_status
  test_status=$(curl_cr -s -o /tmp/cr_test_resp.txt -w "%{http_code}" -X POST "$cr_url/v1/emulator/setup/tests" \
    -H "Content-Type: multipart/form-data" \
    -F "file=@$testdata_zip")

  if [ "$test_status" -ne 200 ]; then
    echo -e "${RED}Error: Test data upload failed (HTTP $test_status):${NC}" >&2
    cat /tmp/cr_test_resp.txt >&2
    echo "" >&2
    exit 1
  fi
  echo -e "${GREEN}✓ Test data deployed successfully.${NC}"

  # Deploy proxy bundle to Cloud Run
  echo -e "${BLUE}Deploying proxy bundle to Cloud Run environment 'test'...${NC}"
  local deploy_status
  deploy_status=$(curl_cr -s -o /tmp/cr_deploy_resp.txt -w "%{http_code}" -X POST "$cr_url/v1/emulator/deploy?environment=test" \
    -H "Content-Type: application/zip" \
    --data-binary "@$deploy_zip")

  if [ "$deploy_status" -ne 200 ]; then
    echo -e "${RED}Error: Proxy bundle deployment failed (HTTP $deploy_status):${NC}" >&2
    cat /tmp/cr_deploy_resp.txt >&2
    echo "" >&2
    exit 1
  fi

  echo -e "${GREEN}✓ Proxies successfully deployed to Apigee Emulator on Cloud Run!${NC}"
  cat /tmp/cr_deploy_resp.txt
  echo ""

  # Display Summary
  echo -e "\n${BOLD}================================================================${NC}"
  echo -e "${BOLD}              CLOUD RUN DEPLOYMENT SUMMARY                      ${NC}"
  echo -e "${BOLD}================================================================${NC}"
  local tree_json
  tree_json=$(curl_cr -s "$cr_url/v1/emulator/tree" 2>/dev/null || echo "[]")
  python3 -c "
import json, sys
try:
    tree = json.loads('''$tree_json''')
    if isinstance(tree, list) and tree:
        print('${BOLD}Active Endpoints on Cloud Run:${NC}')
        for ep in tree:
            app = ep.get('application', '')
            base = ep.get('basePath', '').lstrip('/')
            print(f'  • {app}: $cr_url/{base}')
    else:
        print('No active endpoints reported.')
except Exception as e:
    print(f'Unable to parse deployment tree: {e}')
"

  echo -e "\n${BOLD}Quick Test Commands:${NC}"
  echo -e "  # Test deployed proxy:"
  echo -e "  ${CYAN}curl -i \"$cr_url/testproxy\" -H \"x-api-key: test-api-key-12345\"${NC}"
  echo ""
  echo -e "  # Or use the built-in test helper:"
  echo -e "  ${CYAN}./cloudrun.sh test /testproxy${NC}"
  echo ""
  echo -e "  # Inspect deployment tree:"
  echo -e "  ${CYAN}curl -s \"$cr_url/v1/emulator/tree\" | jq .${NC}"
  echo -e "${BOLD}================================================================${NC}\n"
}

# ------------------------------------------------------------------------------
# 4. Traffic Testing Helper
# ------------------------------------------------------------------------------
test_traffic() {
  local path="${1:-/testproxy}"
  path="/${path#/}"

  local cr_url
  if ! cr_url=$(get_service_url); then
    echo -e "${RED}Error: Cloud Run service URL not found.${NC}" >&2
    exit 1
  fi

  echo -e "${BOLD}Sending request to:${NC} ${CYAN}$cr_url$path${NC}"
  echo -e "${BOLD}Header:${NC} x-api-key: test-api-key-12345\n"

  curl_cr -i "$cr_url$path" -H "x-api-key: test-api-key-12345"
  echo ""
}

# ------------------------------------------------------------------------------
# 5. Cloud Run Tracing Helpers
# ------------------------------------------------------------------------------
trace_start() {
  local cr_url
  if ! cr_url=$(get_service_url); then
    echo -e "${RED}Error: Cloud Run service URL not found.${NC}" >&2
    exit 1
  fi

  local proxy_name="$1"
  if [ -z "$proxy_name" ]; then
    local tree_json
    tree_json=$(curl_cr -s "$cr_url/v1/emulator/tree" 2>/dev/null || echo "[]")
    proxy_name=$(python3 -c "
import json
try:
    tree = json.loads('''$tree_json''')
    if isinstance(tree, list) and len(tree) > 0:
        print(tree[0].get('application', ''))
except:
    pass
")
  fi

  if [ -z "$proxy_name" ]; then
    echo -e "${RED}Error: Could not auto-detect active proxy. Specify proxy name: ./cloudrun.sh trace-start <PROXY_NAME>${NC}" >&2
    exit 1
  fi

  echo -e "${BLUE}Starting Cloud Run trace session for proxy '${BOLD}$proxy_name${NC}${BLUE}'...${NC}"
  local resp
  resp=$(curl_cr -s -X POST "$cr_url/v1/emulator/trace?proxyName=$proxy_name")
  local session_id
  session_id=$(python3 -c "
import json
try:
    data = json.loads('''$resp''')
    print(data.get('name', ''))
except:
    pass
")

  if [ -z "$session_id" ] || [ "$session_id" = "null" ]; then
    echo -e "${RED}Error: Failed to start trace session. Response: $resp${NC}" >&2
    exit 1
  fi

  cat << EOF > "$SESSION_FILE"
{
  "sessionId": "$session_id",
  "proxyName": "$proxy_name",
  "serviceUrl": "$cr_url",
  "startedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF

  echo -e "${GREEN}✓ Trace session started!${NC}"
  echo -e "  ${BOLD}Session ID:${NC} $session_id"
  echo -e "  ${BOLD}Proxy:${NC}      $proxy_name"
  echo -e "\nSend your requests now, then run: \033[1;32m./cloudrun.sh trace-stop\033[0m"
}

trace_stop() {
  if [ ! -f "$SESSION_FILE" ]; then
    echo -e "${RED}Error: No active trace session found. Start one with: ./cloudrun.sh trace-start${NC}" >&2
    exit 1
  fi

  local session_id cr_url proxy_name
  session_id=$(python3 -c "import json; print(json.load(open('$SESSION_FILE')).get('sessionId', ''))")
  cr_url=$(python3 -c "import json; print(json.load(open('$SESSION_FILE')).get('serviceUrl', ''))")
  proxy_name=$(python3 -c "import json; print(json.load(open('$SESSION_FILE')).get('proxyName', ''))")

  echo -e "${BLUE}Fetching recorded trace transactions from Cloud Run...${NC}"
  local trace_out="$ROOT_DIR/trace.json"
  curl_cr -s "$cr_url/v1/emulator/trace/transactions?sessionid=$session_id" > "$trace_out"
  rm -f "$SESSION_FILE"

  echo -e "${GREEN}✓ Trace recorded to: ${BOLD}$trace_out${NC}"
  echo -e "Open \033[4m$ROOT_DIR/trace.html\033[0m in your browser to inspect."
}

# ------------------------------------------------------------------------------
# Interactive Menu Selector
# ------------------------------------------------------------------------------
interactive_menu() {
  local cr_url
  cr_url=$(get_service_url 2>/dev/null || true)

  echo -e "\n${BOLD}================================================================${NC}"
  echo -e "${BOLD}             Apigee Emulator on Cloud Run Menu                 ${NC}"
  echo -e "${BOLD}================================================================${NC}"
  if [ -n "$cr_url" ]; then
    echo -e "Current Service URL: ${CYAN}$cr_url${NC}\n"
  else
    echo -e "Current Service: ${YELLOW}Not deployed or URL not cached${NC}\n"
  fi

  echo -e "  ${BOLD}1)${NC} ${GREEN}Deploy Containers to Cloud Run${NC} (Envoy + Apigee Emulator)"
  echo -e "  ${BOLD}2)${NC} Deploy default proxy (${CYAN}proxies/TestProxy.yaml${NC})"
  echo -e "  ${BOLD}3)${NC} Browse & deploy proxies (proxies/*.yaml)"
  echo -e "  ${BOLD}4)${NC} Browse & deploy templates (templates/*.yaml)"
  echo -e "  ${BOLD}5)${NC} Browse & deploy features (features/*.yaml)"
  echo -e "  ${BOLD}6)${NC} Browse & deploy ZIP bundles (dist/*.zip)"
  echo -e "  ${BOLD}7)${NC} Deploy ALL templates"
  echo -e "  ${BOLD}8)${NC} Check Cloud Run service status & active endpoints"
  echo -e "  ${BOLD}9)${NC} Test proxy traffic (/testproxy)"
  echo -e " ${BOLD}10)${NC} Start trace recording"
  echo -e " ${BOLD}11)${NC} Stop trace recording & save trace.json"
  echo -e " ${BOLD}12)${NC} ${CYAN}Open Apigee Emulator Tester Web UI${NC} (/tester/)"
  echo -e "  ${BOLD}Q)${NC} Quit"
  echo ""

  read -r -p "Enter selection [1-12, Q] (default 1): " choice
  choice="${choice:-1}"

  case "$choice" in
    1)
      deploy_cloudrun_service
      ;;
    2)
      deploy_proxies_to_cloudrun "proxies/TestProxy.yaml"
      ;;
    3)
      browse_and_deploy "proxies" get_available_proxies "proxies/TestProxy.yaml"
      ;;
    4)
      browse_and_deploy "templates" get_available_templates "templates/REST-AI-Completions.yaml"
      ;;
    5)
      browse_and_deploy "features" get_available_features ""
      ;;
    6)
      browse_and_deploy "ZIP bundles" get_available_zips ""
      ;;
    7)
      local all_tpl=()
      while IFS= read -r f; do [ -n "$f" ] && all_tpl+=("$f"); done < <(get_available_templates)
      deploy_proxies_to_cloudrun "${all_tpl[@]}"
      ;;
    8)
      check_status
      ;;
    9)
      test_traffic "/testproxy"
      ;;
    10)
      trace_start ""
      ;;
    11)
      trace_stop
      ;;
    12)
      local cr_url
      cr_url=$(get_service_url)
      echo -e "${BOLD}Apigee Emulator Tester UI:${NC} ${GREEN}$cr_url/tester/${NC}"
      if command -v xdg-open &>/dev/null; then
        xdg-open "$cr_url/tester/" 2>/dev/null || true
      fi
      ;;
    [Qq])
      exit 0
      ;;
    *)
      echo -e "${RED}Invalid selection. Aborting.${NC}" >&2
      exit 1
      ;;
  esac
}

browse_and_deploy() {
  local category_name="$1"
  local getter_fn="$2"
  local default_item="$3"

  local items=()
  while IFS= read -r f; do
    [ -n "$f" ] && items+=("$f")
  done < <($getter_fn)

  if [ ${#items[@]} -eq 0 ]; then
    echo -e "${YELLOW}No files found for $category_name.${NC}" >&2
    exit 1
  fi

  echo -e "\n${BOLD}Available in $category_name:${NC}"
  local default_num=1
  for idx in "${!items[@]}"; do
    local num=$((idx + 1))
    local marker=""
    if [ -n "$default_item" ] && [ "${items[$idx]}" = "$default_item" ]; then
      marker=" ${CYAN}(default)${NC}"
      default_num=$num
    fi
    echo -e "  ${BOLD}$num)${NC} ${items[$idx]}$marker"
  done
  echo -e "  ${BOLD}A)${NC} Deploy ALL $category_name"

  echo ""
  read -r -p "Enter selection [1-${#items[@]}, A] (default $default_num): " sub_choice
  sub_choice="${sub_choice:-$default_num}"

  if [[ "$sub_choice" =~ ^[Aa]$ ]]; then
    deploy_proxies_to_cloudrun "${items[@]}"
  elif [[ "$sub_choice" =~ ^[0-9]+$ ]] && [ "$sub_choice" -ge 1 ] && [ "$sub_choice" -le "${#items[@]}" ]; then
    deploy_proxies_to_cloudrun "${items[$((sub_choice - 1))]}"
  else
    echo -e "${RED}Invalid selection. Aborting.${NC}" >&2
    exit 1
  fi
}

# ------------------------------------------------------------------------------
# CLI Argument Processing
# ------------------------------------------------------------------------------
FILES_TO_DEPLOY=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      show_help
      exit 0
      ;;
    deploy-service|up|--deploy-service)
      COMMAND="deploy-service"
      shift
      ;;
    status|--status)
      COMMAND="status"
      shift
      ;;
    url|--url-only)
      COMMAND="url"
      shift
      ;;
    tester|manage|manager|--tester|--manage)
      COMMAND="tester"
      shift
      ;;
    logs|--logs)
      COMMAND="logs"
      shift
      ;;
    reset|--reset)
      COMMAND="reset"
      shift
      ;;
    delete|--delete)
      COMMAND="delete"
      shift
      ;;
    test)
      COMMAND="test"
      shift
      TEST_PATH="$1"
      [ -n "$TEST_PATH" ] && shift
      ;;
    trace-start)
      COMMAND="trace-start"
      shift
      TRACE_PROXY="$1"
      [ -n "$TRACE_PROXY" ] && shift
      ;;
    trace-stop)
      COMMAND="trace-stop"
      shift
      ;;
    deploy)
      COMMAND="deploy"
      shift
      ;;
    -a|--all)
      COMMAND="deploy-all"
      shift
      ;;
    -l|--list)
      echo -e "${BOLD}Available Proxies:${NC}"
      get_available_proxies
      echo -e "\n${BOLD}Available Templates:${NC}"
      get_available_templates
      echo -e "\n${BOLD}Available Features:${NC}"
      get_available_features
      exit 0
      ;;
    --project)
      PROJECT_ID="$2"
      shift 2
      ;;
    --region)
      REGION="$2"
      shift 2
      ;;
    --service)
      SERVICE_NAME="$2"
      shift 2
      ;;
    --url)
      CLOUDRUN_URL="$2"
      shift 2
      ;;
    --auth)
      USE_AUTH="true"
      shift
      ;;
    *)
      if [[ "$1" == -* ]]; then
        echo -e "${RED}Unknown option: $1${NC}" >&2
        show_help
        exit 1
      fi
      FILES_TO_DEPLOY+=("$1")
      shift
      ;;
  esac
done

# Dispatch based on command
if [ -n "$COMMAND" ]; then
  case "$COMMAND" in
    deploy-service)
      deploy_cloudrun_service
      ;;
    status)
      check_status
      ;;
    url)
      get_service_url
      ;;
    tester|manage)
      cr_url=$(get_service_url)
      echo -e "${BOLD}Apigee Emulator Tester UI:${NC} ${GREEN}$cr_url/tester/${NC}"
      if command -v xdg-open &>/dev/null; then
        xdg-open "$cr_url/tester/" 2>/dev/null || true
      fi
      ;;
    logs)
      resolve_gcp_context
      gcloud run services logs tail "$SERVICE_NAME" --project "$PROJECT_ID" --region "$REGION"
      ;;
    reset)
      cr_url=$(get_service_url)
      echo -e "${BLUE}Resetting emulator at $cr_url...${NC}"
      curl_cr -i -X POST "$cr_url/v1/emulator/reset"
      echo ""
      ;;
    delete)
      resolve_gcp_context
      gcloud run services delete "$SERVICE_NAME" --project "$PROJECT_ID" --region "$REGION"
      rm -f "$URL_FILE" "$SESSION_FILE"
      ;;
    test)
      test_traffic "$TEST_PATH"
      ;;
    trace-start)
      trace_start "$TRACE_PROXY"
      ;;
    trace-stop)
      trace_stop
      ;;
    deploy-all)
      all_tpl=()
      while IFS= read -r f; do [ -n "$f" ] && all_tpl+=("$f"); done < <(get_available_templates)
      deploy_proxies_to_cloudrun "${all_tpl[@]}"
      ;;
    deploy)
      if [ ${#FILES_TO_DEPLOY[@]} -eq 0 ]; then
        echo -e "${RED}Error: 'deploy' requires at least one YAML or ZIP file.${NC}" >&2
        exit 1
      fi
      deploy_proxies_to_cloudrun "${FILES_TO_DEPLOY[@]}"
      ;;
  esac
  exit 0
fi

if [ ${#FILES_TO_DEPLOY[@]} -gt 0 ]; then
  deploy_proxies_to_cloudrun "${FILES_TO_DEPLOY[@]}"
  exit 0
fi

# Fallback to interactive menu if terminal attached, else show help
if [ -t 0 ]; then
  interactive_menu
else
  show_help
fi
