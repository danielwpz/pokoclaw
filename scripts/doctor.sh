#!/usr/bin/env bash
set -u

REPO_URL="https://github.com/danielwpz/pokoclaw"

info() {
  printf '[doctor] %s\n' "$*"
}

ok() {
  printf '[doctor] ok: %s\n' "$*"
}

fail() {
  printf '[doctor] error: %s\n' "$*" >&2
}

print_windows_unsupported() {
  cat >&2 <<EOF
[doctor] Pokoclaw does not currently support Windows.
[doctor]
[doctor] If you want to help add Windows compatibility, contributions are welcome:
[doctor] ${REPO_URL}
[doctor]
[doctor] Please open an issue or PR with details about your environment.
EOF
}

print_wsl_unsupported() {
  cat >&2 <<EOF
[doctor] Pokoclaw does not currently support WSL.
[doctor]
[doctor] If you want to help add WSL compatibility, contributions are welcome:
[doctor] ${REPO_URL}
[doctor]
[doctor] Please open an issue or PR with details about your environment.
EOF
}

print_unknown_unsupported() {
  local os_name="$1"
  cat >&2 <<EOF
[doctor] Pokoclaw does not currently support this OS: ${os_name}
[doctor]
[doctor] If you want to help add compatibility for this environment, contributions are welcome:
[doctor] ${REPO_URL}
[doctor]
[doctor] Please open an issue or PR with details about your environment.
EOF
}

print_windows_shell_context() {
  info "windows shell context:"
  info "  uname: $(uname -s 2>/dev/null || printf 'unknown')"
  info "  MSYSTEM: ${MSYSTEM:-<unset>}"
  info "  OSTYPE: ${OSTYPE:-<unset>}"
  info "  SHELL: ${SHELL:-<unset>}"
  info "  ComSpec: ${ComSpec:-${COMSPEC:-<unset>}}"
  if command -v bash >/dev/null 2>&1; then
    info "  bash: $(command -v bash)"
  else
    info "  bash: <missing>"
  fi
  info "  bash tool invocation: bash -lc <command>"
}

check_command() {
  local command_name="$1"
  local install_hint="${2:-}"

  if command -v "${command_name}" >/dev/null 2>&1; then
    ok "found ${command_name}: $(command -v "${command_name}")"
    return 0
  fi

  fail "missing ${command_name}"
  if [[ -n "${install_hint}" ]]; then
    info "${install_hint}"
  fi
  return 1
}

check_node_version() {
  if ! command -v node >/dev/null 2>&1; then
    fail "missing node"
    info "Install Node.js 20 or newer."
    return 1
  fi

  local major
  major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0')"
  if [[ "${major}" =~ ^[0-9]+$ && "${major}" -ge 20 ]]; then
    ok "node $(node --version)"
    return 0
  fi

  fail "Node.js 20 or newer is required; found $(node --version 2>/dev/null || printf 'unknown')"
  return 1
}

check_common_tools() {
  local failures=0

  check_node_version || failures=$((failures + 1))
  check_command "pnpm" "Install pnpm 10.15.0 or use Corepack to activate the repo package manager." || failures=$((failures + 1))
  check_command "rg" "Install ripgrep. On Debian/Ubuntu: sudo apt-get install -y ripgrep" || failures=$((failures + 1))

  return "${failures}"
}

run_bwrap_smoke() {
  local label="$1"
  shift

  local output
  if output="$("$@" 2>&1)"; then
    ok "${label}"
    return 0
  fi

  fail "${label} failed"
  if [[ -n "${output}" ]]; then
    printf '%s\n' "${output}" >&2
  fi
  return 1
}

print_linux_dependency_suggestions() {
  cat >&2 <<'EOF'
[doctor]
[doctor] Debian/Ubuntu install suggestion:
[doctor]   sudo apt-get update
[doctor]   sudo apt-get install -y bubblewrap socat ripgrep
EOF
}

print_bwrap_diagnostics() {
  if command -v bwrap >/dev/null 2>&1; then
    info "bwrap binary:"
    ls -l "$(command -v bwrap)" >&2 || true
  fi

  info "Linux namespace diagnostics:"
  sysctl kernel.unprivileged_userns_clone >&2 2>/dev/null || true
  if [[ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]]; then
    printf 'kernel.apparmor_restrict_unprivileged_userns = %s\n' "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" >&2
  fi

  cat >&2 <<'EOF'
[doctor]
[doctor] If bwrap is installed but namespace smoke checks fail on Ubuntu 24.04,
[doctor] this host may require setuid bubblewrap:
[doctor]   sudo chmod u+s "$(command -v bwrap)"
[doctor]
[doctor] Only run that after explicit approval from the system owner. If your
[doctor] organization has a stricter security policy, follow its approved
[doctor] bubblewrap / user namespace setup instead.
EOF
}

check_linux_host() {
  local failures=0
  local bwrap_missing=0

  check_command "bwrap" "Install bubblewrap. On Debian/Ubuntu: sudo apt-get install -y bubblewrap" || {
    failures=$((failures + 1))
    bwrap_missing=1
  }
  check_command "socat" "Install socat. On Debian/Ubuntu: sudo apt-get install -y socat" || failures=$((failures + 1))

  if [[ "${bwrap_missing}" -eq 0 ]]; then
    run_bwrap_smoke "bubblewrap filesystem smoke" bwrap --ro-bind / / true || failures=$((failures + 1))
    run_bwrap_smoke "bubblewrap network namespace smoke" bwrap --ro-bind / / --unshare-net true || failures=$((failures + 1))
  fi

  if [[ "${failures}" -gt 0 ]]; then
    print_linux_dependency_suggestions
    print_bwrap_diagnostics
  fi

  return "${failures}"
}

is_wsl() {
  grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null
}

main() {
  local os_name
  os_name="$(uname -s 2>/dev/null || printf 'unknown')"
  local failures=0

  info "host OS: ${os_name}"

  case "${os_name}" in
    Darwin)
      check_common_tools || failures=$((failures + $?))
      ;;
    Linux)
      if is_wsl; then
        print_wsl_unsupported
        exit 2
      fi
      check_common_tools || failures=$((failures + $?))
      check_linux_host || failures=$((failures + $?))
      ;;
    MINGW* | MSYS* | CYGWIN*)
      print_windows_shell_context
      print_windows_unsupported
      exit 2
      ;;
    *)
      print_unknown_unsupported "${os_name}"
      exit 2
      ;;
  esac

  if [[ "${failures}" -gt 0 ]]; then
    fail "host doctor failed with ${failures} issue(s)"
    exit 1
  fi

  ok "host doctor passed"
}

main "$@"
