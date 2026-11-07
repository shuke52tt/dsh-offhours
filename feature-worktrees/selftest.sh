#!/usr/bin/env bash
# selftest.sh —— feature-guard 规则回归（自包含：在自己的临时目录里造仓库/注册表）
#
# 用法：bash /root/plugins/feature-worktrees/selftest.sh [--live]
#   --live  额外用**真实注册表**（/root/features + /root/hemou 与其 worktree）跑一遍
#
# 为什么单独成文件而不是一行命令：钩子守卫靠「命令文本里出现会产生 commit 的 git 子命令」
# 判定，而自测脚本的描述文字本身就含那些词——写成文件后，实际执行的命令只剩
# `bash selftest.sh`，既避开自触发，也让回归可复跑。
#
# 退出码：0 全过；1 有失败。

set -uo pipefail
D=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)
F="$D/feature"
# 会话 id 固定成探针值并导出：feature new / ensure 会**自动关联本会话**，若不固定，
# 跑自测就会把**跑测试的那个真实会话**绑到沙箱特性上（实测：doctor 因此报出
# 「关联指向的 worktree 不存在」而假失败）。自测必须是封闭的。
SID_TEST=${SID_TEST:-selftest-sid}
export DSH_SESSION_ID="$SID_TEST"
LIVE=0
[ "${1:-}" = "--live" ] && LIVE=1

pass=0; fail=0
t() { # <描述> <期望码> <命令...>
  local d=$1 e=$2; shift 2
  "$@" >/dev/null 2>&1; local r=$?
  if [ "$r" = "$e" ]; then pass=$((pass+1)); printf '  ok   %-44s (%s)\n' "$d" "$r"
  else fail=$((fail+1)); printf '  FAIL %-44s 期望 %s 实际 %s\n' "$d" "$e" "$r"; fi
}
tj() { # <描述> <期望码> <JSON>
  local d=$1 e=$2 j=$3
  printf '%s' "$j" | bash "$D/feature-guard.sh" >/dev/null 2>&1; local r=$?
  if [ "$r" = "$e" ]; then pass=$((pass+1)); printf '  ok   %-44s (%s)\n' "$d" "$r"
  else fail=$((fail+1)); printf '  FAIL %-44s 期望 %s 实际 %s\n' "$d" "$e" "$r"; fi
}

echo "== 沙箱回归（自造仓库与注册表，不碰真实工程）=="
W=${FEATURE_SELFTEST_ROOT:-/root/plugins/.feature-selftest}
rm -rf "$W"; mkdir -p "$W/registry"
export FEATURE_ROOT="$W/registry"
for r in repoA repoB; do
  git init -q -b main "$W/$r"
  git -C "$W/$r" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
done
bash "$F" repo add alpha "$W/repoA" >/dev/null
bash "$F" repo add beta  "$W/repoB" >/dev/null
bash "$F" new demo-feature   --repos alpha,beta >/dev/null
bash "$F" new second-feature --repos alpha      >/dev/null
WT1="$FEATURE_ROOT/demo-feature/alpha"; WT2="$FEATURE_ROOT/demo-feature/beta"

