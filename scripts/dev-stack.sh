#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${CUPBOARD_DEV_STATE_DIR:-$ROOT_DIR/.dev-stack}"
RUN_DIR="$STATE_DIR/run"
LOG_DIR="$STATE_DIR/logs"
ENV_FILE="$STATE_DIR/stack.env"

WEB_PORT="${CUPBOARD_WEB_PORT:-13000}"
MARKETING_PORT="${CUPBOARD_MARKETING_PORT:-13001}"
POSTGRES_PORT="${CUPBOARD_POSTGRES_PORT:-54329}"
REDIS_PORT="${CUPBOARD_REDIS_PORT:-63799}"
START_TIMEOUT="${CUPBOARD_START_TIMEOUT:-180}"

POSTGRES_CONTAINER="cupboard-dev-postgres"
REDIS_CONTAINER="cupboard-dev-redis"
OTEL_CONTAINER="cupboard-dev-otel"
POSTGRES_IMAGE="${CUPBOARD_POSTGRES_IMAGE:-docker.io/library/postgres:18}"
REDIS_IMAGE="${CUPBOARD_REDIS_IMAGE:-docker.io/library/redis:7}"
OTEL_IMAGE="${CUPBOARD_DEV_OTEL_IMAGE:-docker.io/otel/opentelemetry-collector:0.123.0}"
OTEL_GRPC_PORT="${CUPBOARD_DEV_OTEL_PORT:-4317}"

RUST_SERVICES=(auth fleet identity tenant collector metrics gateway)
declare -A SERVICE_PORTS=(
  [gateway]=18080
  [auth]=18081
  [fleet]=18082
  [identity]=18083
  [collector]=18084
  [metrics]=18085
  [tenant]=18086
)

log() {
  printf '[cupboard-dev] %s\n' "$*"
}

