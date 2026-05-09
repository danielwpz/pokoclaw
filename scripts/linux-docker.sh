#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

IMAGE="${POKOCLAW_LINUX_IMAGE:-pokoclaw-linux-dev:bookworm}"
PLATFORM="${POKOCLAW_LINUX_PLATFORM:-}"
DOCKER_FLAGS="${POKOCLAW_LINUX_DOCKER_FLAGS:---privileged}"
VOLUME_PREFIX="${POKOCLAW_LINUX_VOLUME_PREFIX:-pokoclaw-linux}"
SANDBOX_RUNTIME_ROOT="${POKOCLAW_SANDBOX_RUNTIME_ROOT:-}"

if [[ -z "${SANDBOX_RUNTIME_ROOT}" && -d "${REPO_ROOT}/../sandbox-runtime" ]]; then
  SANDBOX_RUNTIME_ROOT="$(cd "${REPO_ROOT}/../sandbox-runtime" && pwd)"
fi

if [[ -z "${PLATFORM}" ]]; then
  case "$(uname -m)" in
    arm64 | aarch64)
      PLATFORM="linux/arm64"
      ;;
    x86_64 | amd64)
      PLATFORM="linux/amd64"
      ;;
    *)
      PLATFORM="linux/arm64"
      ;;
  esac
fi

usage() {
  cat <<'EOF'
Usage: scripts/linux-docker.sh <command>

Commands:
  build                         Build the reusable Linux dev/test image.
  shell                         Open a Linux shell with Pokoclaw deps installed.
  shell:local-sandbox           Open a Linux shell with ../sandbox-runtime linked.
  preflight                     Run pnpm preflight with the package dependency.
  preflight:local-sandbox       Run pnpm preflight with ../sandbox-runtime linked.
  run -- <cmd>                  Run a command after installing Pokoclaw deps.
  run:local-sandbox -- <cmd>    Run a command with ../sandbox-runtime linked.
  clean-volumes                 Remove Docker volumes used by this helper.

Environment:
  POKOCLAW_LINUX_PLATFORM            Default: host arch mapped to linux/arm64 or linux/amd64
  POKOCLAW_LINUX_IMAGE               Default: pokoclaw-linux-dev:bookworm
  POKOCLAW_LINUX_DOCKER_FLAGS        Default: --privileged
  POKOCLAW_LINUX_VOLUME_PREFIX       Default: pokoclaw-linux
  POKOCLAW_SANDBOX_RUNTIME_ROOT      Default: ../sandbox-runtime when present
EOF
}

DOCKER_PLATFORM_ARGS=(--platform "${PLATFORM}")

build_image() {
  docker build \
    "${DOCKER_PLATFORM_ARGS[@]}" \
    -t "${IMAGE}" \
    -f "${REPO_ROOT}/.docker/linux/Dockerfile" \
    "${REPO_ROOT}"
}

ensure_image() {
  if ! docker image inspect "${IMAGE}" >/dev/null 2>&1; then
    build_image
  fi
}

require_sandbox_runtime() {
  if [[ -z "${SANDBOX_RUNTIME_ROOT}" || ! -f "${SANDBOX_RUNTIME_ROOT}/package.json" ]]; then
    cat >&2 <<'EOF'
Local sandbox-runtime was requested, but no sibling checkout was found.
Set POKOCLAW_SANDBOX_RUNTIME_ROOT=/absolute/path/to/sandbox-runtime and retry.
EOF
    exit 2
  fi
}

pokoclaw_setup_command() {
  cat <<'EOF'
set -euo pipefail
export CI=true
cd /work
pnpm install --frozen-lockfile
EOF
}

local_sandbox_setup_command() {
  cat <<'EOF'
set -euo pipefail
export CI=true
cd /sandbox-runtime
if [[ ! -d node_modules/typescript ]]; then
  npm ci
fi
npm run build

cd /work
pnpm install --frozen-lockfile
mkdir -p node_modules/@danielwpz
rm -rf node_modules/@danielwpz/sandbox-runtime
ln -s /sandbox-runtime node_modules/@danielwpz/sandbox-runtime
node -e 'const fs = require("node:fs"); const pkg = require("./node_modules/@danielwpz/sandbox-runtime/package.json"); console.log(`linked @danielwpz/sandbox-runtime ${pkg.version} -> ${fs.realpathSync("node_modules/@danielwpz/sandbox-runtime")}`);'
EOF
}

