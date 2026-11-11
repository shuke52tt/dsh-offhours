#!/usr/bin/env bash
# feature-lib.sh —— 特性 worktree 注册表的读写（feature CLI 与 feature-guard.sh 共用）
#
# 布局（用户 2026-10-13 拍板的 A 方案：特性在前、工程在后）：
#   <特性根>/<特性名>/feature.json     该特性的元数据（参与工程 / 主检出 / worktree / 分支 / 状态）
#   <特性根>/<特性名>/<工程名>/         每个参与工程的 git worktree
#   <特性根>/<特性名>/journal.md       该特性的**工作日志**（追加型：这个 worktree 干了什么）
#   <特性根>/.sessions/<会话id>.json   **会话 ↔ 特性 绑定**（会话主动关联到某个 worktree）
#   <特性根>/.active                   兜底/展示用的当前特性（一行 slug）
#   <特性根>/.repos.json               工程主检出登记表：{工程名: 路径 或 {path, baseBranch, remote}}
#
# 为什么一律用 jq 取字段：本机既有教训（2026-10-11 改写 hooks.json）就是把整段 stdin JSON
# 当路径传参，使 autosave 自 2026-10-12 00:38 起静默失效两天。**不再让脚本猜输入形状。**

set -uo pipefail

# 特性根：FEATURE_ROOT > 配置 featuresRoot > 用户真实 home 下的 features。
# 用 passwd home 而不是 $HOME：钩子/测试可能把 HOME 指向空目录，但登记表仍在真实 home 下。
user_home() {
  local h
  h=$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)
  printf '%s\n' "${h:-$HOME}"
}
USER_HOME=$(user_home)
OFFHOURS_HOME=${OFFHOURS_HOME:-${DSH_HOME:-$USER_HOME/.dsh}/offhours}
OFFHOURS_CONFIG=${OFFHOURS_CONFIG:-$OFFHOURS_HOME/config.json}
FEATURES_ROOT=${FEATURE_ROOT:-}
if [ -z "$FEATURES_ROOT" ] && [ -f "$OFFHOURS_CONFIG" ]; then
  FEATURES_ROOT=$(jq -r '.featuresRoot // empty' "$OFFHOURS_CONFIG" 2>/dev/null)
fi
FEATURES_ROOT=${FEATURES_ROOT:-$USER_HOME/features}
ACTIVE_FILE="$FEATURES_ROOT/.active"
REPOS_FILE="$FEATURES_ROOT/.repos.json"
SESSIONS_DIR="$FEATURES_ROOT/.sessions"
GIT=(git -c safe.directory='*')

# 所有 git 调用都走这里：**stdin 一律重定向自 /dev/null**。
# 为什么：本文件与 CLI 大量使用 `while read ... done < <(命令)` 逐行驱动，
# 而 git 子命令会继承那个 fd 并可能读走剩余行——实测 `git worktree add` 就让
# 「--repos alpha,beta」只建出 alpha（第二轮循环直接消失）。这不是猜测，是踩过的。
gitr() { "${GIT[@]}" "$@" </dev/null; }

# 合并/同步会**创建提交**，而提交需要 git 身份。root 等环境下没有全局身份时，
# `git merge` 直接失败（fatal: Author identity unknown），调用方只能看到一个笼统的失败——
# 实测表现是 `feature recycle` 报「合并冲突，已 abort」，极具误导性（2026-11-04 排查成本很高）。
# 这里只在**确实缺身份**时补兜底，绝不覆盖用户已配置的 name/email。
# 用法：mapfile -t ID < <(git_identity_args "$repo")  然后 "${ID[@]}"
git_identity_args() { # <repo> → 每行一个参数（0 或 4 行：-c user.name=X -c user.email=Y）
  local repo=$1 n e
  n=$(gitr -C "$repo" config user.name 2>/dev/null || true)
  e=$(gitr -C "$repo" config user.email 2>/dev/null || true)
  [ -n "$n" ] && [ -n "$e" ] && return 0
  printf '%s\n' -c "user.name=${n:-feature-worktree}" -c "user.email=${e:-feature-worktree@localhost}"
}