die() {
  printf '[cupboard-dev] ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: ./scripts/dev-stack.sh <command> [component]

Commands:
  start              Start the full hot-reload development stack in the background.
  stop               Stop application processes; keep PostgreSQL and Redis running.
  restart            Restart the application processes.
  status             Show managed processes, health, and local/network URLs.
  logs [component]   Follow all logs, or one component log (for example: gateway).
  down               Stop applications plus the PostgreSQL and Redis containers.
  env                Print the path to the private generated development environment.

Environment overrides:
  CUPBOARD_DEV_PUBLIC_HOST, CUPBOARD_WEB_PORT, CUPBOARD_MARKETING_PORT,
  CUPBOARD_POSTGRES_PORT, CUPBOARD_REDIS_PORT, CUPBOARD_DEV_OTEL_PORT,
  CUPBOARD_DEV_OTEL_ENDPOINT, CUPBOARD_DEV_OTEL_IMAGE, CUPBOARD_DEV_OTEL_CPUS,
  CUPBOARD_DEV_OTEL_MEMORY, CUPBOARD_START_TIMEOUT.
EOF
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

prepare_state() {
  umask 077
  mkdir -p "$RUN_DIR" "$LOG_DIR"
}

primary_host() {
  if [[ -n "${CUPBOARD_DEV_PUBLIC_HOST:-}" ]]; then
    printf '%s\n' "$CUPBOARD_DEV_PUBLIC_HOST"
    return
  fi

  # NetBird assigns addresses from 100.64.0.0/10. Do not silently advertise a
  # LAN, container, loopback, or link-local address when the mesh is unavailable.
  hostname -I 2>/dev/null | tr ' ' '\n' | awk -F. \
    'NF == 4 && $1 == 100 && $2 >= 64 && $2 <= 127 { print; exit }'
}

all_ipv4_hosts() {
  {
    printf '127.0.0.1\n'
    hostname -I 2>/dev/null | tr ' ' '\n' | awk 'NF && $0 !~ /:/ && $0 !~ /^127\./'
  } | awk '!seen[$0]++'
}

shell_export() {
  local name="$1" value="$2"
  printf 'export %s=%q\n' "$name" "$value"
}

capture_live_environment() {
  local pid=""
  local proc candidate cwd command_line

  for proc in /proc/[0-9]*; do
    candidate="${proc##*/}"
    [[ -r "$proc/environ" ]] || continue
    cwd="$(readlink "$proc/cwd" 2>/dev/null || true)"
    command_line="$(tr '\0' ' ' < "$proc/cmdline" 2>/dev/null || true)"
    if [[ "$cwd" == "$ROOT_DIR" && "$command_line" == "$ROOT_DIR/target/debug/cupboard-auth " ]]; then
      pid="$candidate"
      break
    fi
  done

  [[ -n "$pid" ]] || return 1

  local tmp="$ENV_FILE.tmp"
  local entry key value
  {
    printf '# Generated from the previously running local Cupboard stack.\n'
    printf '# This file contains secrets, is mode 0600, and must not be committed.\n'
    while IFS= read -r -d '' entry; do
      key="${entry%%=*}"
      value="${entry#*=}"
      case "$key" in
        ACCESS_TOKEN_TTL_SECS|A2S_INTERVAL_SECS|AUTH_INTERNAL_URL|AUTH_SERVICE_URL|BM_API_BASE|BOT_API_TOKEN|COLLECTOR_SERVICE_URL|CONSUMER_NAME|COOKIE_SIGNING_KEY|DATABASE_URL|DATABASE_URL_APP|DB_MAX_CONNECTIONS|DISCORD_BOT_TOKEN|DISCORD_CLIENT_ID|DISCORD_CLIENT_SECRET|DISCORD_REDIRECT_URI|EDGE_HOSTNAME|ENVIRONMENT|FLEET_INTERNAL_URL|FLEET_MASTER_KEY|FLEET_SERVICE_URL|IDENTITY_INTERNAL_URL|IDENTITY_MASTER_KEY|IDENTITY_SERVICE_URL|INTERNAL_API_TOKEN|JWT_PRIVATE_KEY_PEM|JWT_PUBLIC_KEY_PEM|METRICS_SERVICE_URL|PAYNOW_API_BASE|PLAN_WRITE_TOKEN|PLAYER_AUTH_CALLBACK_BASE_URL|PLAYER_JWT_PRIVATE_KEY_PEM|PLAYER_JWT_PUBLIC_KEY_PEM|POLL_INTERVAL_SECS|PRIVACY_TOKEN|PUBLIC_BASE_URL|PUBLIC_WEBHOOK_BASE|RECONCILE_INTERVAL_SECS|REDIS_URL|REFRESH_TOKEN_TTL_SECS|SITES_SUFFIX|STEAM_WEB_API_KEY|STRIPE_API_BASE|STRIPE_PRICE_CUSTOM_DESIGN|STRIPE_PRICE_ENTERPRISE|STRIPE_PRICE_TEAM|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|TEBEX_HEADLESS_BASE|TEBEX_PLUGIN_BASE|TENANT_INTERNAL_URL|TENANT_MASTER_KEY|TENANT_SERVICE_URL|TOKEN_PEPPER|VALUE_PEPPER|WEB_SERVICE_NAME|WEB_SERVICE_PORT)
          shell_export "$key" "$value"
          ;;
      esac
    done < "/proc/$pid/environ"
  } > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
  log "preserved the environment from the existing local stack in $ENV_FILE"
}

random_base64() {
  openssl rand -base64 "$1" | tr -d '\n'
}

generate_environment() {
  local operator_private operator_public player_private player_public public_host tmp
  operator_private="$(openssl genpkey -algorithm ED25519 2>/dev/null)"
  operator_public="$(printf '%s\n' "$operator_private" | openssl pkey -pubout 2>/dev/null)"
  player_private="$(openssl genpkey -algorithm ED25519 2>/dev/null)"
  player_public="$(printf '%s\n' "$player_private" | openssl pkey -pubout 2>/dev/null)"
  public_host="$(primary_host)"
  public_host="${public_host:-localhost}"
  tmp="$ENV_FILE.tmp"

  {
    printf '# Generated local-only Cupboard development credentials.\n'
    printf '# This file contains secrets, is mode 0600, and must not be committed.\n'
    shell_export ENVIRONMENT development
    shell_export DATABASE_URL "postgres://postgres:cupboard@127.0.0.1:$POSTGRES_PORT/cupboard"
    shell_export DATABASE_URL_APP "postgres://postgres:cupboard@127.0.0.1:$POSTGRES_PORT/cupboard"
    shell_export REDIS_URL "redis://127.0.0.1:$REDIS_PORT"
    shell_export JWT_PRIVATE_KEY_PEM "$operator_private"
    shell_export JWT_PUBLIC_KEY_PEM "$operator_public"
    shell_export PLAYER_JWT_PRIVATE_KEY_PEM "$player_private"
    shell_export PLAYER_JWT_PUBLIC_KEY_PEM "$player_public"
    shell_export PLAYER_AUTH_CALLBACK_BASE_URL "http://$public_host:$WEB_PORT"
    shell_export TOKEN_PEPPER "$(random_base64 48)"
    shell_export VALUE_PEPPER "$(random_base64 48)"
    shell_export COOKIE_SIGNING_KEY "$(random_base64 64)"
    shell_export INTERNAL_API_TOKEN "$(random_base64 48)"
    shell_export BOT_API_TOKEN "$(random_base64 48)"
    shell_export PLAN_WRITE_TOKEN "$(random_base64 48)"
    shell_export PRIVACY_TOKEN "$(random_base64 48)"
    shell_export FLEET_MASTER_KEY "$(random_base64 32)"
    shell_export IDENTITY_MASTER_KEY "$(random_base64 32)"
    shell_export TENANT_MASTER_KEY "$(random_base64 32)"
  } > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
  log "generated local development credentials in $ENV_FILE"
}

