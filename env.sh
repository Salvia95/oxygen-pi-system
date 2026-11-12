# shellcheck shell=bash
# oxygen-pi-system 런타임 환경. Git Bash 에서 `source ./env.sh` 하면 번들 도구를 바로 쓸 수 있다.
# oxy 런처도 내부적으로 이 파일을 source 한다. (set -e 등 셸 옵션은 바꾸지 않음)

_oxy_src="${BASH_SOURCE[0]:-$0}"
OXY_HOME="$(cd "$(dirname "$_oxy_src")" && pwd)"
export OXY_HOME
unset _oxy_src

# --- PATH: 번들 바이너리 우선 (중복 추가 방지) ---
case ":$PATH:" in
  *":$OXY_HOME/bin:"*) ;;
  # wrappers/ 가 가장 앞: sql 등 Git Bash 보정 래퍼. runtime/sqlcl/bin 은 일부러 PATH 에 넣지 않음
  *) export PATH="$OXY_HOME/wrappers:$OXY_HOME/bin:$OXY_HOME/runtime/node:$PATH" ;;
esac

# --- pi: 설정 디렉터리를 하네스 내부로, 모든 자동 네트워크 동작 차단 ---
export PI_CODING_AGENT_DIR="$(cygpath -m "$OXY_HOME/agent")"
export PI_OFFLINE=1
export PI_SKIP_VERSION_CHECK=1
export PI_TELEMETRY=0
export OXY_NODE="$OXY_HOME/runtime/node/node.exe"
export OXY_PI_CLI="$(cygpath -m "$OXY_HOME/vendor/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js")"

# --- npm: 폐쇄망에서 레지스트리 접속 시도로 멈추지 않도록 ---
export npm_config_offline=true
export npm_config_update_notifier=false

# --- agent-browser: 소형 모델 컨텍스트 보호 (브라우저 선택은 맨 아래, oxy.env 의 OXY_BROWSER) ---
export AGENT_BROWSER_MAX_OUTPUT="${AGENT_BROWSER_MAX_OUTPUT:-20000}"
# `agent-browser skills get core` 가 읽는 버전 일치 가이드
export AGENT_BROWSER_SKILLS_DIR="$(cygpath -m "$OXY_HOME/vendor/agent-browser-skill-data")"

# --- obscura: 폐쇄망 사이트는 대부분 사설망 주소이므로 SSRF 차단을 해제 (기본은 사설망 접속 차단) ---
export OBSCURA_ALLOW_PRIVATE_NETWORK=1

# --- rg: 경로를 / 로 출력 (pi 의 grep 도구는 --no-config 로 실행하므로 영향 없음) ---
export RIPGREP_CONFIG_PATH="$(cygpath -m "$OXY_HOME/config/ripgreprc")"

# --- glab: 외부 업데이트 확인·텔레메트리·자동 다운로드 끄기, 출력에 하이퍼링크 제어문자 넣지 않기 ---
export GLAB_CHECK_UPDATE=false
export GLAB_SEND_TELEMETRY=false
export GLAB_NOTIFY_SKILL_UPDATES=false
export GLAB_DUO_CLI_AUTO_DOWNLOAD=false
export GLAB_DISPLAY_HYPERLINKS=false

# --- gh: 업데이트 확인·텔레메트리 끄기, 진행 표시 애니메이션 끄기 (에이전트 출력 정리) ---
export GH_NO_UPDATE_NOTIFIER=1
export GH_NO_EXTENSION_UPDATE_NOTIFIER=1
export GH_TELEMETRY=false
export GH_SPINNER_DISABLED=1

# --- 인코딩 ---
export LANG="${LANG:-C.UTF-8}"
export PYTHONUTF8=1

# --- 사용자/사이트별 설정 (vLLM 주소, 모델명, GitLab 호스트 등) ---
if [ -f "$OXY_HOME/agent/oxy.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$OXY_HOME/agent/oxy.env"
  set +a
fi

# --- agent-browser 가 쓸 브라우저: 설치 TUI 가 oxy.env 에 OXY_BROWSER(/OXY_BROWSER_PATH) 로 기록 ---
#   chrome-for-testing | chromium (번들 위치, 하네스를 옮겨도 동작) | obscura (wrappers/agent-browser 가 CDP 서버를 띄움)
#   | edge | chrome-system | custom (OXY_BROWSER_PATH) | none
_oxy_cft="$OXY_HOME/vendor/browsers/chrome-win64/chrome.exe"
_oxy_chromium="$OXY_HOME/vendor/browsers/chromium/chrome.exe"
case "${OXY_BROWSER:-auto}" in
  none) unset AGENT_BROWSER_EXECUTABLE_PATH ;;
  chrome-for-testing) export AGENT_BROWSER_EXECUTABLE_PATH="$(cygpath -m "$_oxy_cft")" ;;
  chromium) export AGENT_BROWSER_EXECUTABLE_PATH="$(cygpath -m "$_oxy_chromium")" ;;
  obscura) unset AGENT_BROWSER_EXECUTABLE_PATH; export OXY_OBSCURA_PORT="${OXY_OBSCURA_PORT:-9233}" ;;
  edge|chrome-system|custom) export AGENT_BROWSER_EXECUTABLE_PATH="${OXY_BROWSER_PATH:-}" ;;
  *) # auto: 설치된 것 중 호환성이 좋은 순서
    if [ -f "$_oxy_cft" ]; then export AGENT_BROWSER_EXECUTABLE_PATH="$(cygpath -m "$_oxy_cft")"
    elif [ -f "$_oxy_chromium" ]; then export AGENT_BROWSER_EXECUTABLE_PATH="$(cygpath -m "$_oxy_chromium")"
    else unset AGENT_BROWSER_EXECUTABLE_PATH; fi ;;
esac
unset _oxy_cft _oxy_chromium