# 所有特性名（有 feature.json 的目录）
feature_slugs() {
  local d
  [ -d "$FEATURES_ROOT" ] || return 0
  for d in "$FEATURES_ROOT"/*/; do
    [ -f "${d}feature.json" ] || continue
    basename "$d"
  done
}

feature_json() { cat "$FEATURES_ROOT/$1/feature.json" 2>/dev/null; }

# 特性状态：active（在用）/ recycled（已并入 main 并拆了 worktree）
feature_status() { feature_json "$1" | jq -r '.status // "active"' 2>/dev/null; }
feature_is_recycled() { [ "$(feature_status "$1")" = "recycled" ]; }

# 「在用」特性（不含已回收）：**所有「哪里能干活/该去哪里干活」的判断都必须用它**。
# 已回收的 worktree 已经拆掉，原地只剩一个指向主检出的路标（符号链接）——
# 它是给旧会话的引用兜底的只读入口，不再是 worktree（见 feature_retired_path）。
# 性能（2026-11-10）：SessionStart 每次启动都要扫全部特性；原来每个 slug 起一次 jq，
# 208 个特性时钩子要 8s。改成「一次 jq 读全部 feature.json」，把启动成本压到亚秒级。
_feature_files() {
  local f
  for f in "$FEATURES_ROOT"/*/feature.json; do
    [ -f "$f" ] && printf '%s\n' "$f"
  done
}
_feature_slug_of_file() { basename "$(dirname "$1")"; }

feature_slugs_active() {
  local f
  local -a files=()
  while IFS= read -r f; do files+=("$f"); done < <(_feature_files)
  [ "${#files[@]}" -gt 0 ] || return 0
  jq -r 'select((.status // "active") != "recycled") | input_filename' "${files[@]}" 2>/dev/null \
    | while IFS= read -r f; do _feature_slug_of_file "$f"; done
}
feature_slugs_recycled() {
  local f
  local -a files=()
  while IFS= read -r f; do files+=("$f"); done < <(_feature_files)
  [ "${#files[@]}" -gt 0 ] || return 0
  jq -r 'select((.status // "active") == "recycled") | input_filename' "${files[@]}" 2>/dev/null \
    | while IFS= read -r f; do _feature_slug_of_file "$f"; done
}

feature_projects() { feature_json "$1" | jq -r '.repos | keys[]' 2>/dev/null; }
feature_title()    { feature_json "$1" | jq -r '.title // empty' 2>/dev/null; }
feature_wt_path()  { feature_json "$1" | jq -r --arg p "$2" '.repos[$p].path // empty' 2>/dev/null; }
feature_repo_path(){ feature_json "$1" | jq -r --arg p "$2" '.repos[$p].repo // empty' 2>/dev/null; }
feature_branch()   { feature_json "$1" | jq -r --arg p "$2" '.repos[$p].branch // empty' 2>/dev/null; }

# 主检出登记表 <工程名> → 路径
repo_registered_path() {
  [ -f "$REPOS_FILE" ] || return 0
  jq -r --arg p "$1" '.[$p] | if type == "object" then (.path // empty) else (. // empty) end' "$REPOS_FILE" 2>/dev/null
}

repo_registered_meta() { # <工程名> <字段>：登记表值既支持字符串路径，也支持 {path, baseBranch, remote}
  [ -f "$REPOS_FILE" ] || return 0
  jq -r --arg p "$1" --arg k "$2" '.[$p] | if type == "object" then (.[$k] // empty) else empty end' "$REPOS_FILE" 2>/dev/null
}

