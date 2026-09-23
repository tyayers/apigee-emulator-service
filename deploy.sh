#!/bin/bash
# ==============================================================================
# Apigee Emulator Deploy Script
# Builds and deploys YAML deployments to a local Apigee Emulator.
#
# HOW TO USE:
#   1. Interactive mode (defaults to data/deployments/deployment-1.yaml on Enter):
#        ./deploy.sh
#
#   2. Deploy a specific deployment:
#        ./deploy.sh data/deployments/deployment-1.yaml
#
#   3. Deploy all deployments at once:
#        ./deploy.sh --all
#
#   4. List available files or view help:
#        ./emulator/deploy.sh --list
#        ./emulator/deploy.sh --help
#
# TRACING:
#   - Start recording trace: ./emulator/trace_start.sh [PROXY_NAME]
#   - Stop & save trace:     ./emulator/trace_stop.sh
#   - Visualize trace:       Open emulator/trace.html in your browser
#
# IMPORTANT:
#   - Execute directly: './emulator/deploy.sh' (do NOT 'source emulator/deploy.sh')
#   - Prerequisites: docker, aft, curl, python3 (with pyyaml), zip, unzip
#   - Management API:  http://localhost:8080 (emulator admin, tree, reset)
#   - Runtime Traffic: http://localhost:8998 (API proxy basepath requests)
#   - Default Test Key: 'x-api-key: test-api-key-12345'
# ==============================================================================

# 1. Guard against sourcing the script in an interactive terminal
if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
  echo -e "\033[1;31mError: deploy.sh must be executed directly, not sourced.\033[0m" >&2
  echo -e "Please run:\n  \033[1;32m./emulator/deploy.sh\033[0m" >&2
  return 1 2>/dev/null || exit 1
fi

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -d "$SCRIPT_DIR/data" ] || [ -f "$SCRIPT_DIR/products.json" ]; then
  ROOT_DIR="$SCRIPT_DIR"
else
  ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
fi
cd "$ROOT_DIR"

if [ -d "$ROOT_DIR/emulator" ]; then
  DIST_DIR="$ROOT_DIR/emulator/dist"
else
  DIST_DIR="$ROOT_DIR/dist"
fi
BUNDLE_DIR="$DIST_DIR/bundle"
ENV_DIR="$BUNDLE_DIR/src/main/apigee/environments/test"
PROXIES_DIR="$BUNDLE_DIR/src/main/apigee/apiproxies"

# ANSI Colors
RED="\033[0;31m"
GREEN="\033[0;32m"
YELLOW="\033[1;33m"
BLUE="\033[0;34m"
CYAN="\033[0;36m"
BOLD="\033[1m"
NC="\033[0m"

EMULATOR_MGMT_URL="${EMULATOR_MGMT_URL:-http://localhost:8080}"
EMULATOR_ROUTER_PORT="${EMULATOR_ROUTER_PORT:-8998}"
CONTAINER_NAME="${EMULATOR_CONTAINER_NAME:-apigee}"

# ------------------------------------------------------------------------------
# Discovery Functions
# ------------------------------------------------------------------------------
get_available_deployments() {
  find data/deployments -maxdepth 1 \( -name "*.yaml" -o -name "*.yml" \) -type f 2>/dev/null | sort
}

