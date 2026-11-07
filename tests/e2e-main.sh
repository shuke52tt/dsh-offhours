#!/usr/bin/env bash
# 零 token e2e：main 仓库 + 假 worker 全链路；同时验证 HOME/权限/运行目录隔离。
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/lib.sh"

before_repo=$(cd "$REPO_ROOT" && git status --porcelain | sort)
fixture_new main
echo "== e2e-main =="
run_scan NIGHTSHIFT_WORKER_PERMISSION_MODE=danger-full-access >"$T/scan.out" 2>&1
rc=$?
eq "scan 退出码" "$rc" "0"
eq "卡片状态 done" "$(card_status card-test0001)" "done"
[ -s "$RT/nightshift.log" ] && ok "运行日志在 RUNTIME_DIR" || bad "运行日志未落在 RUNTIME_DIR"
[ -d "$RT/runs" ] && ok "runs 在 RUNTIME_DIR" || bad "runs 未落在 RUNTIME_DIR"
eq "源仓库无未提交改动" "$(git -C "$R" status --porcelain | wc -l)" "0"

echo "== worker 环境 =="
[ -f "$T/worker-env" ] && ok "假 worker 被启动" || bad "假 worker 未启动"
contains "worker HOME 未被改成 /root" "$(grep '^HOME=' "$T/worker-env" 2>/dev/null)" "HOME=$FHOME"
contains "worker 权限模式已注入" "$(grep '^DSH_PERMISSION_MODE=' "$T/worker-env" 2>/dev/null)" "DSH_PERMISSION_MODE=danger-full-access"
eq "worker 环境里没有 /root" "$(grep -c '/root' "$T/worker-env" 2>/dev/null || true)" "0"

echo "== 运行目录纯净 =="
after_repo=$(cd "$REPO_ROOT" && git status --porcelain | sort)
if [ "$before_repo" = "$after_repo" ]; then ok "引擎目录没有新增运行产物"; else bad "引擎目录被写入：$after_repo"; fi

done_report
