#!/bin/bash
# Benchmark BDI: per ogni mappa challenge, run da 5 min con A* e PDDL-background
# in parallelo su due server locali; poi PDDL-primary su due mappe.
NODE=C:/nvm4w/nodejs/node.exe
SRV="C:/Users/marco/Desktop/asa/Deliveroo.js/backend"
AG="C:/Users/marco/Desktop/asa/agentbetter/ASA_IntelliAgents"
RAW="$AG/experiments/raw"
DUR=310   # 300s di gioco + margine per la riga di metriche finale

kill_port() {
  netstat -ano | grep -E ":$1 .*LISTENING" | awk '{print $5}' | sort -u | while read pid; do
    taskkill //F //PID $pid >/dev/null 2>&1
  done
}

run_lane() { # $1=map $2=mode(astar|pddlbg|pddlpri) $3=port $4=agentname
  local map=$1 mode=$2 port=$3 name=$4
  local slog="$RAW/server_${map}_${mode}.log" alog="$RAW/agent_${map}_${mode}.log"
  kill_port $port
  sleep 2
  (cd "$SRV" && GAME_NAME=$map PORT=$port exec $NODE index.js) > "$slog" 2>&1 &
  local spid=$!
  sleep 7
  case $mode in
    astar)   (cd "$AG" && HOST="http://localhost:$port" TOKEN="" NAME=$name \
               BDI_USE_PDDL=false \
               timeout $DUR $NODE BDI_agent.js) > "$alog" 2>&1 ;;
    pddlbg)  (cd "$AG" && HOST="http://localhost:$port" TOKEN="" NAME=$name \
               BDI_USE_PDDL=true PDDL_MODE=background AGENT_INSTANCE=$name \
               timeout $DUR $NODE BDI_agent.js) > "$alog" 2>&1 ;;
    pddlpri) (cd "$AG" && HOST="http://localhost:$port" TOKEN="" NAME=$name \
               BDI_USE_PDDL=true PDDL_MODE=primary AGENT_INSTANCE=$name \
               timeout $DUR $NODE BDI_agent.js) > "$alog" 2>&1 ;;
  esac
  kill $spid 2>/dev/null
  kill_port $port
  echo "[bench] done: $map $mode"
}

MAPS="26c1_1 26c1_2 26c1_3 26c1_4 26c1_5 26c1_6 26c1_7 26c1_8"

for map in $MAPS; do
  echo "[bench] === round $map ($(date +%H:%M:%S)) ==="
  run_lane $map astar  8081 bA_$map &
  p1=$!
  run_lane $map pddlbg 8082 bP_$map &
  p2=$!
  wait $p1 $p2
done

echo "[bench] === primary rounds ($(date +%H:%M:%S)) ==="
run_lane 26c1_1 pddlpri 8081 bPri_1 &
p1=$!
run_lane 26c1_3 pddlpri 8082 bPri_3 &
p2=$!
wait $p1 $p2

echo "[bench] ALL DONE $(date +%H:%M:%S)"
