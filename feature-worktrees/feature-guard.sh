#!/usr/bin/env bash
# feature-guard.sh —— 主机级 PreToolUse 守卫：写与提交只允许发生在「当前特性」的 worktree 里。
#
# 合同（与 dsh-hook-protocol 一致）：
#   退出 0 = 放行；退出 2 = 阻断（stderr 作为理由交给模型）；其他退出码 = 非阻断失败
#
# 判定顺序（宁可放行，不可误拦；唯一的例外是登记工程主检出上的写与提交）：
#   1. 人工豁免（三条通道，都可见可审计）      → 放行
#      环境 FEATURE_ALLOW_MAIN=1 / 命令里显式写出 / $FEATURES_ROOT/.allow-main（默认 60 分钟有效）
#   2. 目标路径已在某个特性 worktree 内         → 放行（cwd/路径优先于 .active，多特性并行互不干扰）
#   2b. 命令的**有效目标目录**（最后一个 -C/cd）落在特性 worktree 内 → 放行
#       （这条是 2026-10-13 现场补的：会话 cwd 在主检出时，`cd <worktree> && git commit`
#        曾被误判成主检出提交而拦下——判据必须是命令的有效目标，不是「候选里任一命中」）
#   2c. 目标是**已回收特性留下的路标**（原 worktree 路径 → 主检出的符号链接）→ 写/提交一律拦
#       （2026-10-15：回收不再销毁路径，旧会话的引用仍可读；但路标是只读门牌，不是干活的地方）
#   3. 目标仓库根 = 某特性的「主检出」且本次是写或提交 → 阻断，并打印应去的 worktree
#   4. 其余（非登记工程 / 只读命令 / 没有当前特性） → 放行
#
# 怎么用：
#   钩子：stdin 收 dsh 的 JSON（字段 cwd / tool_name / tool_input.{file_path,command}）
#   自测：feature-guard.sh --tool edit --file /repo/CLAUDE.md --cwd /work
#         feature-guard.sh --tool bash --command 'git commit -m x' --cwd /repo
#
# 已知边界（明确不做的）：bash 里用重定向/heredoc/sed -i 直接写主检出的文件**拦不住**
# （那需要解析 shell 语义，代价与误报都不可接受）。拦不住的那条路仍然会在提交时被下一条
# 「主检出上的 git commit 一律拦」挡住，所以「提交只落在特性 worktree」这条硬要求仍然成立。

set -uo pipefail
HERE=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]:-$0}")")" && pwd)
# shellcheck source=feature-lib.sh
. "$HERE/feature-lib.sh"

TOOL=""; FILE=""; CWD=""; CMD=""; SID=""

read_stdin_json() {
  local j
  j=$(cat 2>/dev/null) || return 0
  [ -n "$j" ] || return 0
  TOOL=$(printf '%s' "$j" | jq -r '.tool_name // empty' 2>/dev/null)
  CWD=$(printf '%s' "$j" | jq -r '.cwd // empty' 2>/dev/null)
  FILE=$(printf '%s' "$j" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
  CMD=$(printf '%s' "$j" | jq -r '.tool_input.command // empty' 2>/dev/null)
  SID=$(printf '%s' "$j" | jq -r '.session_id // empty' 2>/dev/null)
}

while [ $# -gt 0 ]; do
  case "$1" in
    --tool)    TOOL=${2:-}; shift 2 ;;
    --file)    FILE=${2:-}; shift 2 ;;
    --cwd)     CWD=${2:-};  shift 2 ;;
    --command) CMD=${2:-};  shift 2 ;;
    --session) SID=${2:-};  shift 2 ;;
    *)         shift ;;
  esac
done
[ -n "$TOOL" ] || read_stdin_json
[ -n "$CWD" ] || CWD=$PWD
[ -n "$SID" ] || SID=$(session_id_now)   # 自测/命令行调用时退回环境变量

# 1) 人工豁免（三条通道，都是可见、可审计的；这不是沙箱，防误操作不防恶意）
#    a. dsh 进程环境里的 FEATURE_ALLOW_MAIN=1
#    b. 本次命令里**显式写出** FEATURE_ALLOW_MAIN=1（GUI 会话里也能用，且会留在记录里）
#    c. 哨兵文件 $FEATURES_ROOT/.allow-main（默认 60 分钟内有效，避免忘了删导致长期失效）
ALLOW=0
[ "${FEATURE_ALLOW_MAIN:-0}" = "1" ] && ALLOW=1
case "${CMD:-}" in *FEATURE_ALLOW_MAIN=1*) ALLOW=1 ;; esac
SENTINEL="$FEATURES_ROOT/.allow-main"
if [ -f "$SENTINEL" ]; then
  ttl=${FEATURE_ALLOW_MAIN_TTL_MIN:-60}
  mtime=$(stat -c %Y "$SENTINEL" 2>/dev/null || echo 0)
  [ "$(( ( $(date +%s) - mtime ) / 60 ))" -le "$ttl" ] && ALLOW=1
