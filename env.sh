# shellcheck shell=bash
# oxygen-pi-system 런타임 환경. Git Bash 에서 `source env.sh` 하면 번들 도구를 바로 쓸 수 있다.
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

# --- agent-browser: 번들 Chrome 사용, 소형 모델 컨텍스트 보호 ---
export AGENT_BROWSER_EXECUTABLE_PATH="$(cygpath -m "$OXY_HOME/vendor/browsers/chrome-win64/chrome.exe")"
export AGENT_BROWSER_MAX_OUTPUT="${AGENT_BROWSER_MAX_OUTPUT:-20000}"
# `agent-browser skills get core` 가 읽는 버전 일치 가이드
export AGENT_BROWSER_SKILLS_DIR="$(cygpath -m "$OXY_HOME/vendor/agent-browser-skill-data")"

# --- rg: 경로를 / 로 출력 (pi 의 grep 도구는 --no-config 로 실행하므로 영향 없음) ---
export RIPGREP_CONFIG_PATH="$(cygpath -m "$OXY_HOME/config/ripgreprc")"

# --- glab: 외부 업데이트 확인·텔레메트리·자동 다운로드 끄기, 출력에 하이퍼링크 제어문자 넣지 않기 ---
export GLAB_CHECK_UPDATE=false
export GLAB_SEND_TELEMETRY=false
export GLAB_NOTIFY_SKILL_UPDATES=false
export GLAB_DUO_CLI_AUTO_DOWNLOAD=false
export GLAB_DISPLAY_HYPERLINKS=false

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