# ------------------------------------------------------------------------------
# Help / Usage Function
# ------------------------------------------------------------------------------
show_help() {
  echo -e "${BOLD}Usage:${NC}
  ./deploy.sh [OPTIONS] [YAML_FILE...]

${BOLD}Description:${NC}
  Builds Apigee proxy bundles using 'aft' and deploys them to the local
  Apigee Emulator container, along with pre-configured mock test data
  (API products, developer apps, KVMs, and data collectors).
  Supports deploying deployment definitions from data/deployments/.

${BOLD}Options:${NC}
  -h, --help            Show this help message and exit
  -a, --all             Deploy all deployments in 'data/deployments/'
  -l, --list            List all available deployments in 'data/deployments/'
  -d, --deployments     Choose from deployments in 'data/deployments/'
  -c, --convert         Convert deployment definitions in 'data/deployments/' into
                        local assets (bundles, products, apps) with aft and exit
  -p, --parameters P    Pass parameters (comma-separated key=val, e.g. -p par1=val1,par2=val2)
  --project PROJECT_ID  GCP Project ID to replace {project} in deployments

${BOLD}Examples:${NC}
  # Interactive mode (defaults to data/deployments/deployment-1.yaml on Enter)
  ./deploy.sh

  # Deploy deployment definition (proxies + products + apps + test assertions)
  ./deploy.sh data/deployments/deployment-1.yaml

  # Convert deployments in data/deployments/ into local assets with aft
  ./deploy.sh --convert

  # Deploy all available deployments
  ./deploy.sh --all

${BOLD}Environment Variables:${NC}
  EMULATOR_MGMT_URL       Management URL (default: http://localhost:8080)
  EMULATOR_ROUTER_PORT    Runtime router port (default: 8998)
  EMULATOR_CONTAINER_NAME Docker container name (default: apigee)"
}

# ------------------------------------------------------------------------------
# List All Files Function
# ------------------------------------------------------------------------------
list_all() {
  echo -e "${BOLD}Available Deployments in data/deployments/:${NC}"
  local d_count=0
  while IFS= read -r d; do
    if [ -n "$d" ]; then
      echo "  • $d"
      d_count=$((d_count + 1))
    fi
  done < <(get_available_deployments)
  if [ "$d_count" -eq 0 ]; then
    echo "  (none)"
  fi
}

# ------------------------------------------------------------------------------
# 2. Check Prerequisites
# ------------------------------------------------------------------------------
check_prerequisites() {
  local missing=()
  for cmd in docker aft curl zip unzip python3; do
    if ! command -v "$cmd" &>/dev/null; then
      missing+=("$cmd")
    fi
  done

  if [ ${#missing[@]} -gt 0 ]; then
    echo -e "${RED}Error: Missing required tool(s): ${missing[*]}${NC}" >&2
    echo "Please install the missing tools and re-run this script." >&2
    exit 1
  fi

  # Verify Python has PyYAML
  if ! python3 -c "import yaml" &>/dev/null; then
    echo -e "${RED}Error: Python module 'pyyaml' is required.${NC}" >&2
    echo "Please install it with: pip3 install pyyaml" >&2
    exit 1
  fi
}

# ------------------------------------------------------------------------------
# 3. Docker & Emulator Container Health / Startup
# ------------------------------------------------------------------------------
ensure_emulator_running() {
  # Check if Docker daemon is running
  if ! docker info >/dev/null 2>&1; then
    echo -e "${RED}Error: Docker daemon is not running or accessible.${NC}" >&2
    echo "Please start Docker and try again." >&2
    exit 1
  fi

  # Check container status
  local container_status
  container_status=$(docker inspect -f '{{.State.Status}}' "$CONTAINER_NAME" 2>/dev/null || true)

  if [ -z "$container_status" ]; then
    echo -e "${YELLOW}Warning: Apigee emulator container '$CONTAINER_NAME' does not exist.${NC}"
    if [ -f "$SCRIPT_DIR/create.sh" ]; then
      echo -e "${BLUE}Creating and starting Apigee emulator container...${NC}"
      "$SCRIPT_DIR/create.sh"
    else
      echo -e "${RED}Error: Please create the container first via ./emulator/create.sh${NC}" >&2
      exit 1
    fi
  elif [ "$container_status" != "running" ]; then
    echo -e "${YELLOW}Apigee emulator container '$CONTAINER_NAME' is $container_status. Starting container...${NC}"
    docker start "$CONTAINER_NAME" >/dev/null
  fi

  # Wait for emulator HTTP service to become ready
  echo -ne "${BLUE}Checking Apigee emulator readiness at $EMULATOR_MGMT_URL...${NC}"
  local retries=30
  local ready=0
  for ((i=1; i<=retries; i++)); do
    local code
    code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$EMULATOR_MGMT_URL/v1/emulator/reset" 2>/dev/null || true)
    if [ "$code" = "200" ] || [ "$code" = "201" ]; then
      ready=1
      break
    fi
    echo -ne "."
    sleep 1
  done
  echo ""

  if [ "$ready" -ne 1 ]; then
    echo -e "${RED}Error: Apigee emulator at $EMULATOR_MGMT_URL did not become ready after ${retries}s.${NC}" >&2
    echo -e "You can inspect container logs with:\n  docker logs $CONTAINER_NAME --tail 50" >&2
    exit 1
  fi
  echo -e "${GREEN}✓ Apigee emulator is healthy and ready.${NC}"
}

# ------------------------------------------------------------------------------
# Proxy Sanitization Helper
# ------------------------------------------------------------------------------
sanitize_proxy_targets() {
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

# ------------------------------------------------------------------------------
# Parameter Collection & YAML Substitution
# ------------------------------------------------------------------------------
declare -A ALL_PARAMS_MAP=()
declare -a CLI_PARAMETERS=()

collect_parameters() {
  if [ -z "$PROJECT_ID" ] && command -v gcloud &>/dev/null; then
    PROJECT_ID=$(gcloud config get-value project 2>/dev/null || true)
  fi

  if [ -n "$PROJECT_ID" ]; then
    ALL_PARAMS_MAP["project"]="$PROJECT_ID"
    ALL_PARAMS_MAP["PROJECT"]="$PROJECT_ID"
    ALL_PARAMS_MAP["PROJECT_ID"]="$PROJECT_ID"
    ALL_PARAMS_MAP["GoogleCloudProject"]="$PROJECT_ID"
    export PROJECT_ID="$PROJECT_ID"
    export GoogleCloudProject="$PROJECT_ID"
    export GCP_PROJECT="$PROJECT_ID"
  fi

  for param_entry in "${CLI_PARAMETERS[@]}"; do
    IFS=',' read -ra pairs <<< "$param_entry"
    for pair in "${pairs[@]}"; do
      if [[ "$pair" == *=* ]]; then
        local k="${pair%%=*}"
        local v="${pair#*=}"
        k="$(echo "$k" | tr -d '[:space:]')"
        v="$(echo "$v" | tr -d '[:space:]')"
        if [ -n "$k" ]; then
          ALL_PARAMS_MAP["$k"]="$v"
          export "$k=$v"
        fi
      fi
    done
  done
}

replace_parameters_in_deployment_yaml() {
  local yaml_file="$1"
  if [ ! -f "$yaml_file" ]; then
    return 0
  fi

  local -a py_args=()
  for k in "${!ALL_PARAMS_MAP[@]}"; do
    py_args+=("$k=${ALL_PARAMS_MAP[$k]}")
  done

  python3 - "${yaml_file}" "${py_args[@]}" <<'PYEOF'
import sys, re

yaml_file = sys.argv[1]
params = {}
for arg in sys.argv[2:]:
    if '=' in arg:
        k, v = arg.split('=', 1)
        params[k] = v

try:
    with open(yaml_file, 'r') as f:
        content = f.read()

    modified = content
    # 1. Replace placeholders like {param_name} or ${param_name}
    for k, v in params.items():
        modified = modified.replace('{' + k + '}', str(v))
        modified = modified.replace('${' + k + '}', str(v))
        modified = modified.replace('{' + k.lower() + '}', str(v))
        modified = modified.replace('{' + k.upper() + '}', str(v))

    # 2. Update default: in parameters list if matching parameter name
    for k, v in params.items():
        pattern = re.compile(
            r'(- name:\s*[\'"]?' + re.escape(k) + r'[\'"]?\s*\n(?:\s*displayName:[^\n]*\n)?(?:\s*description:[^\n]*\n)?\s*default:\s*)([^\n]+)',
            re.IGNORECASE
        )
        modified = pattern.sub(r'\1"' + str(v).replace('"', '\\"') + r'"', modified)

    if modified != content:
        with open(yaml_file, 'w') as f:
            f.write(modified)
except Exception:
    pass
PYEOF
}

prepare_substituted_deployment_yaml() {
  local src_yaml="$1"
  if [ ! -f "$src_yaml" ]; then
    echo "$src_yaml"
    return 0
  fi
  local tmp_yaml
  tmp_yaml=$(mktemp /tmp/sub-dep-XXXXXX.yaml)
  cp "$src_yaml" "$tmp_yaml"
  replace_parameters_in_deployment_yaml "$tmp_yaml"
  # Also resolve local templates in data/templates/ so aft uses local files instead of remote repo
  python3 - "${tmp_yaml}" "${ROOT_DIR}" <<'PYEOF'
import sys, os, re

tmp_yaml = sys.argv[1]
root_dir = sys.argv[2]
try:
    with open(tmp_yaml, 'r') as f:
        lines = f.readlines()
    in_templates = False
    modified_lines = []
    for line in lines:
        if re.match(r'^\s*templates:\s*$', line):
            in_templates = True
            modified_lines.append(line)
        elif in_templates:
            m = re.match(r'^(\s*-\s*)([a-zA-Z0-9_\-\.]+)\s*$', line)
            if m:
                indent = m.group(1)
                tname = m.group(2).strip()
                stem = tname[:-5] if tname.endswith('.yaml') else (tname[:-4] if tname.endswith('.yml') else tname)
                candidate = os.path.join(root_dir, 'data', 'templates', f"{stem}.yaml")
                if os.path.exists(candidate):
                    modified_lines.append(f"{indent}data/templates/{stem}.yaml\n")
                else:
                    modified_lines.append(line)
            else:
                if re.match(r'^\S', line):
                    in_templates = False
                modified_lines.append(line)
        else:
            modified_lines.append(line)
    with open(tmp_yaml, 'w') as f:
        f.writelines(modified_lines)
except Exception:
    pass
PYEOF
  echo "$tmp_yaml"
}

apply_parameters_to_all_deployments() {
  collect_parameters
}

# ------------------------------------------------------------------------------
# Extract Parameters from Deployment or Proxy YAML for aft (-p)
# ------------------------------------------------------------------------------
extract_aft_parameters() {
  local yaml_file="$1"
  python3 -c "
import yaml
try:
    with open('$yaml_file') as f:
        data = yaml.safe_load(f)
    if isinstance(data, dict):
        # 1. Top-level parameters (deployment or proxy)
        for p in data.get('parameters', []) or []:
            if isinstance(p, dict) and 'name' in p:
                val = p.get('default') if p.get('default') is not None else p.get('value')
                if val is not None and str(val) != '':
                    print(f\"{p['name']}={val}\")
        # 2. Nested proxies parameters in a deployment
        for proxy in data.get('proxies', []) or []:
            if isinstance(proxy, dict):
                for p in proxy.get('parameters', []) or []:
                    if isinstance(p, dict) and 'name' in p:
                        val = p.get('default') if p.get('default') is not None else p.get('value')
                        if val is not None and str(val) != '':
                            print(f\"{p['name']}={val}\")
except Exception:
    pass
"
}

merge_aft_parameters() {
  local yaml_file="$1"
  local -a extracted=()
  while IFS= read -r param_line; do
    if [ -n "$param_line" ]; then
      extracted+=("$param_line")
    fi
  done < <(extract_aft_parameters "$yaml_file")

  local -A merged_map=()
  for p in "${extracted[@]}"; do
    if [[ "$p" == *=* ]]; then
      merged_map["${p%%=*}"]="${p#*=}"
    fi
  done

  for k in "${!ALL_PARAMS_MAP[@]}"; do
    if [ "$k" != "project" ] && [ "$k" != "PROJECT" ] && [ "$k" != "PROJECT_ID" ]; then
      merged_map["$k"]="${ALL_PARAMS_MAP[$k]}"
    fi
  done
  if [ -n "${ALL_PARAMS_MAP["GoogleCloudProject"]}" ]; then
    merged_map["GoogleCloudProject"]="${ALL_PARAMS_MAP["GoogleCloudProject"]}"
  fi

  for k in "${!merged_map[@]}"; do
    echo "$k=${merged_map[$k]}"
  done
}

# ------------------------------------------------------------------------------
# Convert Deployments to Local Assets Helper (aft)
# ------------------------------------------------------------------------------
convert_deployments_to_assets() {
  local dep_files=("$@")
  if [ ${#dep_files[@]} -eq 0 ]; then
    while IFS= read -r f; do
      [ -n "$f" ] && dep_files+=("$f")
    done < <(get_available_deployments)
  fi

  if [ ${#dep_files[@]} -eq 0 ]; then
    echo -e "${YELLOW}No deployment YAML files found in data/deployments/.${NC}" >&2
    return 1
  fi

  # Check required tools for conversion
  for cmd in aft curl zip unzip python3; do
    if ! command -v "$cmd" &>/dev/null; then
      echo -e "${RED}Error: Missing required tool: $cmd${NC}" >&2
      exit 1
    fi
  done
  if ! python3 -c "import yaml" &>/dev/null; then
    echo -e "${RED}Error: Python module 'pyyaml' is required.${NC}" >&2
    exit 1
  fi

  echo -e "\n${BOLD}================================================================${NC}"
  echo -e "${BOLD}     CONVERTING DEPLOYMENTS INTO LOCAL ASSETS (aft)             ${NC}"
  echo -e "${BOLD}================================================================${NC}"
  echo -e "${BLUE}Clearing emulator dist bundle and staged bundles...${NC}"
  rm -rf "$DIST_DIR"
  rm -rf "$ROOT_DIR/data/bundles"
  mkdir -p "$ROOT_DIR/data/bundles"
  mkdir -p "$ROOT_DIR/data/products"
  mkdir -p "$ROOT_DIR/data/developers"
  mkdir -p "$ROOT_DIR/data/developerapps"
  mkdir -p "$ROOT_DIR/data/maps"
  mkdir -p "$ROOT_DIR/data/datacollectors"
  mkdir -p "$PROXIES_DIR"
  mkdir -p "$DIST_DIR"

  local total_proxies=0
  for dep_file in "${dep_files[@]}"; do
    if [ ! -f "$dep_file" ]; then
      echo -e "${YELLOW}Warning: Deployment file not found: $dep_file${NC}" >&2
      continue
    fi

    echo -e "\n${BLUE}Converting deployment: ${BOLD}$dep_file${NC}..."
    local sub_yaml
    sub_yaml=$(prepare_substituted_deployment_yaml "$dep_file")
    local -a params=()
    while IFS= read -r param_line; do
      if [ -n "$param_line" ]; then
        params+=("$param_line")
      fi
    done < <(merge_aft_parameters "$sub_yaml")

    local -a param_args=()
    if [ ${#params[@]} -gt 0 ]; then
      local param_str
      param_str=$(IFS=,; echo "${params[*]}")
      param_args=("-p" "$param_str")
      echo -e "  • Parameters (-p): ${CYAN}$param_str${NC}"
    fi

    local tmp_dep_dir
    tmp_dep_dir=$(mktemp -d /tmp/aft-convert-XXXXXX)

    local aft_ok=0
    aft -i "$sub_yaml" -f zip -o "$tmp_dep_dir" "${param_args[@]}" --no-animation || aft_ok=$?
    rm -f "$sub_yaml"

    if [ "$aft_ok" -eq 0 ]; then
      echo -e "${GREEN}✓ Converted $dep_file with aft${NC}"

      # 1. Process generated proxy bundles (*.zip)
      for pzip in "$tmp_dep_dir"/*.zip; do
        if [ -f "$pzip" ]; then
          local pname
          pname="$(basename "$pzip" .zip)"
          echo -e "  • Proxy bundle: ${CYAN}$pname${NC}"

          # Copy to data/bundles/ (for emulator service & Cloud Run)
          cp "$pzip" "$ROOT_DIR/data/bundles/"
          cp "$pzip" "$DIST_DIR/$pname.zip" 2>/dev/null || true

          # Extract into dist/bundle/src/main/apigee/apiproxies/ (for emulator deployment)
          local target_proxy_dir="$PROXIES_DIR/$pname"
          mkdir -p "$target_proxy_dir"
          unzip -q -o "$pzip" -d "$target_proxy_dir"

          # Generate Proxy YAML definition (type: proxy) for frontend & documentation
          mkdir -p "$ROOT_DIR/data/proxies" "$DIST_DIR/proxies"
          if command -v aft &>/dev/null; then
            aft -i "$pzip" -f proxy -n "$pname" -o "$ROOT_DIR/data/proxies/$pname.yaml" --no-animation 2>/dev/null || true
            cp "$ROOT_DIR/data/proxies/$pname.yaml" "$DIST_DIR/proxies/$pname.yaml" 2>/dev/null || true
          fi

          sanitize_proxy_targets "$target_proxy_dir"
          total_proxies=$((total_proxies + 1))
        fi
      done

      # 2. Process generated test data (products, developers, apps)
      python3 -c "
import json, os

for fname, subdir in [('products.json', 'products'), ('developers.json', 'developers'), ('developerapps.json', 'developerapps')]:
    src = os.path.join('$tmp_dep_dir', fname)
    if os.path.exists(src):
        try:
            with open(src) as f: s_data = json.load(f)
            dst_dist = os.path.join('$DIST_DIR', fname)
            dst_data = os.path.join('$ROOT_DIR', 'data', subdir, fname)
            d_data = []
            if os.path.exists(dst_data):
                with open(dst_data) as f: d_data = json.load(f)
            elif os.path.exists(dst_dist):
                with open(dst_dist) as f: d_data = json.load(f)
            elif os.path.exists(os.path.join('$SCRIPT_DIR', fname)):
                with open(os.path.join('$SCRIPT_DIR', fname)) as f: d_data = json.load(f)

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
                    api_res = prod.get('apiResources', [])
                    if not isinstance(api_res, list) or len(api_res) == 0:
                        prod['apiResources'] = ['/', '/*', '/**']
                    else:
                        for r in ['/', '/*', '/**']:
                            if r not in api_res: api_res.append(r)

            os.makedirs(os.path.dirname(dst_data), exist_ok=True)
            with open(dst_data, 'w') as f:
                json.dump(list(merged.values()), f, indent=2)

            with open(dst_dist, 'w') as f:
                json.dump(list(merged.values()), f, indent=2)
            print(f'  • Updated {fname} in data/{subdir}/ and dist/ ({len(merged)} entries total)')
        except Exception as e:
            print(f'  • Warning merging {fname}: {e}')
"
      if [ -f "$tmp_dep_dir/maps.json" ]; then
        cp "$tmp_dep_dir/maps.json" "$ROOT_DIR/data/maps/maps.json"
        cp "$tmp_dep_dir/maps.json" "$DIST_DIR/maps.json"
      fi
      if [ -f "$tmp_dep_dir/datacollectors.json" ]; then
        cp "$tmp_dep_dir/datacollectors.json" "$ROOT_DIR/data/datacollectors/datacollectors.json"
        cp "$tmp_dep_dir/datacollectors.json" "$DIST_DIR/datacollectors.json"
      fi
    else
      echo -e "${RED}Failed to convert $dep_file with aft${NC}" >&2
    fi
    rm -rf "$tmp_dep_dir"
  done

  echo -e "\n${BOLD}================================================================${NC}"
  echo -e "${GREEN}✓ Conversion completed! Processed $total_proxies proxy bundle(s).${NC}"
  echo -e "  Assets created in:\n    • ${CYAN}$ROOT_DIR/data/bundles/${NC} (proxy bundles)\n    • ${CYAN}$ROOT_DIR/data/{products,developers,developerapps,maps,datacollectors}/${NC} (test data)\n    • ${CYAN}$DIST_DIR/bundle/${NC} (unpacked bundles for deploy.sh)"
  echo -e "${BOLD}================================================================${NC}\n"
}

# ------------------------------------------------------------------------------
# Sub-menu Selector Helper
# ------------------------------------------------------------------------------
browse_and_select() {
  local category_name="$1"
  local getter_fn="$2"
  local default_item="$3"

  local items=()
  while IFS= read -r f; do
    [ -n "$f" ] && items+=("$f")
  done < <($getter_fn)

  if [ ${#items[@]} -eq 0 ]; then
    echo -e "${YELLOW}No YAML files found in $category_name/.${NC}" >&2
    exit 1
  fi

  echo -e "\n${BOLD}Available in $category_name/:${NC}"
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
    SELECTED_TEMPLATES=("${items[@]}")
  elif [[ "$sub_choice" =~ ^[0-9]+$ ]] && [ "$sub_choice" -ge 1 ] && [ "$sub_choice" -le "${#items[@]}" ]; then
    SELECTED_TEMPLATES=("${items[$((sub_choice - 1))]}")
  else
    echo -e "${RED}Invalid selection '$sub_choice'. Aborting.${NC}" >&2
    exit 1
  fi
}

# ------------------------------------------------------------------------------
# 4. Resolve Templates / Proxies / Features to Deploy
# ------------------------------------------------------------------------------
SELECTED_TEMPLATES=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      show_help
      exit 0
      ;;
    -l|--list)
      LIST_ONLY=1
      shift
      ;;
    -a|--all)
      while IFS= read -r file; do
        SELECTED_TEMPLATES+=("$file")
      done < <(get_available_deployments)
      shift
      ;;
    -d|--deployments)
      browse_and_select "data/deployments" get_available_deployments "data/deployments/deployment-1.yaml"
      shift
      ;;
    -c|--convert|--convert-deployments)
      CONVERT_ONLY=1
      shift
      ;;
    -p|--parameters)
      CLI_PARAMETERS+=("$2")
      shift 2
      ;;
    --parameters=*)
      CLI_PARAMETERS+=("${1#*=}")
      shift
      ;;
    -p=*)
      CLI_PARAMETERS+=("${1#*=}")
      shift
      ;;
    --project)
      PROJECT_ID="$2"
      shift 2
      ;;
    --project=*)
      PROJECT_ID="${1#*=}"
      shift
      ;;
    *)
      if [[ "$1" == -* ]]; then
        echo -e "${RED}Unknown option: $1${NC}" >&2
        show_help
        exit 1
      fi
      SELECTED_TEMPLATES+=("$1")
      shift
      ;;
  esac
done

# Initialize parameters, substitute in deployments, and export
apply_parameters_to_all_deployments

if [ "${LIST_ONLY:-0}" -eq 1 ]; then
  list_all
  exit 0
fi

if [ "${CONVERT_ONLY:-0}" -ne 1 ] && [ ${#SELECTED_TEMPLATES[@]} -eq 0 ]; then
  # Interactive mode if a terminal is attached
  if [ -t 0 ]; then
    echo -e "\n${BOLD}Select what you would like to deploy to Apigee Emulator:${NC}"
    echo -e "  ${BOLD}1)${NC} ${CYAN}data/deployments/deployment-1.yaml${NC} ${GREEN}(default)${NC}"
    echo -e "  ${BOLD}2)${NC} Deployments (browse data/deployments/*.yaml)"
    echo -e "  ${BOLD}C)${NC} Convert data/deployments/ into local assets with aft"
    echo -e "  ${BOLD}A)${NC} Deploy ALL deployments"

    echo ""
    read -r -p "Enter selection [1-2, C, A] (default 1): " choice
    choice="${choice:-1}"

    case "$choice" in
      1)
        SELECTED_TEMPLATES=("data/deployments/deployment-1.yaml")
        ;;
      2)
        browse_and_select "data/deployments" get_available_deployments "data/deployments/deployment-1.yaml"
        ;;
      [Cc])
        CONVERT_ONLY=1
        ;;
      [Aa])
        while IFS= read -r f; do
          SELECTED_TEMPLATES+=("$f")
        done < <(get_available_deployments)
        ;;
      *)
        echo -e "${RED}Invalid selection '$choice'. Aborting.${NC}" >&2
        exit 1
        ;;
    esac
  else
    # Non-interactive fallback default
    if [ -f "data/deployments/deployment-1.yaml" ]; then
      SELECTED_TEMPLATES=("data/deployments/deployment-1.yaml")
    else
      read -r first_d < <(get_available_deployments)
      SELECTED_TEMPLATES=("$first_d")
    fi
  fi
fi

# If convert-only requested, run asset conversion and exit
if [ "${CONVERT_ONLY:-0}" -eq 1 ]; then
  convert_deployments_to_assets "${SELECTED_TEMPLATES[@]}"
  exit 0
fi

# ------------------------------------------------------------------------------
# Main Execution
# ------------------------------------------------------------------------------
check_prerequisites
ensure_emulator_running

# Validate test data files exist
TESTDATA_MAP=(
  "datacollectors.json:datacollectors"
  "developerapps.json:developerapps"
  "developers.json:developers"
  "maps.json:maps"
  "products.json:products"
)

for item in "${TESTDATA_MAP[@]}"; do
  td="${item%%:*}"
  sub="${item##*:}"
  if [ ! -f "$ROOT_DIR/data/$sub/$td" ] && [ ! -f "$SCRIPT_DIR/$td" ]; then
    echo -e "${RED}Error: Required test data file missing: data/$sub/$td${NC}" >&2
    exit 1
  fi
done
echo -e "${GREEN}✓ Test data files verified.${NC}"

# Clean and recreate emulator/dist
rm -rf "$DIST_DIR"
mkdir -p "$PROXIES_DIR"
mkdir -p "$ENV_DIR"

PROXIES=()

for YAML_FILE in "${SELECTED_TEMPLATES[@]}"; do
  if [ ! -f "$YAML_FILE" ]; then
    echo -e "${RED}Error: File not found: $YAML_FILE${NC}" >&2
    exit 1
  fi

  # Check if YAML_FILE is a deployment definition
  IS_DEPLOYMENT=$(python3 -c "
import yaml
try:
    with open('$YAML_FILE') as f:
        d = yaml.safe_load(f)
    if isinstance(d, dict) and (d.get('type') == 'deployment' or 'templates' in d or 'deployments' in '$YAML_FILE'):
        print('true')
    else:
        print('false')
except:
    print('false')
")

  if [ "$IS_DEPLOYMENT" = "true" ]; then
    echo -e "\n${BLUE}Compiling deployment from '$YAML_FILE' with aft...${NC}"
    sub_yaml=$(prepare_substituted_deployment_yaml "$YAML_FILE")
    declare -a params=()
    while IFS= read -r param_line; do
      if [ -n "$param_line" ]; then
        params+=("$param_line")
      fi
    done < <(merge_aft_parameters "$sub_yaml")

    param_args=()
    if [ ${#params[@]} -gt 0 ]; then
      param_str=$(IFS=,; echo "${params[*]}")
      param_args=("-p" "$param_str")
      echo -e "  • Parameters (-p): ${CYAN}$param_str${NC}"
    fi

    TMP_DEP_DIR=$(mktemp -d /tmp/aft-dep-XXXXXX)
    aft_ok=0
    aft -i "$sub_yaml" -f zip -o "$TMP_DEP_DIR" "${param_args[@]}" --no-animation || aft_ok=$?
    rm -f "$sub_yaml"
    if [ "$aft_ok" -eq 0 ]; then
      for PZIP in "$TMP_DEP_DIR"/*.zip; do
        if [ -f "$PZIP" ]; then
          PNAME="$(basename "$PZIP" .zip)"
          TARGET_DIR="$PROXIES_DIR/$PNAME"
          mkdir -p "$TARGET_DIR"
          unzip -q -o "$PZIP" -d "$TARGET_DIR"

          cp "$PZIP" "$DIST_DIR/$PNAME.zip" 2>/dev/null || true
          mkdir -p "$ROOT_DIR/data/bundles"
          cp "$PZIP" "$ROOT_DIR/data/bundles/$PNAME.zip" 2>/dev/null || true

          # Generate Proxy YAML definition (type: proxy) for frontend & documentation
          mkdir -p "$ROOT_DIR/data/proxies" "$DIST_DIR/proxies"
          if command -v aft &>/dev/null; then
            aft -i "$PZIP" -f proxy -n "$PNAME" -o "$ROOT_DIR/data/proxies/$PNAME.yaml" --no-animation 2>/dev/null || true
            cp "$ROOT_DIR/data/proxies/$PNAME.yaml" "$DIST_DIR/proxies/$PNAME.yaml" 2>/dev/null || true
          fi

          sanitize_proxy_targets "$TARGET_DIR"
          PROXIES+=("$PNAME")
          echo -e "${GREEN}✓ Successfully compiled $PNAME from deployment${NC}"
        fi
      done

      # Merge products, developers, apps into data/ subdirectories and DIST_DIR
      python3 -c "
import json, os
for fname, subdir in [('products.json', 'products'), ('developers.json', 'developers'), ('developerapps.json', 'developerapps')]:
    src = os.path.join('$TMP_DEP_DIR', fname)
    dst_dist = os.path.join('$DIST_DIR', fname)
    dst_data = os.path.join('$ROOT_DIR', 'data', subdir, fname)
    if os.path.exists(src):
        try:
            with open(src) as f: s_data = json.load(f)
            d_data = []
            if os.path.exists(dst_data):
                with open(dst_data) as f: d_data = json.load(f)
            elif os.path.exists(dst_dist):
                with open(dst_dist) as f: d_data = json.load(f)
            elif os.path.exists(os.path.join('$SCRIPT_DIR', fname)):
                with open(os.path.join('$SCRIPT_DIR', fname)) as f: d_data = json.load(f)
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

            os.makedirs(os.path.dirname(dst_data), exist_ok=True)
            with open(dst_data, 'w') as f:
                json.dump(list(merged.values()), f, indent=2)

            with open(dst_dist, 'w') as f:
                json.dump(list(merged.values()), f, indent=2)
            print(f'  • Merged {fname} into data/{subdir}/ and dist/ ({len(s_data)} deployment entries)')
        except Exception as e:
            print(f'  • Warning merging {fname}: {e}')
"
      if [ -f "$TMP_DEP_DIR/maps.json" ]; then
        cp "$TMP_DEP_DIR/maps.json" "$ROOT_DIR/data/maps/maps.json"
        cp "$TMP_DEP_DIR/maps.json" "$DIST_DIR/maps.json"
      fi
      if [ -f "$TMP_DEP_DIR/datacollectors.json" ]; then
        cp "$TMP_DEP_DIR/datacollectors.json" "$ROOT_DIR/data/datacollectors/datacollectors.json"
        cp "$TMP_DEP_DIR/datacollectors.json" "$DIST_DIR/datacollectors.json"
      fi
    else
      echo -e "${RED}Error: Failed to compile deployment $YAML_FILE with aft.${NC}" >&2
      rm -rf "$TMP_DEP_DIR"
      exit 1
    fi
    rm -rf "$TMP_DEP_DIR"
  else
    PROXY_NAME=$(python3 -c "
import yaml
with open('$YAML_FILE') as f:
    data = yaml.safe_load(f)
print(data.get('name', '') if isinstance(data, dict) else '')
")

    if [ -z "$PROXY_NAME" ]; then
      PROXY_NAME="$(basename "$YAML_FILE" .yaml)"
    fi

    echo -e "\n${BLUE}Compiling proxy '${BOLD}$PROXY_NAME${NC}${BLUE}' from '$YAML_FILE'...${NC}"
    sub_yaml=$(prepare_substituted_deployment_yaml "$YAML_FILE")
    declare -a params=()
    while IFS= read -r param_line; do
      if [ -n "$param_line" ]; then
        params+=("$param_line")
      fi
    done < <(merge_aft_parameters "$sub_yaml")

    param_args=()
    if [ ${#params[@]} -gt 0 ]; then
      param_str=$(IFS=,; echo "${params[*]}")
      param_args=("-p" "$param_str")
      echo -e "  • Parameters (-p): ${CYAN}$param_str${NC}"
    fi

    ZIP_PATH="$DIST_DIR/$PROXY_NAME.zip"
    aft -i "$sub_yaml" -o "$ZIP_PATH" "${param_args[@]}" --no-animation
    rm -f "$sub_yaml"

    TARGET_DIR="$PROXIES_DIR/$PROXY_NAME"
    mkdir -p "$TARGET_DIR"
    unzip -q -o "$ZIP_PATH" -d "$TARGET_DIR"

    # Also copy to data/bundles/
    mkdir -p "$ROOT_DIR/data/bundles"
    cp "$ZIP_PATH" "$ROOT_DIR/data/bundles/$PROXY_NAME.zip" 2>/dev/null || true

    sanitize_proxy_targets "$TARGET_DIR"

    PROXIES+=("$PROXY_NAME")
    echo -e "${GREEN}✓ Successfully compiled $PROXY_NAME${NC}"
  fi
done

# Generate test environment configuration
PROXIES_JSON=$(python3 -c "import sys, json; print(json.dumps(sys.argv[1:]))" "${PROXIES[@]}")

cat << EOF > "$ENV_DIR/env.json"
{
  "name": "test"
}
EOF

cat << EOF > "$ENV_DIR/deployments.json"
{
  "proxies": $PROXIES_JSON
}
EOF

# Copy datacollectors.json to environment directory
if [ -f "$ROOT_DIR/data/datacollectors/datacollectors.json" ]; then
  cp "$ROOT_DIR/data/datacollectors/datacollectors.json" "$ENV_DIR/datacollectors.json"
elif [ -f "$SCRIPT_DIR/datacollectors.json" ]; then
  cp "$SCRIPT_DIR/datacollectors.json" "$ENV_DIR/datacollectors.json"
fi

# Package deployment bundle
DEPLOY_ZIP="$DIST_DIR/bundle.zip"
(cd "$BUNDLE_DIR" && zip -q -r "$DEPLOY_ZIP" src)

# Reset emulator
echo -e "\n${BLUE}Resetting Apigee Emulator state...${NC}"
RESET_CODE=$(curl -s -o /tmp/emulator_reset_resp.txt -w "%{http_code}" -X POST "$EMULATOR_MGMT_URL/v1/emulator/reset")
if [ "$RESET_CODE" != "200" ] && [ "$RESET_CODE" != "201" ]; then
  echo -e "${RED}Error: Failed to reset Apigee Emulator (HTTP $RESET_CODE)${NC}" >&2
  cat /tmp/emulator_reset_resp.txt >&2
  exit 1
fi

# Prepare dynamic products.json ensuring all deployed proxies are authorized
python3 -c "
import json, os

prod_path = '$DIST_DIR/products.json' if os.path.exists('$DIST_DIR/products.json') else '$ROOT_DIR/data/products/products.json' if os.path.exists('$ROOT_DIR/data/products/products.json') else '$SCRIPT_DIR/products.json'
with open(prod_path) as f:
    products = json.load(f)

proxies = json.loads('$PROXIES_JSON')

for prod in products:
    envs = prod.get('environments', [])
    if isinstance(envs, list):
        if 'test' not in envs: envs.append('test')
    else: envs = ['test']
    prod['environments'] = envs

    prod_proxies = prod.get('proxies', [])
    if not isinstance(prod_proxies, list): prod_proxies = []
    for p in proxies:
        if p not in prod_proxies: prod_proxies.append(p)
    prod['proxies'] = prod_proxies

    api_res = prod.get('apiResources', [])
    if not isinstance(api_res, list) or len(api_res) == 0:
        prod['apiResources'] = ['/', '/*', '/**']
    else:
        for r in ['/', '/*', '/**']:
            if r not in api_res: api_res.append(r)

    op_group = prod.get('operationGroup')
    if not isinstance(op_group, dict):
        op_group = {'operationConfigType': 'proxy', 'operationConfigs': []}
        prod['operationGroup'] = op_group
    existing_ops = op_group.get('operationConfigs', [])
    if not isinstance(existing_ops, list):
        existing_ops = []
        op_group['operationConfigs'] = existing_ops
    existing_sources = {c.get('apiSource') for c in existing_ops if isinstance(c, dict)}

    llm_proxies = {p for p in proxies if 'ai' in p.lower() or 'completions' in p.lower()}

    # Standard proxies in operationGroup (split so each config has exactly 1 operation)
    split_ops = []
    for c in existing_ops:
        if isinstance(c, dict):
            src = c.get('apiSource')
            quota = c.get('quota', {})
            ops = c.get('operations', [])
            if len(ops) > 1:
                for op in ops:
                    split_ops.append({'apiSource': src, 'operations': [op], 'quota': quota})
            elif len(ops) == 1:
                split_ops.append(c)
    existing_ops = split_ops

    for p in proxies:
        if p not in existing_sources:
            existing_ops.append({
                'apiSource': p,
                'operations': [{'resource': '/'}],
                'quota': {}
            })
            existing_sources.add(p)
    op_group['operationConfigs'] = existing_ops

    # LLM operations in llmOperationGroup (split so each model/resource is exactly 1 entity per config)
    llm_group = prod.get('llmOperationGroup')
    if not isinstance(llm_group, dict):
        llm_group = {'operationConfigType': 'proxy', 'operationConfigs': []}
        prod['llmOperationGroup'] = llm_group
    existing_llm_ops = llm_group.get('operationConfigs', [])
    if not isinstance(existing_llm_ops, list):
        existing_llm_ops = []

    new_llm_configs = []
    seen_llm = set()
    for c in existing_llm_ops:
        if isinstance(c, dict):
            src = c.get('apiSource')
            quota = c.get('llmTokenQuota', {'limit': '50000', 'interval': '1', 'timeUnit': 'minute'})
            ops = c.get('llmOperations', [])
            for op in ops:
                key = (src, op.get('model'), op.get('resource'))
                if key not in seen_llm:
                    new_llm_configs.append({
                        'apiSource': src,
                        'llmOperations': [op],
                        'llmTokenQuota': quota
                    })
                    seen_llm.add(key)

    # For any configured LLM operation, ensure root resource "/" is authorized
    for c in list(new_llm_configs):
        src = c.get('apiSource')
        quota = c.get('llmTokenQuota', {'limit': '50000', 'interval': '1', 'timeUnit': 'minute'})
        for op in c.get('llmOperations', []):
            m = op.get('model')
            key = (src, m, '/')
            if key not in seen_llm:
                new_llm_configs.append({
                    'apiSource': src,
                    'llmOperations': [{'resource': '/', 'methods': ['POST'], 'model': m}],
                    'llmTokenQuota': quota
                })
                seen_llm.add(key)
    llm_group['operationConfigs'] = new_llm_configs

    if op_group.get('operationConfigs') or llm_group.get('operationConfigs'):
        prod.pop('proxies', None)
        prod.pop('apiResources', None)

# Ensure all products referenced by developer apps exist in products
app_path = '$DIST_DIR/developerapps.json' if os.path.exists('$DIST_DIR/developerapps.json') else '$ROOT_DIR/data/developerapps/developerapps.json' if os.path.exists('$ROOT_DIR/data/developerapps/developerapps.json') else '$SCRIPT_DIR/developerapps.json'
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

with open('$DIST_DIR/products.json', 'w') as f:
    json.dump(products, f, indent=2)
"

# Package test data zip
TESTDATA_ZIP="$DIST_DIR/testdata.zip"
rm -f "$TESTDATA_ZIP"
for item in "${TESTDATA_MAP[@]}"; do
  td="${item%%:*}"
  sub="${item##*:}"
  src_file="$ROOT_DIR/data/$sub/$td"
  if [ -f "$DIST_DIR/$td" ]; then
    src_file="$DIST_DIR/$td"
  elif [ ! -f "$src_file" ] && [ -f "$SCRIPT_DIR/$td" ]; then
    src_file="$SCRIPT_DIR/$td"
  fi
  if [ "$td" = "maps.json" ] && [ -f "$src_file" ]; then
    if [ "$src_file" != "$DIST_DIR/maps.json" ]; then
      cp "$src_file" "$DIST_DIR/maps.json"
    fi
    src_file="$DIST_DIR/maps.json"
    python3 -c "
import json, os, re

def replace_env(val):
    if isinstance(val, str):
        def sub_braces(m):
            vname = m.group(1).strip()
            return os.environ.get(vname, '')
        new_val = re.sub(r'env\.{([^{}]+)}', sub_braces, val)
        m_plain = re.match(r'^env\.([A-Za-z0-9_]+)$', new_val)
        if m_plain:
            return os.environ.get(m_plain.group(1), '')
        return new_val
    elif isinstance(val, dict):
        return {k: replace_env(v) for k, v in val.items()}
    elif isinstance(val, list):
        return [replace_env(item) for item in val]
    return val

try:
    with open('$src_file', 'r') as f:
        data = json.load(f)
    resolved = replace_env(data)
    if isinstance(resolved, list):
        for item in resolved:
            if isinstance(item, dict) and str(item.get('scope', '')).lower() == 'environment':
                if not item.get('environment') and not item.get('env'):
                    item['environment'] = 'test'
                    item['environments'] = ['test']
                    item['env'] = 'test'
    with open('$src_file', 'w') as f:
        json.dump(resolved, f, indent=2)
except Exception:
    pass
" 2>/dev/null || true
  fi
  if [ -f "$src_file" ]; then
    (cd "$(dirname "$src_file")" && zip -q -u "$TESTDATA_ZIP" "$td")
  fi
done

echo -e "${BLUE}Deploying test data (Products, Developer Apps, KVMs)...${NC}"
TEST_STATUS=$(curl -s -o /tmp/emulator_setup_response.txt -w "%{http_code}" -X POST "$EMULATOR_MGMT_URL/v1/emulator/setup/tests" \
  -H "Content-Type: multipart/form-data" \
  -F "file=@$TESTDATA_ZIP")

if [ "$TEST_STATUS" -ne 200 ]; then
  echo -e "${RED}Error: Test data setup failed with HTTP $TEST_STATUS:${NC}" >&2
  cat /tmp/emulator_setup_response.txt >&2
  echo "" >&2
  exit 1
fi

# Sync configured developer app credentials into Cassandra so configured keys (e.g. test-app-key-123) are immediately valid
if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -q "^apigee$"; then
  echo -e "${BLUE}Syncing configured developer app credentials into Cassandra...${NC}"
  python3 -c "
import subprocess, json, os

def run_cql(query):
    cmd = ['docker', 'exec', 'apigee', '/opt/apigee/apache-cassandra-4.0.19/bin/cqlsh', '-e', query]
    res = subprocess.run(cmd, capture_output=True, text=True)
    return res.stdout

try:
    prods_raw = run_cql('SELECT id, name FROM kms_hybrid_hybrid.api_product;')
    apps_raw = run_cql('SELECT id, name FROM kms_hybrid_hybrid.app;')

    prod_map = {}
    for line in prods_raw.splitlines():
        parts = [p.strip() for p in line.split('|')]
        if len(parts) == 2 and len(parts[0]) == 36:
            prod_map[parts[1]] = parts[0]

    app_map = {}
    for line in apps_raw.splitlines():
        parts = [p.strip() for p in line.split('|')]
        if len(parts) == 2 and len(parts[0]) == 36:
            app_map[parts[1]] = parts[0]

    app_files = ['$ROOT_DIR/data/developerapps/developerapps.json', '$DIST_DIR/developerapps.json']
    for af in app_files:
        if os.path.exists(af):
            with open(af) as f:
                dev_apps = json.load(f)
                for app in dev_apps:
                    app_name = app.get('name')
                    app_id = app_map.get(app_name)
                    if not app_id and app_map:
                        app_id = list(app_map.values())[0]
                    if not app_id:
                        continue
                    for cred in app.get('credentials', []):
                        ckey = cred.get('consumerKey')
                        csec = cred.get('consumerSecret', 'secret')
                        if not ckey:
                            continue
                        prod_map_str = '{' + ', '.join([f\"{pid}: 'APPROVED'\" for pid in prod_map.values()]) + '}'
                        q1 = f\"INSERT INTO kms_hybrid_hybrid.app_credential (tid, id, app_id, c_at, iss_at, sts, c_sec, api_prdt) VALUES ('hybrid', '{ckey}', {app_id}, toTimestamp(now()), toTimestamp(now()), 'APPROVED', '{csec}', {prod_map_str});\"
                        q2 = f\"INSERT INTO kms_hybrid_hybrid.app_credential_idx (key, rid) VALUES ('app_id={app_id}&tid=hybrid', 'id={ckey}:tid=hybrid');\"
                        q3 = f\"INSERT INTO kms_hybrid_hybrid.app_credential_idx (key, rid) VALUES ('tid=hybrid', 'id={ckey}:tid=hybrid');\"
                        run_cql(q1)
                        run_cql(q2)
                        run_cql(q3)
except Exception as e:
    pass
" || true
fi
echo -e "${GREEN}✓ Test data deployed successfully.${NC}"

# Deploy proxy bundle
echo -e "${BLUE}Deploying proxy bundle to environment 'test'...${NC}"
DEPLOY_STATUS=$(curl -s -o /tmp/emulator_response.txt -w "%{http_code}" -X POST "$EMULATOR_MGMT_URL/v1/emulator/deploy?environment=test" \
  -H "Content-Type: application/zip" \
  --data-binary "@$DEPLOY_ZIP")

if [ "$DEPLOY_STATUS" -ne 200 ]; then
  echo -e "${RED}Error: Proxy bundle deployment failed with HTTP $DEPLOY_STATUS:${NC}" >&2
  cat /tmp/emulator_response.txt >&2
  echo "" >&2
  exit 1
fi

echo -e "${GREEN}✓ Proxies successfully deployed to Apigee Emulator!${NC}"
cat /tmp/emulator_response.txt
echo ""

# ------------------------------------------------------------------------------
# Display Deployment Tree, Tracing & Test Guidance
# ------------------------------------------------------------------------------
echo -e "\n${BOLD}================================================================${NC}"
echo -e "${BOLD}                     DEPLOYMENT SUMMARY                         ${NC}"
echo -e "${BOLD}================================================================${NC}"

TREE_JSON=$(curl -s "$EMULATOR_MGMT_URL/v1/emulator/tree" 2>/dev/null || echo "[]")
python3 -c "
import json, sys

try:
    tree = json.loads('''$TREE_JSON''')
    if isinstance(tree, list) and tree:
        print('${BOLD}Active Endpoints:${NC}')
        for ep in tree:
            app = ep.get('application', '')
            base = ep.get('basePath', '').lstrip('/')
            print(f'  • {app}: http://localhost:$EMULATOR_ROUTER_PORT/{base}')
    else:
        print('No active endpoints reported.')
except Exception as e:
    print(f'Unable to parse deployment tree: {e}')
"

echo -e "\n${BOLD}Trace Recording:${NC}"
echo -e "  ${CYAN}./emulator/trace_start.sh${NC}      # Starts trace recording session for active proxy"
echo -e "  # Send request(s) to proxy..."
echo -e "  ${CYAN}./emulator/trace_stop.sh${NC}       # Downloads trace to emulator/trace.json & view in trace.html"

echo -e "\n${BOLD}Quick Test Commands:${NC}"
echo -e "  # Test with API Key:"
echo -e "  curl -i \"http://localhost:$EMULATOR_ROUTER_PORT/testproxy\" \\"
echo -e "    -H \"x-api-key: test-api-key-12345\""
echo ""
echo -e "  # View emulator deployment tree:"
echo -e "  curl -s \"$EMULATOR_MGMT_URL/v1/emulator/tree\" | jq ."
echo ""
echo -e "  # View emulator KVM maps:"
echo -e "  curl -s \"$EMULATOR_MGMT_URL/v1/emulator/test/maps\" | jq ."
echo -e "${BOLD}================================================================${NC}\n"