t "主检出 edit 已存在文件"        2 bash "$F" check --tool edit  --file "$W/repoA/README.md" --cwd "$W"
t "主检出 edit 不存在文件"        2 bash "$F" check --tool edit  --file "$W/repoA/new.md" --cwd "$W"
t "主检出 write 深层新目录"       2 bash "$F" check --tool write --file "$W/repoA/a/b.md" --cwd "$W"
t "worktree edit 已存在文件"      0 bash "$F" check --tool edit  --file "$WT1/README.md" --cwd "$W"
t "worktree write 新文件"         0 bash "$F" check --tool write --file "$WT2/n.md" --cwd "$W"
t "worktree write 深层新目录"     0 bash "$F" check --tool write --file "$WT2/x/y.md" --cwd "$W"
t "主检出 bash commit"            2 bash "$F" check --tool bash --command "git commit -m x" --cwd "$W/repoA"
t "主检出 bash merge"             2 bash "$F" check --tool bash --command "git merge feat/x" --cwd "$W/repoA"
t "主检出 bash rebase"            2 bash "$F" check --tool bash --command "git rebase main" --cwd "$W/repoA"
t "cd 主检出后 commit"            2 bash "$F" check --tool bash --command "cd $W/repoA && git commit -m x" --cwd "$W"
t "git -C 主检出 commit"          2 bash "$F" check --tool bash --command "git -C $W/repoA commit -m x" --cwd "$W"
t "worktree 内 commit"            0 bash "$F" check --tool bash --command "cd $WT1 && git commit -m x" --cwd "$W"
t "主检出只读 git log"            0 bash "$F" check --tool bash --command "git log -3" --cwd "$W/repoA"
t "非 git 目录"                   0 bash "$F" check --tool edit  --file /root/plugins/notrepo.txt --cwd "$W"
t "环境变量豁免"                  0 env FEATURE_ALLOW_MAIN=1 bash "$F" check --tool edit --file "$W/repoA/x.md" --cwd "$W"
t "命令里显式豁免"                0 bash "$F" check --tool bash --command "FEATURE_ALLOW_MAIN=1 git commit -m x" --cwd "$W/repoA"
touch "$FEATURE_ROOT/.allow-main"
t "哨兵文件（新鲜）豁免"          0 bash "$F" check --tool edit --file "$W/repoA/x.md" --cwd "$W"
touch -d '2 hours ago' "$FEATURE_ROOT/.allow-main"
t "哨兵文件（过期）不再豁免"      2 bash "$F" check --tool edit --file "$W/repoA/x.md" --cwd "$W"
rm -f "$FEATURE_ROOT/.allow-main"
bash "$F" clear >/dev/null
t "无 .active 仍拦（严格规则）"   2 bash "$F" check --tool edit --file "$W/repoA/x.md" --cwd "$W"
tj "钩子 stdin：主检出 → 拦"      2 "{\"cwd\":\"/root/plugins\",\"tool_name\":\"write\",\"tool_input\":{\"file_path\":\"$W/repoA/CLAUDE.md\"}}"
tj "钩子 stdin：worktree → 放行"  0 "{\"cwd\":\"/root/plugins\",\"tool_name\":\"write\",\"tool_input\":{\"file_path\":\"$WT2/x.md\"}}"
tj "字符串字面量不触发（防误报）" 0 "{\"cwd\":\"/root/plugins\",\"tool_name\":\"bash\",\"tool_input\":{\"command\":\"echo 'git merge main'\"}}"

if [ "$LIVE" = 1 ] && [ -f /root/features/ai-coding-doc-consistency/feature.json ]; then
  echo; echo "== 活体复验（真实注册表：hemou 主检出 vs 其 worktree）=="
  unset FEATURE_ROOT           # 否则守卫仍按沙箱注册表判定（本文件自测 bug，曾致 2 例假失败）
  H=/root/.dsh/hooks/pre-tool.sh
  LW=$(jq -r '.repos.hemou.path // empty' /root/features/ai-coding-doc-consistency/feature.json)
  tj2() { local d=$1 e=$2 j=$3; printf '%s' "$j" | bash "$H" >/dev/null 2>&1; local r=$?
    if [ "$r" = "$e" ]; then pass=$((pass+1)); printf '  ok   %-44s (%s)\n' "$d" "$r"
    else fail=$((fail+1)); printf '  FAIL %-44s 期望 %s 实际 %s\n' "$d" "$e" "$r"; fi; }
  tj2 "主检出 write 深层新目录"   2 "{\"cwd\":\"/root/plugins\",\"tool_name\":\"write\",\"tool_input\":{\"file_path\":\"/root/hemou/docs/new/deep.md\"}}"
  tj2 "worktree write 深层新目录" 0 "{\"cwd\":\"/root/plugins\",\"tool_name\":\"write\",\"tool_input\":{\"file_path\":\"$LW/docs/new/deep.md\"}}"
  tj2 "主检出 edit 已存在文件"    2 "{\"cwd\":\"/root/plugins\",\"tool_name\":\"edit\",\"tool_input\":{\"file_path\":\"/root/hemou/CLAUDE.md\"}}"
  tj2 "worktree edit 已存在文件"  0 "{\"cwd\":\"/root/plugins\",\"tool_name\":\"edit\",\"tool_input\":{\"file_path\":\"$LW/CLAUDE.md\"}}"
fi

ta() { # <描述> <期望> <实际>
  local d=$1 e=$2 a=$3
  if [ "$a" = "$e" ]; then pass=$((pass+1)); printf '  ok   %-42s (=%s)\n' "$d" "$a"
  else fail=$((fail+1)); printf '  FAIL %-42s 期望 %s 实际 %s\n' "$d" "$e" "$a"; fi
}

