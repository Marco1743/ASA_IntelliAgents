#!/bin/bash
# Benchmark esteso: le 22 mappe non-challenge, A* + PDDL-background,
# 4 corsie parallele (2 mappe per round, 4 server locali su porte 8081-8084).
NODE=C:/nvm4w/nodejs/node.exe
SRV="C:/Users/marco/Desktop/asa/Deliveroo.js/backend"
AG="C:/Users/marco/Desktop/asa/agentbetter/ASA_IntelliAgents"
RAW="$AG/experiments/raw"
DUR=310

kill_port() {
  netstat -ano | grep -E ":$1 .*LISTENING" | awk '{print $5}' | sort -u | while read pid; do
    taskkill //F //PID $pid >/dev/null 2>&1
  done
}

run_lane() { # $1=map $2=mode $3=port $4=agentname
  local map=$1 mode=$2 port=$3 name=$4
  local slog="$RAW/server_${map}_${mode}.log" alog="$RAW/agent_${map}_${mode}.log"
  kill_port $port
  sleep 2
  (cd "$SRV" && GAME_NAME=$map PORT=$port exec $NODE index.js) > "$slog" 2>&1 &
  local spid=$!
  sleep 7
  case $mode in
    astar)  (cd "$AG" && HOST="http://localhost:$port" TOKEN="" NAME=$name \
              BDI_USE_PDDL=false \
              timeout $DUR $NODE BDI_agent.js) > "$alog" 2>&1 ;;
    pddlbg) (cd "$AG" && HOST="http://localhost:$port" TOKEN="" NAME=$name \
              BDI_USE_PDDL=true PDDL_MODE=background AGENT_INSTANCE=$name \
              timeout $DUR $NODE BDI_agent.js) > "$alog" 2>&1 ;;
  esac
  kill $spid 2>/dev/null
  kill_port $port
  echo "[bench2] done: $map $mode"
}

MAPS="atom chaotic_maze circuit circuit_directional comb crates_maze crates_one_way crossroads decoration empty_10 empty_30 hallway hallways_interconnected hundred long_hallways small_paths small_paths_20 small_two_wide tree two_obstacles vortex wide_paths"

set -- $MAPS
while [ $# -gt 0 ]; do
  m1=$1; m2=$2
  echo "[bench2] === round $m1 ${m2:-} ($(date +%H:%M:%S)) ==="
  run_lane $m1 astar  8081 xA_$m1 &
  p1=$!
  run_lane $m1 pddlbg 8082 xP_$m1 &
  p2=$!
  if [ -n "$m2" ]; then
    run_lane $m2 astar  8083 xA_$m2 &
    p3=$!
    run_lane $m2 pddlbg 8084 xP_$m2 &
    p4=$!
    wait $p1 $p2 $p3 $p4
    shift 2
  else
    wait $p1 $p2
    shift 1
  fi
done

echo "[bench2] ALL DONE $(date +%H:%M:%S)"