ensure_environment() {
  [[ -f "$ENV_FILE" ]] && return
  capture_live_environment || generate_environment
}

load_environment() {
  # shellcheck disable=SC1090
  source "$ENV_FILE"

  local public_host origin_list admin_hosts host
  public_host="$(primary_host)"
  public_host="${public_host:-localhost}"

  export ENVIRONMENT="development"
  export AUTH_SERVICE_URL="http://127.0.0.1:${SERVICE_PORTS[auth]}"
  export AUTH_INTERNAL_URL="$AUTH_SERVICE_URL"
  export FLEET_SERVICE_URL="http://127.0.0.1:${SERVICE_PORTS[fleet]}"
  export FLEET_INTERNAL_URL="$FLEET_SERVICE_URL"
  export IDENTITY_SERVICE_URL="http://127.0.0.1:${SERVICE_PORTS[identity]}"
  export IDENTITY_INTERNAL_URL="$IDENTITY_SERVICE_URL"
  export COLLECTOR_SERVICE_URL="http://127.0.0.1:${SERVICE_PORTS[collector]}"
  export METRICS_SERVICE_URL="http://127.0.0.1:${SERVICE_PORTS[metrics]}"
  export TENANT_SERVICE_URL="http://127.0.0.1:${SERVICE_PORTS[tenant]}"
  export TENANT_INTERNAL_URL="$TENANT_SERVICE_URL"
  export GATEWAY_URL="http://127.0.0.1:${SERVICE_PORTS[gateway]}"
  export PUBLIC_BASE_URL="${CUPBOARD_DEV_PUBLIC_BASE_URL:-http://$public_host:$WEB_PORT}"
  export PLAYER_AUTH_CALLBACK_BASE_URL="${CUPBOARD_DEV_PLAYER_CALLBACK_BASE_URL:-$PUBLIC_BASE_URL}"
  export WEB_SERVICE_PORT="$WEB_PORT"
  export NEXT_PUBLIC_BASE_PATH=""
  export CUPBOARD_DEV_OTEL_ENDPOINT="${CUPBOARD_DEV_OTEL_ENDPOINT:-http://127.0.0.1:$OTEL_GRPC_PORT}"

  origin_list="http://localhost:$WEB_PORT,http://127.0.0.1:$WEB_PORT"
  admin_hosts="localhost,localhost:$WEB_PORT,127.0.0.1,127.0.0.1:$WEB_PORT"
  while read -r host; do
    [[ "$host" == "127.0.0.1" ]] && continue
    origin_list+=",http://$host:$WEB_PORT"
    admin_hosts+=",$host,$host:$WEB_PORT"
  done < <(all_ipv4_hosts)
  export ALLOWED_DEV_ORIGINS="${CUPBOARD_ALLOWED_DEV_ORIGINS:-$origin_list}"
  export ADMIN_HOSTS="${CUPBOARD_ADMIN_HOSTS:-$admin_hosts}"
}

container_exists() {
  podman container exists "$1"
}

