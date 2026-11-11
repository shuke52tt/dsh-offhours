#!/usr/bin/env bash
# 去主机耦合静态门：进包的核心文件里不允许出现 /root/ 绝对路径与主机专属看板名。
set -uo pipefail
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
bad=0
files="$REPO_ROOT/mechanism/scan.sh $REPO_ROOT/mechanism/ns.py \
$REPO_ROOT/feature-worktrees/feature $REPO_ROOT/feature-worktrees/feature-lib.sh \
$REPO_ROOT/feature-worktrees/feature-guard.sh \
$REPO_ROOT/lib/config.js $REPO_ROOT/lib/runtime.js $REPO_ROOT/bin/offhours.mjs \
$REPO_ROOT/panel/index.js"
echo "== no-host-coupling =="
for f in $files; do
  hits=$(grep -n '/root/' "$f" 2>/dev/null || true)
  if [ -n "$hits" ]; then
    echo "  FAIL $f"; printf '%s\n' "$hits" | sed 's/^/    /'; bad=1
  else
    echo "  ok   $(basename "$f")"
  fi
done
echo "  ok   无主机专属看板名（由 community-clean.sh 统一扫描）"
[ "$bad" = 0 ] && echo "  => 通过" || echo "  => 失败"
exit "$bad"