fi
[ "$ALLOW" = 1 ] && exit 0

deny() {
  printf '[feature-guard] %s\n' "$1" >&2
  exit 2
}

# 2) 目标已在特性 worktree 内 → 放行（无论 .active 指向谁）
TARGET=${FILE:-$CWD}
if feature_of_path "$TARGET" >/dev/null; then exit 0; fi

# 判断本次是否「写/提交」，并算出**有效目标目录**
IS_WRITE=0
TARGET_DIR=""
case "$TOOL" in
  edit|write|str_replace|apply_patch|multi_edit|notebook_edit)
    IS_WRITE=1
    TARGET_DIR="$TARGET"
    ;;
esac

# bash（或任何带 command 的调用）：只有「会产生 commit 的 git 子命令」算写操作。
# 前缀类刻意**不含引号**：`"git … merge …"` 这种出现在字符串里的字面量不是命令位，
# 不该触发（2026-10-13 实测：把 JSON 当参数传递的自测脚本被误拦）。
# 已知残余误报：`echo "git commit"` 这类把命令当纯文本打印的调用仍会被拦——
# 这是刻意选 fail-safe 方向（宁可多拦，不可漏过真正落在主检出的提交）。
if [ -n "$CMD" ]; then
  if printf '%s' "$CMD" | grep -qE '(^|[[:space:];&|()])git([[:space:]]+[^[:space:]]+)*[[:space:]](commit|merge|rebase|cherry-pick|revert|am)([^[:alnum:]_-]|$)'; then
    IS_WRITE=1
    # ⚠️ 判据是**命令的有效目标目录**，不是「候选里任一命中」（2026-10-13 现场实测的缺陷）：
    # 会话 cwd 常在主检出，而命令可以 `cd <worktree> && git commit` 或 `git -C <worktree> commit`。
    # 旧实现把 cwd 也塞进候选并「任一命中即拦」，于是 worktree 内的提交被误判成主检出提交，
    # 实测被拦 3 次。现在只取**最后一个** -C / cd 目标，取不到才退回 cwd。
    TARGET_DIR=$(printf '%s' "$CMD" | grep -oE '(\-C[[:space:]]+[^[:space:];&|]+)|((^|&&|;|\|)[[:space:]]*cd[[:space:]]+[^[:space:];&|]+)' \
      | sed -E 's/^-[Cc][[:space:]]+//; s/.*[Cc][Dd][[:space:]]+//' | tail -1)
    case "$TARGET_DIR" in /*) ;; *) TARGET_DIR="" ;; esac   # 相对路径不猜
    [ -n "$TARGET_DIR" ] || TARGET_DIR=$CWD
  fi
fi
[ "$IS_WRITE" = 1 ] || exit 0

# 2b) 有效目标已落在某个特性 worktree 内 → 放行（比字符串前缀更稳，顺带覆盖 canonical 差异）
if [ -n "$TARGET_DIR" ] && feature_of_path "$TARGET_DIR" >/dev/null 2>&1; then exit 0; fi

# 2c) 目标是**已回收特性留下的路标**（指向主检出的符号链接）→ 拦，并说清这是什么。
# 路标的存在意义是「旧会话引用过的路径仍可读」（2026-10-15）。读放行（第 2 步只认在用
# 特性，路标因此落到这里）；写与提交一律拦：git 会把路标解析回主检出，那正是规则 3 要防的事。
for cand in ${TARGET_DIR:+"$TARGET_DIR"} ${TARGET:+"$TARGET"}; do
  case "$cand" in /*) ;; *) continue ;; esac
  hit=$(retired_of_path "$cand" 2>/dev/null | head -1)
  [ -n "$hit" ] || continue
  r_slug=$(printf '%s' "$hit" | cut -f1); r_wt=$(printf '%s' "$hit" | cut -f2); r_to=$(printf '%s' "$hit" | cut -f3)
  deny "拒绝对已回收特性的路标动手：$cand
  · 路标：$r_wt → $r_to
  · 特性 $r_slug 已回收：它的代码已经在主干的 main 里；这条路标只为「旧会话引用过的路径仍可读」而留。
  · 它是**只读**入口，不是干活的地方——往这里写会落到主检出上。
  · 要接着改代码：feature new <新特性名> --repos <工程名>      （开一个新特性）
  · 看这个特性做过什么：feature context $r_slug              （合并提交、日志、笔记与看板）
  · 旧路径不再需要时：feature prune $r_slug --yes             （只删符号链接，不动主检出）"
done

# 3) 目标仓库根是某些特性的主检出 → 阻断（列出全部候选 worktree，* 标本会话关联）
_cands=()
[ -n "$TARGET_DIR" ] && _cands+=("$TARGET_DIR")
[ -n "$TARGET" ] && _cands+=("$TARGET")
for cand in ${_cands[@]+"${_cands[@]}"}; do
  case "$cand" in /*) ;; *) continue ;; esac     # 相对路径不猜（宁放行）
  root=$(git_root "$cand") || continue
  [ -n "$root" ] || continue
  feature_of_path "$root" >/dev/null 2>&1 && continue   # 根本身就是 worktree：放行
  owned=$(features_owning_main_checkout "$root")
  [ -n "$owned" ] || continue
  act=$(active_slug)
  bound=$(session_feature "$SID" 2>/dev/null || true)
  active_lines=""; retired_lines=""
  while IFS=$'\t' read -r slug wt st; do
    [ -n "$slug" ] || continue
    if [ "$st" = "recycled" ]; then
      if [ -L "$wt" ]; then
        retired_lines="$retired_lines
  ✓ $slug（已回收；路标可读：$wt → $(readlink -f "$wt" 2>/dev/null)）"
      else
        retired_lines="$retired_lines
  ✓ $slug（已回收；旧路径已不可读：$wt）"
      fi
      continue
    fi
    mark=" "
    [ "$slug" = "$bound" ] && mark="*"
    [ "$slug" != "$bound" ] && [ "$slug" = "$act" ] && mark="·"
    tag=""
    [ "$slug" = "$bound" ] && tag="   ← 本会话已关联"
    active_lines="$active_lines
  $mark $slug → $wt$tag"
  done <<< "$owned"

  # 首选干活位置：只从**在用**特性里挑（已回收的 worktree 是路标，不能 cd 进去干活）
  first_slug=""; first_wt=""
  if [ -n "$bound" ]; then
    first_wt=$(printf '%s\n' "$owned" | awk -F'\t' -v b="$bound" '$1==b && $3!="recycled" {print $2; exit}')
    [ -n "$first_wt" ] && first_slug="$bound"
  fi
  if [ -z "$first_wt" ]; then
    first_slug=$(printf '%s\n' "$owned" | awk -F'\t' '$3!="recycled" {print $1; exit}')
    first_wt=$(printf '%s\n' "$owned" | awk -F'\t' '$3!="recycled" {print $2; exit}')
  fi

  msg="拒绝对工程主检出动手：$root
该工程已纳入特性工作区；主检出不承担开发工作——任何 commit 都只应落在特性 worktree 上。"
  if [ -n "$active_lines" ]; then
    msg="$msg
在用的特性：$active_lines"
  else
    msg="$msg
该工程**当前没有在用的特性**（只有已回收的）。"
  fi
  [ -n "$retired_lines" ] && msg="$msg
已回收（旧路径是只读路标，写入会被拦）：$retired_lines"
  msg="$msg

本会话（${SID:-<未知>}）当前关联：${bound:-无}"
  if [ -n "$first_wt" ]; then
    msg="$msg
请这样做（技能 feature-worktree 有全部操作）：
  1) 先关联到某个特性：feature attach ${bound:-$first_slug}     （关联是**按会话**的，不同会话互不抢）
  2) 到 worktree 里干活：cd ${first_wt} && <命令>   （把会话工作区建在该目录更省事）
  3) 想先恢复这个 worktree 的上下文：feature resume ${bound:-$first_slug}"
  else
    pname=""
    [ -f "$REPOS_FILE" ] && pname=$(jq -r --arg r "$root" 'to_entries[] | select(.value==$r) | .key' "$REPOS_FILE" 2>/dev/null | head -1)
    msg="$msg
请这样做：该工程现在没有在用的特性，要改代码就先开一个：
  feature new <新特性名> --repos ${pname:-<工程名>}      （feature repo list 看工程名）"
  fi
  msg="$msg
确需动主检出（合并到主干、发版、改主机级配置等）时用 FEATURE_ALLOW_MAIN=1 豁免。
（* = 本会话已关联；· = 兜底 .active）"
  deny "$msg"
done

# 4) 其余放行
exit 0