join_setup_and_command() {
  local setup_command="$1"
  local command="$2"

  printf "%s\ncd /work\n%s\n" "${setup_command}" "${command}"
}

run_in_container() {
  local command="$1"
  local with_sandbox_runtime="${2:-0}"
  local escaped_tester_command
  local tty_args=(-i)
  local writable_paths="/work/node_modules /home/tester/.npm /home/tester/.local/share/pnpm/store"
  local docker_volume_args=(
    -v "${REPO_ROOT}:/work"
    -v "${VOLUME_PREFIX}-node-modules:/work/node_modules"
    -v "${VOLUME_PREFIX}-npm-cache:/home/tester/.npm"
    -v "${VOLUME_PREFIX}-pnpm-store:/home/tester/.local/share/pnpm/store"
  )

  if [[ "${with_sandbox_runtime}" == "1" ]]; then
    require_sandbox_runtime
    writable_paths="${writable_paths} /sandbox-runtime/node_modules /sandbox-runtime/dist"
    docker_volume_args+=(
      -v "${SANDBOX_RUNTIME_ROOT}:/sandbox-runtime"
      -v "${VOLUME_PREFIX}-sandbox-runtime-node-modules:/sandbox-runtime/node_modules"
      -v "${VOLUME_PREFIX}-sandbox-runtime-dist:/sandbox-runtime/dist"
    )
  fi

  if [[ -t 1 ]]; then
    tty_args=(-it)
  fi

  printf -v escaped_tester_command "%q" "${command}"

  docker run --rm "${tty_args[@]}" \
    "${DOCKER_PLATFORM_ARGS[@]}" \
    ${DOCKER_FLAGS} \
    --user root \
    "${docker_volume_args[@]}" \
    -w /work \
    "${IMAGE}" \
    bash -lc "mkdir -p ${writable_paths} && chown -R tester:tester ${writable_paths} && su tester -c ${escaped_tester_command}"
}

run_pokoclaw_command() {
  local command="$1"
  run_in_container "$(join_setup_and_command "$(pokoclaw_setup_command)" "${command}")" "0"
}

run_local_sandbox_command() {
  local command="$1"
  run_in_container "$(join_setup_and_command "$(local_sandbox_setup_command)" "${command}")" "1"
}

case "${1:-}" in
  build)
    build_image
    ;;
  shell)
    ensure_image
    run_pokoclaw_command "bash"
    ;;
  shell:local-sandbox)
    ensure_image
    run_local_sandbox_command "bash"
    ;;
  preflight)
    ensure_image
    run_pokoclaw_command "pnpm preflight"
    ;;
  preflight:local-sandbox)
    ensure_image
    run_local_sandbox_command "pnpm preflight"
    ;;
  run)
    shift
    if [[ "${1:-}" == "--" ]]; then
      shift
    fi
    if [[ $# -eq 0 ]]; then
      usage >&2
      exit 2
    fi
    ensure_image
    run_pokoclaw_command "$*"
    ;;
  run:local-sandbox)
    shift
    if [[ "${1:-}" == "--" ]]; then
      shift
    fi
    if [[ $# -eq 0 ]]; then
      usage >&2
      exit 2
    fi
    ensure_image
    run_local_sandbox_command "$*"
    ;;
  clean-volumes)
    docker volume rm \
      "${VOLUME_PREFIX}-node-modules" \
      "${VOLUME_PREFIX}-npm-cache" \
      "${VOLUME_PREFIX}-pnpm-store" \
      "${VOLUME_PREFIX}-sandbox-runtime-node-modules" \
      "${VOLUME_PREFIX}-sandbox-runtime-dist" \
      >/dev/null 2>&1 || true
    ;;
  -h | --help | help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