echo
echo "== 生命周期：关联 → 上下文 → 回收 =="
export FEATURE_ROOT="$W/registry"    # 上一段活体复验 unset 过它，这里必须重新指回沙箱注册表
SID_TEST="selftest-sid"
t  "attach 绑定会话"           0 env DSH_SESSION_ID=$SID_TEST bash "$F" attach demo-feature
ta "绑定落盘"                  demo-feature "$(jq -r '.feature' "$W/registry/.sessions/$SID_TEST.json" 2>/dev/null)"
t  "status 可读"               0 env DSH_SESSION_ID=$SID_TEST bash "$F" status
t  "context 可读"              0 env DSH_SESSION_ID=$SID_TEST bash "$F" context demo-feature
t  "journal 可写"              0 bash "$F" journal demo-feature "自测：记一条"
ta "日志已追加"                1 "$(grep -c '自测：记一条' "$W/registry/demo-feature/journal.md" 2>/dev/null)"
t  "switch 到另一特性"         0 env DSH_SESSION_ID=$SID_TEST bash "$F" switch second-feature
ta "switch 后绑定"             second-feature "$(jq -r '.feature' "$W/registry/.sessions/$SID_TEST.json" 2>/dev/null)"
t  "detach 解除"               0 env DSH_SESSION_ID=$SID_TEST bash "$F" detach
ta "绑定文件已删"              0 "$(ls "$W/registry/.sessions/$SID_TEST.json" 2>/dev/null | wc -l)"

# 回收：先在该 worktree 里做一个提交 → 预检 → 真回收 → 核对结果
RT="$W/registry/second-feature/alpha"
echo "selftest" > "$RT/payload.txt"
git -C "$RT" add -A && git -C "$RT" -c user.email=t@t -c user.name=t commit -q -m "feat: 自测提交"
t  "recycle 预检（不动手）"     0 bash "$F" recycle second-feature
t  "recycle 真回收"             0 bash "$F" recycle second-feature --yes --delete-branch
ta "回收后主检出在 main"        main "$(git -C "$W/repoA" branch --show-current)"
ta "second-feature 的 worktree 已移除" 0 "$(git -C "$W/repoA" worktree list | grep -c 'second-feature')"
ta "特性分支已删"               0 "$(git -C "$W/repoA" for-each-ref --format='%(refname:short)' refs/heads | grep -c 'feat/second-feature')"
ta "标记为 recycled"            recycled "$(jq -r '.status' "$W/registry/second-feature/feature.json")"
ta "合并提交进了 main"          1 "$(git -C "$W/repoA" log --oneline main | grep -c 'worker 回收')"

# ---- 回收后留路标（2026-10-15）------------------------------------------------
# 起因（用户现场）：recycle 拆掉 worktree 后，**长命会话**里引用过的绝对路径全部变成死链。
# 现在的语义：原路径留一个指向主检出的符号链接（路标）——旧引用仍可读，但它是只读门牌：
# 写/提交会被守卫拦下（git 会把路标解析回主检出，那正是规则 3 要防的事）。
echo
echo "== 回收后留路标：旧路径可读、写仍被拦 =="
t  "回收后旧路径是符号链接"       0 test -L "$RT"
t  "路标指向主检出"               0 test "$(readlink -f "$RT")" = "$W/repoA"
t  "旧路径仍可读（payload.txt）"  0 test -e "$RT/payload.txt"
t  "路标上 edit → 拦"             2 bash "$F" check --tool edit  --file "$RT/payload.txt" --cwd /root/plugins
t  "路标上 write 新文件 → 拦"     2 bash "$F" check --tool write --file "$RT/deep/new.md" --cwd /root/plugins
t  "路标上 bash 只读 → 放行"      0 bash "$F" check --tool bash --command "cat $RT/payload.txt" --cwd /root/plugins
tj "钩子 stdin：路标上 write → 拦" 2 "{\"cwd\":\"/root/plugins\",\"tool_name\":\"write\",\"tool_input\":{\"file_path\":\"$RT/x.md\"}}"
ta "status 在路标里报「已回收」"  1 "$(cd "$RT" && bash "$F" status 2>/dev/null | grep -c '已回收')"
t  "attach 已回收特性 → 拒绝"     1 env DSH_SESSION_ID=$SID_TEST bash "$F" attach second-feature
t  "rescue 已回收特性 → 拒绝"     1 bash "$F" rescue second-feature --project alpha
t  "context 已回收特性 → 可读"    0 bash "$F" context second-feature
ta "list --all 标注「已回收」"    1 "$(bash "$F" list --all 2>/dev/null | grep -c '已回收')"
t  "new 撞已回收特性 → 拒绝"      1 bash "$F" new second-feature --repos alpha
t  "doctor 认可路标"              0 bash "$F" doctor
ta "feature.json 记路标指向"      "$W/repoA" "$(jq -r '.repos.alpha.retiredTo' "$W/registry/second-feature/feature.json" 2>/dev/null)"
t  "REDIRECT.md 已写"             0 test -f "$W/registry/second-feature/REDIRECT.md"
t  "prune 预检（不动手）"         0 bash "$F" prune second-feature
ta "预检确实没删路标"             1 "$(test -L "$RT" && echo 1 || echo 0)"
t  "prune --yes 清理路标"         0 bash "$F" prune second-feature --yes
ta "路标已删"                     0 "$(test -L "$RT" && echo 1 || echo 0)"
ta "主检出毫发无损（文件在）"     1 "$(test -f "$W/repoA/payload.txt" && echo 1 || echo 0)"
ta "主检出毫发无损（分支正常）"   main "$(git -C "$W/repoA" branch --show-current)"
t  "prune --purge 清记录"         0 bash "$F" prune second-feature --purge --yes
ta "feature.json 已清"            0 "$(ls "$W/registry/second-feature/feature.json" 2>/dev/null | wc -l)"
ta "journal 保留为历史"           1 "$(ls "$W/registry"/second-feature.history-*.md 2>/dev/null | wc -l)"

