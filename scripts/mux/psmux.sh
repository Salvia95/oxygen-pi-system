# shellcheck shell=bash
# psmux 어댑터: oxy 가 OXY_MUX=psmux 일 때 source 한다 (docs/tui-spec.md §10 멀티플렉서 정의).
# 멀티플렉서를 더할 때는 이 파일과 같은 함수 세 개를 둔 scripts/mux/<id>.sh 를 만든다.

# 실행할 수 있는지 (선택 구성요소 psmux 가 설치되었는지)
oxy_mux_ready() { [[ -x "$OXY_HOME/bin/psmux.exe" ]]; }

# 이미 세션 안인지 (psmux 는 tmux 처럼 pane 에 $TMUX 를 둔다)
oxy_mux_inside() { [[ -n "${TMUX:-}" ]]; }

# oxy_mux_exec <세션 이름> <Windows 경로> <명령>: 세션이 있으면 다시 연결하고, 없으면 만들어 명령을 실행한다.
#   wrappers/psmux 가 하네스 전용 서버(-L oxy)와 agent/psmux.conf(pane 셸 = Git Bash)를 쓴다
#   명령 앞의 exec: psmux 는 첫 낱말이 파일 경로면 셸 없이 직접 실행하므로 bash 스크립트(oxy)가 시작되지 않는다.
#   셸 내장 명령으로 시작하게 해서 pane 의 bash 가 해석하게 한다 (pi 가 끝나면 pane 도 닫힌다)
oxy_mux_exec() { exec "$OXY_HOME/wrappers/psmux" new-session -A -s "$1" -c "$2" "exec $3"; }
