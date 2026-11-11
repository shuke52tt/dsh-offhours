#!/usr/bin/env bash
# 跑齐本轮修复的验证：静态门 + 三条 e2e + 引擎/特性回归。
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
rc=0
run() { echo; echo "### $*"; "$@" || rc=1; }
run bash "$HERE/no-host-coupling.sh"
echo; echo "### node 单测"
(cd "$ROOT" && node --test tests/node/*.test.mjs) || rc=1
run bash "$HERE/e2e-cards.sh"
run bash "$HERE/e2e-main.sh"
run bash "$HERE/e2e-master.sh"
run bash "$HERE/e2e-cli.sh"
run bash "$HERE/e2e-superagent.sh"
echo; echo "### mechanism/selftest.py"
python3 "$ROOT/mechanism/selftest.py" >/tmp/ns-selftest.out 2>&1 && tail -1 /tmp/ns-selftest.out || { rc=1; tail -20 /tmp/ns-selftest.out; }
echo; echo "### feature selftest"
FEATURE_SELFTEST_ROOT=$(mktemp -d /tmp/feature-st.XXXXXX) FEATURE_ROOT=$(mktemp -d /tmp/feature-root.XXXXXX) \
  bash "$ROOT/feature-worktrees/selftest.sh" 2>&1 | tail -2 | tee /tmp/feature-st.out
grep -q 'FAIL=0' /tmp/feature-st.out || rc=1
echo; [ "$rc" = 0 ] && echo "== 全部通过 ==" || echo "== 有失败 =="
exit "$rc"