# relink：早期回收的特性没有路标（路标是后加的），或路标被 prune/手滑删掉后要补回来
bash "$F" new relink-feature --repos alpha >/dev/null 2>&1
git -C "$W/registry/relink-feature/alpha" -c user.email=t@t -c user.name=t commit -q --allow-empty -m "feat: relink 自测"
bash "$F" recycle relink-feature --yes >/dev/null 2>&1
rm -f "$W/registry/relink-feature/alpha"                    # 模拟「路标丢了 / 早期回收没留」
t  "relink 预检（不动手）"        0 bash "$F" relink relink-feature
ta "预检确实没补"                 0 "$(test -L "$W/registry/relink-feature/alpha" && echo 1 || echo 0)"
t  "relink --yes 补路标"          0 bash "$F" relink relink-feature --yes
ta "路标已补回"                   1 "$(test -L "$W/registry/relink-feature/alpha" && echo 1 || echo 0)"
ta "补回后旧路径可读"             1 "$(test -e "$W/registry/relink-feature/alpha/payload.txt" && echo 1 || echo 0)"
t  "relink 用在 active 上 → 拒绝" 1 bash "$F" relink demo-feature
t  "relink --all --yes"           0 bash "$F" relink --all --yes

# ---- close 留的是墓碑，不是路标 ------------------------------------------------
# close = 放弃：代码**没有**合进 main，所以绝不能像 recycle 那样指向主检出（那是撒谎）；
# 留下的是「代码在哪个分支、怎么读出来」的说明。
echo
echo "== close 留墓碑（放弃 ≠ 回收）=="
bash "$F" new doomed-feature --repos beta >/dev/null 2>&1
t  "close 一个在用特性"           0 bash "$F" close doomed-feature
ta "close 后没有指向 main 的路标" 0 "$(test -L "$W/registry/doomed-feature/beta" && echo 1 || echo 0)"
t  "CLOSED.md 墓碑已写"           0 test -f "$W/registry/doomed-feature/CLOSED.md"
t  "new 撞墓碑目录 → 拒绝"        1 bash "$F" new doomed-feature --repos beta
t  "prune --purge 清墓碑"         0 bash "$F" prune doomed-feature --purge --yes
ta "墓碑目录已清"                 0 "$(ls -d "$W/registry/doomed-feature" 2>/dev/null | wc -l)"

