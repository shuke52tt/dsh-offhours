#!/usr/bin/env bash
# 夜间跑批修复的共享测试夹具：所有测试都在 /tmp 里造仓库/看板，不碰现役。
set -uo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCAN="$REPO_ROOT/mechanism/scan.sh"
NS_PY="$REPO_ROOT/mechanism/ns.py"
FEATURE_BIN="$REPO_ROOT/feature-worktrees/feature"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   %s\n' "$*"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$*"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1（期望 [$3] 实际 [$2]）"; fi; }
contains() { case "$2" in *"$3"*) ok "$1";; *) bad "$1（缺 [$3]）";; esac; }
done_report() {
  printf '\n结果：PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
  [ "$FAIL" = 0 ]
}

# fixture_new <main|master> → 设置 T/R/FR/RT/B/FHOME/FAKE
fixture_new() {
  local base=${1:-main}
  T=$(mktemp -d /tmp/ns-test.XXXXXX)
  R="$T/repo"; FR="$T/features"; RT="$T/runtime"; B="$T/board.json"
  FHOME="$T/home"; mkdir -p "$R" "$FR" "$RT" "$T/bin" "$FHOME"
  git init -q -b "$base" "$R"
  git -C "$R" config user.email t@t; git -C "$R" config user.name t
  echo base > "$R/f.txt"
  git -C "$R" add -A; git -C "$R" commit -qm init
  printf '{"demo":{"path":"%s","baseBranch":"%s"}}\n' "$R" "$base" > "$FR/.repos.json"
  export FEATURE_ROOT="$FR" DSH_SESSION_ID=session-ns-test
  ( cd "$T" && bash "$FEATURE_BIN" new src --repos demo --title "test fixture" >/dev/null 2>&1 )
  cat > "$B" <<EOF
{"version":1,"cards":[{"id":"card-test0001","title":"测试卡","status":"todo","tags":["auto"],"sourceSessionId":"session-ns-test","summary":"测试","description":"测试卡","createdAt":1762473600000,"updatedAt":1762473600000}]}
EOF
  cat > "$T/bin/fake-dsh" <<'EOS'
#!/usr/bin/env bash
{
  echo "HOME=$HOME"
  echo "DSH_HOME=${DSH_HOME:-}"
  echo "DSH_PERMISSION_MODE=${DSH_PERMISSION_MODE:-}"
  echo "PWD=$PWD"
} > "$NS_TEST_WORKER_ENV"
printf 'worker-change\n' >> f.txt 2>/dev/null || true
echo "KANBAN-RESULT: done"
echo "KANBAN-SYSTEM: system"
echo "KANBAN-SUMMARY: fake worker 完成"
echo "KANBAN-EVIDENCE: echo test-ok"
echo "KANBAN-NOTE: 无"
EOS
  chmod +x "$T/bin/fake-dsh"
}

# run_scan <extra env assignments...>：隔离 HOME/DSH_HOME/PATH，强制跑一轮
run_scan() {
  env -i HOME="$FHOME" PATH="/usr/local/bin:/usr/bin:/bin" DSH_HOME="$FHOME/.dsh" \
    NIGHTSHIFT_BOARD="$B" NIGHTSHIFT_WORKDIR="$T" NIGHTSHIFT_RUNTIME_DIR="$RT" \
    NIGHTSHIFT_SANDBOX=off NIGHTSHIFT_ISOLATED_WORKTREE=1 \
    NIGHTSHIFT_FEATURE_BIN="$FEATURE_BIN" DSH_BIN="$T/bin/fake-dsh" \
    FEATURE_ROOT="$FR" DSH_SESSION_ID=session-ns-test \
    NS_TEST_WORKER_ENV="$T/worker-env" \
    MAX_CARDS_PER_RUN=1 "$@" \
    timeout 180 bash "$SCAN" --force --max-cards=1
}

card_status() {
  python3 - "$B" "$1" <<'PY'
import json, sys
b, cid = sys.argv[1], sys.argv[2]
for c in json.load(open(b, encoding='utf-8')).get('cards', []):
    if c.get('id') == cid:
        print(c.get('status', '?')); break
else:
    print('missing')
PY
}

engine_files() { ( cd "$REPO_ROOT" && find mechanism feature-worktrees -type f | sort ); }