ensure_infrastructure() {
  if container_exists "$POSTGRES_CONTAINER"; then
    podman start "$POSTGRES_CONTAINER" >/dev/null
  else
    log "creating PostgreSQL 18 development container"
    podman run -d \
      --name "$POSTGRES_CONTAINER" \
      -e POSTGRES_USER=postgres \
      -e POSTGRES_PASSWORD=cupboard \
      -e POSTGRES_DB=cupboard \
      -p "127.0.0.1:$POSTGRES_PORT:5432" \
      -v cupboard-dev-postgres:/var/lib/postgresql \
      "$POSTGRES_IMAGE" >/dev/null
  fi

  if container_exists "$REDIS_CONTAINER"; then
    podman start "$REDIS_CONTAINER" >/dev/null
  else
    log "creating Redis development container"
    podman run -d \
      --name "$REDIS_CONTAINER" \
      -p "127.0.0.1:$REDIS_PORT:6379" \
      -v cupboard-dev-redis:/data \
      "$REDIS_IMAGE" redis-server --appendonly yes >/dev/null
  fi

  if container_exists "$OTEL_CONTAINER"; then
    podman cp "$ROOT_DIR/scripts/otelcol-dev.yaml" "$OTEL_CONTAINER:/etc/otelcol/config.yaml" >/dev/null
    podman start "$OTEL_CONTAINER" >/dev/null
  else
    log "creating lightweight local OTLP collector"
    podman create \
      --name "$OTEL_CONTAINER" \
      --cpus "${CUPBOARD_DEV_OTEL_CPUS:-0.25}" \
      --memory "${CUPBOARD_DEV_OTEL_MEMORY:-128m}" \
      -p "127.0.0.1:$OTEL_GRPC_PORT:4317" \
      "$OTEL_IMAGE" --config /etc/otelcol/config.yaml >/dev/null
    podman cp "$ROOT_DIR/scripts/otelcol-dev.yaml" "$OTEL_CONTAINER:/etc/otelcol/config.yaml" >/dev/null
    podman start "$OTEL_CONTAINER" >/dev/null
  fi

  local deadline=$((SECONDS + 60))
  until podman exec "$POSTGRES_CONTAINER" pg_isready -q 2>/dev/null; do
    (( SECONDS < deadline )) || die "PostgreSQL did not become ready"
    sleep 1
  done
  until podman exec "$REDIS_CONTAINER" redis-cli ping 2>/dev/null | grep -qx PONG; do
    (( SECONDS < deadline )) || die "Redis did not become ready"
    sleep 1
  done
  until podman inspect "$OTEL_CONTAINER" --format '{{.State.Running}}' 2>/dev/null | grep -qx true; do
    (( SECONDS < deadline )) || die "local OTLP collector did not become ready"
    sleep 1
  done
}

component_pid_file() {
  printf '%s/%s.pid\n' "$RUN_DIR" "$1"
}

component_pid() {
  local file
  file="$(component_pid_file "$1")"
  if [[ -r "$file" ]]; then
    cat "$file"
  fi
  return 0
}

component_is_running() {
  local name="$1" pid
  pid="$(component_pid "$name")"
  [[ -n "$pid" && -d "/proc/$pid" ]] || return 1
  tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -qx "CUPBOARD_DEV_COMPONENT=$name"
}

any_component_running() {
  local name
  for name in "${RUST_SERVICES[@]}" web marketing bot-compiler bot; do
    component_is_running "$name" && return 0
  done
  return 1
}