# ---- 未值守可用性：preflight（权限体检）与 ensure（幂等按需建）------------------
# 现场（用户 2026-10-15）：另一个会话要按需建 worktree，先撞「/root/features 只读」，
# 再撞 DSH 的 create_worktree（本机 git 2.43 不认 --no-lazy-fetch）。所以要有：
#   ① 一条能提前验证「不需要任何人批准就能建 worktree」的命令（preflight，真跑不猜）；
#   ② 一个幂等入口（ensure），未值守会话不必在 new/attach 之间猜；
#   ③ 体检并入 doctor，任何人跑一次自检就能发现「跑批时会不会卡住」。
echo
echo "== 未值守：preflight + ensure =="
t  "preflight 通过（沙箱仓库）"    0 bash "$F" preflight
t  "preflight --repos alpha"       0 bash "$F" preflight --repos alpha
t  "preflight 不存在的工程 → 失败" 1 bash "$F" preflight --repos no-such-project
ta "preflight 不留残留物"          0 "$(ls -d "$W/registry/.preflight"/* 2>/dev/null | wc -l)"
t  "doctor 含权限预检且全绿"       0 bash "$F" doctor
t  "ensure 已存在的特性（幂等）"   0 env DSH_SESSION_ID=$SID_TEST bash "$F" ensure demo-feature
ta "ensure 幂等：未重复建目录"     1 "$(ls -d "$W/registry/demo-feature" 2>/dev/null | wc -l)"
t  "ensure 新特性（按需创建）"     0 env DSH_SESSION_ID=$SID_TEST bash "$F" ensure ensure-feature --repos alpha
ta "新 worktree 已就绪"            1 "$(test -d "$W/registry/ensure-feature/alpha" && echo 1 || echo 0)"
ta "ensure 自动关联本会话"         ensure-feature "$(jq -r '.feature' "$W/registry/.sessions/$SID_TEST.json" 2>/dev/null)"
t  "ensure 不存在且无 --repos → 拒绝" 1 bash "$F" ensure brand-new
ta "未造出幽灵目录"                0 "$(ls -d "$W/registry/brand-new" 2>/dev/null | wc -l)"
t  "ensure 已回收特性 → 拒绝"      1 bash "$F" ensure relink-feature --repos alpha
ta "未把已回收特性当成新建"        1 "$(jq -r '.status' "$W/registry/relink-feature/feature.json" 2>/dev/null | grep -c recycled)"
# 收尾：把探针会话解绑，恢复后面用例假设的「未关联」初态（ensure 会把本会话绑上去）
env DSH_SESSION_ID=$SID_TEST bash "$F" detach >/dev/null 2>&1
ta "探针会话已解绑"                0 "$(ls "$W/registry/.sessions/$SID_TEST.json" 2>/dev/null | wc -l)"

# 会话感知的拦截提示：必须告诉 worker「先关联」，并点名技能
JMSG="{\"cwd\":\"/root/plugins\",\"session_id\":\"$SID_TEST\",\"tool_name\":\"write\",\"tool_input\":{\"file_path\":\"$W/repoA/x.md\"}}"
MSG=$(printf '%s' "$JMSG" | bash "$D/feature-guard.sh" 2>&1 || true)
case "$MSG" in *"feature attach"*) pass=$((pass+1)); printf '  ok   %-42s\n' "拦截提示含「先关联」指引" ;;
  *) fail=$((fail+1)); printf '  FAIL %-42s 提示里没有 feature attach\n' "拦截提示含「先关联」指引" ;; esac
case "$MSG" in *"feature-worktree"*) pass=$((pass+1)); printf '  ok   %-42s\n' "拦截提示点名技能" ;;
  *) fail=$((fail+1)); printf '  FAIL %-42s 提示里没点名技能\n' "拦截提示点名技能" ;; esac

# 反向用例：attach/journal 一个**不存在**的特性，必须失败且**不得**造出幽灵目录或写 .active
rm -f "$FEATURE_ROOT/.active"
t  "attach 不存在的特性 → 失败"  1 env DSH_SESSION_ID=$SID_TEST bash "$F" attach no-such-feature
ta "未造出幽灵特性目录"          0 "$(ls -d "$FEATURE_ROOT/no-such-feature" 2>/dev/null | wc -l)"
ta "未写 .active"                0 "$(ls "$FEATURE_ROOT/.active" 2>/dev/null | wc -l)"
t  "journal 不存在的特性 → 失败" 1 bash "$F" journal no-such-feature "不该被写进去"
ta "journal 未造出目录"          0 "$(ls -d "$FEATURE_ROOT/no-such-feature" 2>/dev/null | wc -l)"

