#!/usr/bin/env bash
# 零 token e2e：仓库默认分支是 master 时，跑批 → 回收必须合进 master（不是 main）。
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/lib.sh"

fixture_new master
echo "== e2e-master =="
run_scan NIGHTSHIFT_RECYCLE_TO_MAIN=1 NIGHTSHIFT_PUSH_AFTER_RECYCLE=0 >"$T/scan.out" 2>&1
eq "scan 退出码" "$?" "0"
eq "卡片状态 done" "$(card_status card-test0001)" "done"
eq "主检出仍在 master" "$(git -C "$R" branch --show-current)" "master"
contains "回收进了 master" "$(git -C "$R" log --oneline master -3)" "合并 ns-"
contains "worker 改动已在 master" "$(cat "$R/f.txt")" "worker-change"
contains "回收日志已结算" "$(grep 'RECYCLE 已把 src 合入 demo' "$RT/nightshift.log" | tail -1)" "RECYCLE 已把 src 合入 demo"
eq "仓库里没有凭空出现 main 分支" "$(git -C "$R" show-ref --verify --quiet refs/heads/main; echo $?)" "1"

done_report