repo_base_branch() { # <主检出路径> → 基准分支
  local r=$1 b=${FEATURE_BASE_BRANCH:-}
  if [ -z "$b" ] && [ -n "$r" ] && [ -d "$r" ]; then
    b=$(gitr -C "$r" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')
  fi
  if [ -z "$b" ] && [ -n "$r" ] && [ -d "$r" ]; then
    local c
    for c in main master; do
      gitr -C "$r" show-ref --verify --quiet "refs/heads/$c" && { b=$c; break; }
    done
  fi
  printf '%s\n' "${b:-main}"
}

feature_base_branch() { # <工程名> → 基准分支（env > 登记表 > origin/HEAD > main/master）
  local p=$1 r b=${FEATURE_BASE_BRANCH:-}
  [ -n "$b" ] || b=$(repo_registered_meta "$p" baseBranch)
  if [ -z "$b" ]; then r=$(repo_registered_path "$p"); b=$(repo_base_branch "$r"); fi
  printf '%s\n' "${b:-main}"
}

feature_remote() { # <工程名> → 远端名（显式 > 有 gitea 用 gitea > origin）
  local p=$1 r m
  m=$(repo_registered_meta "$p" remote); [ -n "$m" ] && { printf '%s\n' "$m"; return; }
  r=$(repo_registered_path "$p")
  if [ -n "$r" ] && gitr -C "$r" remote 2>/dev/null | grep -qx gitea; then printf 'gitea\n'
  else printf 'origin\n'; fi
}

active_slug() { [ -f "$ACTIVE_FILE" ] && head -1 "$ACTIVE_FILE" | tr -d '[:space:]' || true; }

# 路径 → 所在 git 仓库根（worktree 内返回 worktree 自身路径）。
# 关键：`git -C` 只接受**存在**的目录，所以要逐级上溯：
#   · 文件（存在与否）→ 先取父目录；
#   · 新文件写在尚不存在的深层目录（a/b.md 而 a 也不存在）→ 一直上溯到存在的目录。
# 不做这一步的代价是「写新文件到不存在的子目录」这条路径会静默放行（2026-10-13 回归抓到）。
git_root() {
  local p=$1
  while [ ! -d "$p" ] && [ "$p" != "/" ] && [ -n "$p" ]; do p=$(dirname "$p"); done
  gitr -C "$p" rev-parse --show-toplevel 2>/dev/null
}

# 路标（retired redirect）：已回收特性的原 worktree 路径被换成指向主检出的符号链接。
#
# 为什么要有这一层（2026-10-15，用户现场提出）：`feature recycle` 以前是「合并完把 worktree
# 目录拆掉」，可**会话是长命的**——对话里已经写下、@ 引用过、甚至当工作区用的那些绝对路径
# <特性根>/<特性>/<工程>/... 一夜之间全部变成死链（本机 facet-constitution /
# facet-contract 两个已回收特性正处于该状态）。路标让旧路径继续可读：它解析到主检出，
# 也就是「这个特性的代码现在住的地方」——回收的语义从「销毁」变成「搬家并留下门牌」。
#
# 负向保证：路标**只保证读**。它不是 worktree（feature_of_path 不看已回收特性），
# 往它里面写/提交会被 feature-guard 拦下——git 会把路径解析回主检出，那是主检出上的写。
feature_retired_path() { # <slug> <proj> → 路标路径（仅当该路径确实是符号链接时输出）
  local wt; wt=$(feature_wt_path "$1" "$2")
  [ -n "$wt" ] && [ -L "$wt" ] && printf '%s\n' "$wt"
}

retired_target() { # <slug> <proj> → 路标指向（readlink 优先，其次记录，最后退回主检出）
  local slug=$1 proj=$2 wt t=""
  wt=$(feature_wt_path "$slug" "$proj")
  [ -n "$wt" ] && [ -L "$wt" ] && t=$(readlink -f "$wt" 2>/dev/null)
  [ -n "$t" ] || t=$(feature_json "$slug" | jq -r --arg p "$proj" '.repos[$p].retiredTo // empty' 2>/dev/null)
  [ -n "$t" ] || t=$(feature_repo_path "$slug" "$proj")
  printf '%s\n' "${t:-}"
}

retired_of_path() { # <path> → 每行 "<slug>\t<路标路径>\t<指向>"（命中已回收特性的路标）
  local p=$1 slug proj wt f
  local -a files=()
  while IFS= read -r f; do files+=("$f"); done < <(_feature_files)
  [ "${#files[@]}" -gt 0 ] || return 1
  while IFS=$'\t' read -r f proj wt; do
    [ -n "$wt" ] || continue
    [ -L "$wt" ] || continue
    slug=$(_feature_slug_of_file "$f")
    case "$p" in "$wt"|"$wt"/*) printf '%s\t%s\t%s\n' "$slug" "$wt" "$(retired_target "$slug" "$proj")"; return 0 ;; esac
  done < <(jq -r 'select((.status // "active") == "recycled") | .repos | to_entries[] | [input_filename, .key, .value.path] | @tsv' "${files[@]}" 2>/dev/null)
  return 1
}
retired_feature_of_path() { retired_of_path "$1" 2>/dev/null | head -1 | cut -f1; }

# 路径落在哪个**在用**特性的 worktree 内 → 输出 slug（未命中返回 1）
# 已回收特性刻意不参与：它们的路径只是路标，谁都不能在那儿干活。
feature_of_path() {
  local p=$1 slug wt f
  local -a files=()
  while IFS= read -r f; do files+=("$f"); done < <(_feature_files)
  [ "${#files[@]}" -gt 0 ] || return 1
  while IFS=$'\t' read -r f wt; do
    [ -n "$wt" ] || continue
    slug=$(_feature_slug_of_file "$f")
    case "$p" in "$wt"|"$wt"/*) printf '%s\n' "$slug"; return 0 ;; esac
  done < <(jq -r 'select((.status // "active") != "recycled") | .repos[]?.path as $p | [input_filename, $p] | @tsv' "${files[@]}" 2>/dev/null)
  return 1
}

# 仓库根 root 是哪些特性的**主检出**（不是 worktree）→ 每行 "<slug>\t<worktree>\t<status>"
# 判据与「当前特性(.active)」无关：只要该工程被纳入特性体系，主检出就不是干活的地方。
# ⚠ status 一并给出：已回收特性仍然「占着」主检出的纪律（它的代码就住在 main 里），
# 但调用方**不能**再把它的 worktree 当成候选干活位置（那是路标，只读）。
features_owning_main_checkout() {
  local root=$1 slug repo wt
  for slug in $(feature_slugs); do
    while IFS=$'\t' read -r repo wt; do
      [ -n "$repo" ] || continue
      if [ "$repo" = "$root" ]; then
        printf '%s\t%s\t%s\n' "$slug" "$wt" "$(feature_status "$slug")"
      fi
    done < <(feature_json "$slug" | jq -r '.repos[] | "\(.repo)\t\(.path)"' 2>/dev/null)
  done
}

# ---------------------------------------------------------------- 会话 ↔ 特性 绑定
#
# 为什么要这一层：`.active` 是**全局**的——两个会话同时开工就会互相抢（2026-10-13 实测到）。
# dsh 给每个会话注入了 DSH_SESSION_ID，钩子的 stdin 里也有 session_id，于是可以做到
# 「这个会话关联哪个 worktree」是**按会话**的事实，而不是一个全局指针。
# 关联的语义：**我这个 worker 接下来只在 <worktree> 里干活**；恢复上下文、回收都以它为准。

session_id_now() { printf '%s\n' "${DSH_SESSION_ID:-}"; }
session_file()   { [ -n "${1:-}" ] && printf '%s/%s.json\n' "$SESSIONS_DIR" "$1"; }

session_field() { # <sid> <jq-path>
  local f; f=$(session_file "$1"); [ -f "$f" ] || return 1
  jq -r "$2 // empty" "$f" 2>/dev/null
}
session_feature() { session_field "$1" '.feature'; }
session_project() { session_field "$1" '.project'; }
session_worktree(){ session_field "$1" '.worktree'; }

bind_session() { # <sid> <slug> <project> <worktree>
  [ -n "$1" ] || return 1
  [ -d "$FEATURES_ROOT/$2" ] || return 1
  mkdir -p "$SESSIONS_DIR"
  jq -n --arg s "$1" --arg f "$2" --arg p "$3" --arg w "$4" \
        --arg t "$(date -Is)" --arg c "${PWD:-}" \
    '{session:$s, feature:$f, project:$p, worktree:$w, attachedAt:$t, attachedCwd:$c}' \
    > "$(session_file "$1")"
}
unbind_session() { [ -n "${1:-}" ] && rm -f "$(session_file "$1")"; }

# 关联到某特性的全部会话（每行一个 sid）
sessions_of_feature() {
  local f
  [ -d "$SESSIONS_DIR" ] || return 0
  for f in "$SESSIONS_DIR"/*.json; do
    [ -f "$f" ] || continue
    [ "$(jq -r '.feature // empty' "$f" 2>/dev/null)" = "$1" ] && basename "$f" .json
  done
}

# 会话的有效归属：**先看目标路径落在谁的 worktree 内（位置即归属），再看显式绑定**
effective_feature() { # <sid> <path>
  feature_of_path "$2" 2>/dev/null && return 0
  session_feature "$1" 2>/dev/null && return 0
  return 1
}

# ---------------------------------------------------------------- 特性工作日志
#
# journal 是「这个 worktree 干了什么」的**叙述**；git log 是**事实**。上下文恢复两者都给。
journal_file() { printf '%s/%s/journal.md\n' "$FEATURES_ROOT" "$1"; }
journal_add() { # <slug> <一行文本>；**特性不存在就拒绝**（否则 mkdir -p 会造出幽灵特性目录）
  [ -f "$FEATURES_ROOT/$1/feature.json" ] || return 1
  local f; f=$(journal_file "$1")
  mkdir -p "$(dirname "$f")" || return 0
  [ -f "$f" ] || printf '# %s 工作日志\n\n> 追加型：每次关联/收尾/回收都记一条。事实以 git log 为准，这里记意图与结论。\n\n' "$1" > "$f"
  printf -- '- %s  %s\n' "$(date -Is)" "$2" >> "$f"
}
journal_tail() { # <slug> <行数>
  local f; f=$(journal_file "$1"); [ -f "$f" ] || return 0
  tail -n "${2:-12}" "$f"
}