# SessionStart 注入：未关联时必须给出「先关联」指引；在 worktree 内不打扰；已关联时报出归属
SS=/root/.dsh/hooks/session-start.sh
OUT=$(env FEATURE_ROOT="$W/registry" DSH_SESSION_ID=$SID_TEST bash "$SS" <<< "{\"cwd\":\"/root/plugins\",\"session_id\":\"$SID_TEST\"}" 2>/dev/null)
case "$OUT" in *"feature attach"*) pass=$((pass+1)); printf '  ok   %-42s\n' "SessionStart：未关联给指引" ;;
  *) fail=$((fail+1)); printf '  FAIL %-42s\n' "SessionStart：未关联给指引" ;; esac
OUT=$(env FEATURE_ROOT="$W/registry" DSH_SESSION_ID=$SID_TEST bash "$SS" <<< "{\"cwd\":\"$W/registry/demo-feature/alpha\",\"session_id\":\"$SID_TEST\"}" 2>/dev/null)
ta "SessionStart：worktree 内不注入" "" "$OUT"
env FEATURE_ROOT="$W/registry" DSH_SESSION_ID=$SID_TEST bash "$F" attach demo-feature >/dev/null 2>&1
OUT=$(env FEATURE_ROOT="$W/registry" DSH_SESSION_ID=$SID_TEST bash "$SS" <<< "{\"cwd\":\"/root/plugins\",\"session_id\":\"$SID_TEST\"}" 2>/dev/null)
case "$OUT" in *"已关联：demo-feature"*) pass=$((pass+1)); printf '  ok   %-42s\n' "SessionStart：已关联报出归属" ;;
  *) fail=$((fail+1)); printf '  FAIL %-42s\n' "SessionStart：已关联报出归属" ;; esac
env FEATURE_ROOT="$W/registry" DSH_SESSION_ID=$SID_TEST bash "$F" detach >/dev/null 2>&1

# rescue：主检出里滞留的改动 → 搬进特性 worktree（stash → apply，stash 留作备份）
echo "selftest-rescue" > "$W/repoA/RESCUE.txt"
echo "selftest-mod" >> "$W/repoA/README.md" 2>/dev/null || echo "selftest-mod" > "$W/repoA/README.md"
t  "rescue 预检（不动手）"     0 bash "$F" rescue demo-feature --project alpha
ta "预检确实没搬"              2 "$(git -C "$W/repoA" status --porcelain | wc -l)"
t  "rescue 执行"               0 bash "$F" rescue demo-feature --project alpha --yes
ta "主检出已清空未提交"        0 "$(git -C "$W/repoA" status --porcelain | wc -l)"
ta "改动落到 worktree"         1 "$(ls "$W/registry/demo-feature/alpha/RESCUE.txt" 2>/dev/null | wc -l)"
ta "worktree 里有未提交改动"   2 "$(git -C "$W/registry/demo-feature/alpha" status --porcelain | wc -l)"
ta "stash 保留作备份"          1 "$(git -C "$W/repoA" stash list | wc -l)"
t  "audit 可跑"                0 bash "$F" audit

# 守卫的**有效目标**判据：会话 cwd 在主检出、命令指向 worktree → 必须放行（本轮现场修的缺陷）
tj "cwd=主检出 + cd worktree 提交 → 放行" 0 "{\"cwd\":\"$W/repoA\",\"session_id\":\"$SID_TEST\",\"tool_name\":\"bash\",\"tool_input\":{\"command\":\"cd $W/registry/demo-feature/alpha && git commit -m t\"}}"
tj "cwd=主检出 + git -C worktree → 放行"  0 "{\"cwd\":\"$W/repoA\",\"session_id\":\"$SID_TEST\",\"tool_name\":\"bash\",\"tool_input\":{\"command\":\"git -C $W/registry/demo-feature/alpha commit -m t\"}}"
tj "cwd=主检出 + 裸 git commit → 仍拦"    2 "{\"cwd\":\"$W/repoA\",\"session_id\":\"$SID_TEST\",\"tool_name\":\"bash\",\"tool_input\":{\"command\":\"git commit -m t\"}}"
tj "cwd=别处 + cd 主检出提交 → 仍拦"      2 "{\"cwd\":\"/root/plugins\",\"session_id\":\"$SID_TEST\",\"tool_name\":\"bash\",\"tool_input\":{\"command\":\"cd $W/repoA && git commit -m t\"}}"

echo
echo "结果：PASS=$pass FAIL=$fail"
[ "$fail" = 0 ]