stop_legacy_processes() {
  local -a pids=()
  local proc pid cwd command_line
  for proc in /proc/[0-9]*; do
    pid="${proc##*/}"
    [[ -r "$proc/cmdline" ]] || continue
    if { tr '\0' '\n' < "$proc/environ"; } 2>/dev/null | grep -q '^CUPBOARD_DEV_COMPONENT='; then
      continue
    fi
    cwd="$(readlink "$proc/cwd" 2>/dev/null || true)"
    command_line="$(tr '\0' ' ' < "$proc/cmdline" 2>/dev/null || true)"
    if [[ "$cwd" == "$ROOT_DIR" && "$command_line" =~ ^$ROOT_DIR/target/debug/cupboard-(gateway|auth|fleet|identity|collector|metrics|tenant)[[:space:]]*$ ]]; then
      pids+=("$pid")
    elif [[ "$cwd" == "$ROOT_DIR/apps/web" && "$command_line" =~ (npm[[:space:]]+run[[:space:]]+dev|next[[:space:]]+dev|next-server) ]]; then
      pids+=("$pid")
    fi
  done

  if ((${#pids[@]} == 0)); then
    return 0
  fi
  log "stopping the previous unmanaged Cupboard application processes"
  kill -TERM "${pids[@]}" 2>/dev/null || true
  local deadline=$((SECONDS + 15)) alive candidate
  while (( SECONDS < deadline )); do
    alive=0
    for candidate in "${pids[@]}"; do
      kill -0 "$candidate" 2>/dev/null && alive=1
    done
    (( alive == 0 )) && return
    sleep 1
  done
  kill -KILL "${pids[@]}" 2>/dev/null || true
}

start_component() {
  local name="$1" cwd="$2"
  shift 2
  local pid_file log_file
  pid_file="$(component_pid_file "$name")"
  log_file="$LOG_DIR/$name.log"

  if component_is_running "$name"; then
    log "$name is already running (pid $(component_pid "$name"))"
    return
  fi
  rm -f "$pid_file"
  : > "$log_file"
  (
    cd "$cwd"
    nohup setsid env CUPBOARD_DEV_COMPONENT="$name" "$@" >> "$log_file" 2>&1 < /dev/null &
    printf '%s\n' "$!" > "$pid_file"
  )
  log "started $name (pid $(component_pid "$name"), log $log_file)"
}

ensure_node_dependencies() {
  local app
  for app in web bot; do
    [[ "$app" == bot && -z "${DISCORD_BOT_TOKEN:-}" ]] && continue
    if [[ ! -d "$ROOT_DIR/apps/$app/node_modules" ]]; then
      log "installing $app dependencies"
      (cd "$ROOT_DIR/apps/$app" && npm ci)
    fi
  done
}

start_rust_services() {
  local service port
  local -a service_env
  for service in "${RUST_SERVICES[@]}"; do
    port="${SERVICE_PORTS[$service]}"
    service_env=(env BIND_ADDR="0.0.0.0:$port" CONSUMER_NAME="local-$service")
    if [[ "$service" == metrics ]]; then
      service_env+=(
        OTEL_EXPORTER_OTLP_ENDPOINT="$CUPBOARD_DEV_OTEL_ENDPOINT"
        OTEL_TRACES_EXPORTER=none
      )
    fi
    start_component "$service" "$ROOT_DIR" \
      "${service_env[@]}" \
      cargo watch --quiet \
        --watch Cargo.toml --watch Cargo.lock --watch crates --watch "services/$service" \
        --exec "run -p cupboard-$service"
  done
}

start_frontends() {
  start_component web "$ROOT_DIR/apps/web" \
    npm run dev -- --hostname 0.0.0.0 --port "$WEB_PORT"
  start_component marketing "$ROOT_DIR/apps/marketing" \
    env PORT="$MARKETING_PORT" node --watch server.mjs
}

start_bot() {
  if [[ -z "${DISCORD_BOT_TOKEN:-}" ]]; then
    log "Discord bot skipped: add DISCORD_BOT_TOKEN to $ENV_FILE to enable it"
    return
  fi
  (cd "$ROOT_DIR/apps/bot" && npm run build)
  start_component bot-compiler "$ROOT_DIR/apps/bot" \
    npx tsc -p tsconfig.json --watch --preserveWatchOutput
  start_component bot "$ROOT_DIR/apps/bot" \
    node --watch --import ./dist/register-hook.js dist/index.js
}

wait_for_url() {
  local name="$1" url="$2" deadline=$((SECONDS + START_TIMEOUT))
  until curl --silent --show-error --fail --max-time 2 "$url" >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then
      log "$name did not become healthy; recent log output follows"
      tail -n 30 "$LOG_DIR/$name.log" >&2 || true
      return 1
    fi
    sleep 1
  done
  log "$name is ready at $url"
}

wait_for_stack() {
  local -a checks=()
  local service
  for service in "${RUST_SERVICES[@]}"; do
    checks+=("$service|http://127.0.0.1:${SERVICE_PORTS[$service]}/readyz")
  done
  checks+=("web|http://127.0.0.1:$WEB_PORT/")
  checks+=("marketing|http://127.0.0.1:$MARKETING_PORT/readyz")

  local check name url failed=0
  for check in "${checks[@]}"; do
    name="${check%%|*}"
    url="${check#*|}"
    wait_for_url "$name" "$url" || failed=1
  done
  (( failed == 0 )) || die "one or more development services failed to become ready"
}

start_stack() {
  prepare_state
  require_command cargo
  require_command cargo-watch
  require_command curl
  require_command hostname
  require_command node
  require_command npm
  require_command openssl
  require_command podman

  ensure_environment
  load_environment
  ensure_infrastructure

  if any_component_running; then
    log "managed stack processes already exist; starting any missing components"
  else
    stop_legacy_processes
  fi

  ensure_node_dependencies
  start_rust_services
  start_frontends
  start_bot
  wait_for_stack
  status_stack
}

stop_component() {
  local name="$1" pid_file pid deadline
  pid_file="$(component_pid_file "$name")"
  pid="$(component_pid "$name")"
  if ! component_is_running "$name"; then
    rm -f "$pid_file"
    return
  fi

  log "stopping $name (pid $pid)"
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  deadline=$((SECONDS + 15))
  while kill -0 "$pid" 2>/dev/null && (( SECONDS < deadline )); do
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$pid_file"
}

stop_stack() {
  prepare_state
  local name
  for name in bot bot-compiler marketing web gateway metrics collector tenant identity fleet auth; do
    stop_component "$name"
  done
}

health_label() {
  local url="$1"
  if curl --silent --fail --max-time 1 "$url" >/dev/null 2>&1; then
    printf 'healthy'
  else
    printf 'unhealthy'
  fi
}

status_process() {
  local name="$1" url="${2:-}" pid state health="-"
  pid="$(component_pid "$name")"
  if component_is_running "$name"; then
    state="running"
    [[ -n "$url" ]] && health="$(health_label "$url")"
  else
    state="stopped"
    pid="-"
  fi
  printf '  %-14s %-9s pid=%-8s health=%s\n' "$name" "$state" "$pid" "$health"
}

status_stack() {
  prepare_state
  local service primary
  printf '\nCupboard development stack\n'
  for service in "${RUST_SERVICES[@]}"; do
    status_process "$service" "http://127.0.0.1:${SERVICE_PORTS[$service]}/readyz"
  done
  status_process web "http://127.0.0.1:$WEB_PORT/"
  status_process marketing "http://127.0.0.1:$MARKETING_PORT/readyz"
  status_process bot-compiler
  status_process bot

  printf '  %-14s %s\n' postgres "$(container_exists "$POSTGRES_CONTAINER" 2>/dev/null && podman inspect -f '{{.State.Status}}' "$POSTGRES_CONTAINER" 2>/dev/null || printf stopped)"
  printf '  %-14s %s\n' redis "$(container_exists "$REDIS_CONTAINER" 2>/dev/null && podman inspect -f '{{.State.Status}}' "$REDIS_CONTAINER" 2>/dev/null || printf stopped)"
  printf '  %-14s %s\n' otel "$(container_exists "$OTEL_CONTAINER" 2>/dev/null && podman inspect -f '{{.State.Status}}' "$OTEL_CONTAINER" 2>/dev/null || printf stopped)"

  primary="$(primary_host)"
  printf '\nPrimary network URLs\n'
  if [[ -n "$primary" ]]; then
    printf '  Dashboard:  http://%s:%s/\n' "$primary" "$WEB_PORT"
    printf '  Marketing:  http://%s:%s/\n' "$primary" "$MARKETING_PORT"
    printf '  Gateway:    http://%s:%s/\n' "$primary" "${SERVICE_PORTS[gateway]}"
    printf '  API docs:   http://%s:%s/api/v1/docs\n' "$primary" "${SERVICE_PORTS[gateway]}"
  else
    printf '  NetBird URLs unavailable (no 100.64.0.0/10 address detected)\n'
  fi
  printf '\nAll HTTP services bind to 0.0.0.0. Logs: %s\n' "$LOG_DIR"
  printf '\n'
}

follow_logs() {
  prepare_state
  local component="${1:-}"
  if [[ -n "$component" ]]; then
    [[ -f "$LOG_DIR/$component.log" ]] || die "no log found for component: $component"
    exec tail -n 100 -F "$LOG_DIR/$component.log"
  fi

  local -a logs=("$LOG_DIR"/*.log)
  [[ -e "${logs[0]}" ]] || die "no development logs found; start the stack first"
  exec tail -n 40 -F "${logs[@]}"
}

down_stack() {
  stop_stack
  container_exists "$POSTGRES_CONTAINER" && podman stop "$POSTGRES_CONTAINER" >/dev/null
  container_exists "$REDIS_CONTAINER" && podman stop "$REDIS_CONTAINER" >/dev/null
  container_exists "$OTEL_CONTAINER" && podman stop "$OTEL_CONTAINER" >/dev/null
  log "application processes and development containers are stopped; data volumes were preserved"
}

main() {
  local command="${1:-start}"
  case "$command" in
    start) start_stack ;;
    stop) stop_stack ;;
    restart) stop_stack; start_stack ;;
    status) require_command podman; status_stack ;;
    logs) follow_logs "${2:-}" ;;
    down) require_command podman; down_stack ;;
    env) prepare_state; ensure_environment; printf '%s\n' "$ENV_FILE" ;;
    help|-h|--help) usage ;;
    *) usage >&2; exit 2 ;;
  esac
}

main "$@"
