#!/usr/bin/env bash
# nightshift —— 低谷 + 电脑空闲时，把看板待办真的做掉（零 token 判定 + 有界执行）。
#
# 与「cron 插件到点往会话塞提示词」的根本区别：
#   * 本脚本自身不做任何模型调用；低谷/空闲/看板/冷却/预算/锁 全部本地判定。
#   * 条件全满足才启动 worker，并在一个窗口内**连续做最多 MAX_CARDS_PER_RUN 张卡**。
#   * 看板读写由 ns.py 确定性完成（带防丢更新）；worker 只干活并输出四行结果。
#   * 每张卡必须有 KANBAN-EVIDENCE 才允许置 done（否则转待审）；失败计数、超时转待审。
#   * 跑完把 worker 的会话归档到 runs/ 并**删掉会话目录**（界面不留垃圾）。
#
# 用法：
#   scan.sh                    正常模式（systemd timer 每 5 分钟调用）
#   scan.sh --dry-run          只判定并打印会跑哪张；绝不启动 worker、绝不写看板
#   scan.sh --force            跳过时段/空闲/冷却/预算（人工测试用，仍需 MAX_CARDS_PER_RUN 限制）
#   scan.sh --max-cards=1      覆盖本轮最多做几张
#   scan.sh --only=<cardId>    指定只做某张卡（仍受其它安全检查）
#   --dry-run 优先于 --force
set -uo pipefail
# 可替换要执行的 dsh（冒烟测试注入假 worker；生产默认 dsh）——必须在**使用之前**定义
DSH_BIN=${DSH_BIN:-dsh}

PARALLEL=${MAX_PARALLEL_PER_BOARD:-1}   # P6：同板并行度（默认 1 = 顺序，行为不变）
FORCE=0; DRY=0; DAEMON=0
ONLY=""; ONLY_GIVEN=0; MAX_OVERRIDE=""
for a in "$@"; do
  if [ "${PARALLEL_PREV:-0}" = "1" ]; then
    case "$a" in *[!0-9]*|"") : ;; *) PARALLEL="$a";; esac
    PARALLEL_PREV=0
    continue          # 这个参数已经消费掉，别再走下面的 case（否则报"未知参数"）
  fi
  case "$a" in

    --parallel=*) PARALLEL="${a#--parallel=}" ;;
    --parallel) PARALLEL_PREV=1 ;;
    --force) FORCE=1 ;;
    --dry-run) DRY=1 ;;
    --only=*) ONLY="${a#--only=}"; ONLY_GIVEN=1 ;;
    --daemon) DAEMON=1 ;;
    --max-cards=*) MAX_OVERRIDE="${a#--max-cards=}" ;;
    *) echo "未知参数: $a" >&2; exit 2 ;;
  esac
done
# --only= 空值是危险输入：会静默退化成「随便选一张」。宁可报错。
if [ "$ONLY_GIVEN" = 1 ] && [ -z "$ONLY" ]; then log "TRACE-EXIT --only 为空"; echo "--only 需要一个卡 id（不能为空）" >&2; exit 2; fi

SELF_DIR=$(cd "$(dirname "$0")" && pwd)
# CODE_DIR = 代码所在（可被 npm 包/符号链接指到只读目录）；RUNTIME_DIR = 状态/日志/锁/槽位。
# 现役不设 NIGHTSHIFT_RUNTIME_DIR ⇒ 默认仍是 SELF_DIR，行为与升级前完全一致（零迁移）。
RUNTIME_DIR=${NIGHTSHIFT_RUNTIME_DIR:-$SELF_DIR}
export NIGHTSHIFT_RUNTIME_DIR="$RUNTIME_DIR"
# 明确要求调用方给看板：不再回落到任何主机绝对路径（systemd 单元/插件都会显式注入）。
BOARD=${NIGHTSHIFT_BOARD:-}
if [ -z "$BOARD" ]; then
  echo "NIGHTSHIFT_BOARD 未设置：scan.sh 需要显式看板路径（systemd 单元或插件配置负责注入）" >&2
  exit 2
fi
WORKDIR=${NIGHTSHIFT_WORKDIR:-$(dirname "$BOARD")}
# 独占 worktree（2026-10-16 用户要求）：1=每张卡先在"源会话 worktree"的子分支上干活，
# 完成时再 merge --no-ff 回源 worktree；默认 0（关闭），默认行为与今天一致。
ISOLATED=${NIGHTSHIFT_ISOLATED_WORKTREE:-0}
# --only 支持逗号分隔的多张卡（面板"批量执行"用）：shell 里用空格列表逐张取
ONLY_LIST=$(printf '%s' "${ONLY:-}" | tr ',' ' ')
LOG=$RUNTIME_DIR/nightshift.log

# ---------------------------------------------------------------------------
# 执行器分派：superagent 模式不再起本地 headless worker。
# 夜间跑批只把卡变成 Gitea issue（方案 A），superagent 的 Source/Eval/Ticket/Executor
# 负责认领、独立 worktree、PR 与 attention；这里只做低谷闸门 + 派发 + 状态回写。
EXECUTOR=${NIGHTSHIFT_EXECUTOR:-local}
if [ "$EXECUTOR" = "superagent" ]; then
  mkdir -p "$RUNTIME_DIR"
  CFG=${NIGHTSHIFT_SUPERAGENT_CONFIG:-${OFFHOURS_CONFIG:-}}
  BRIDGE="$SELF_DIR/superagent_bridge.py"
  _sa_log() { printf '%s [%s] %s\n' "$(date '+%F %T')" "${NIGHTSHIFT_BOARD##*/}" "$*" >> "$LOG"; }
  if [ -z "$CFG" ] || [ ! -f "$CFG" ]; then
    echo "NIGHTSHIFT_SUPERAGENT_CONFIG 未设置或不存在：${CFG:-<empty>}" >&2
    exit 2
  fi
  [ -f "$BRIDGE" ] || { echo "缺少 $BRIDGE" >&2; exit 2; }
  if [ "$DRY" = 1 ]; then
    python3 "$BRIDGE" dispatch "$BOARD" --config "$CFG" --dry-run
    exit 0
  fi
  DISABLED="${DISABLED:-$RUNTIME_DIR/DISABLED}"
  FORCE_ARG=""
  [ "$FORCE" = 1 ] && FORCE_ARG="--force"
  if [ "$DAEMON" = 1 ]; then
    _sa_log "SUPERAGENT daemon 启动（派发 issue + 回写卡状态）"
    while :; do
      date +%s > "$RUNTIME_DIR/DAEMON.heartbeat" 2>/dev/null || true
      [ -f "$DISABLED" ] && { _sa_log "SUPERAGENT 暂停（DISABLED）"; sleep 30; continue; }
      python3 "$BRIDGE" dispatch "$BOARD" --config "$CFG" --limit 1 $FORCE_ARG >>"$LOG" 2>&1 || _sa_log "dispatch 失败"
      python3 "$BRIDGE" sync "$BOARD" --config "$CFG" >>"$LOG" 2>&1 || _sa_log "sync 失败"
      sleep 10
    done
  fi
  date +%s > "$RUNTIME_DIR/DAEMON.heartbeat" 2>/dev/null || true
  python3 "$BRIDGE" dispatch "$BOARD" --config "$CFG" --limit 1 $FORCE_ARG >>"$LOG" 2>&1 || _sa_log "dispatch 失败"
  python3 "$BRIDGE" sync "$BOARD" --config "$CFG" >>"$LOG" 2>&1 || _sa_log "sync 失败"
  exit 0
fi

# ---------------------------------------------------------------------------
# worker 提示词的「稳定头」：**所有 worker 逐字节完全相同**，因此它是可被
# DeepSeek 磁盘缓存识别并持久化的公共前缀单元（官方文档：命中要求完全匹配一个
# 缓存前缀单元；公共前缀会在被多个请求共享后被识别持久化）。
# 硬约束（改这里之前先想清楚）：
#   1) 本 heredoc 用 <<'EOF'（引号）⇒ 内部**绝不**展开变量，天然逐字节稳定；
#   2) 头里**不得**出现逐卡变化的值（卡片 id、标题、路径、时间戳、看板名）；
#      需要引用它们时，一律写"见文末的『本次任务』"，把变量赶到最末；
#   3) 改这个头 = 让已有缓存全部作废 ⇒ 脚本会打印 PREFIX-HEAD <哈希>，
#      哈希一变日志里立刻看得见（见下面 prefix_head_hash 的用法）。
# ---------------------------------------------------------------------------
PROMPT_HEAD=$(cat <<'EOF'
你是「低谷空闲跑批」的 worker。只做本提示词文末「本次任务」里的那一张看板卡，做完即停；不要做第二张、不要新建卡。

硬规则：
1. 先运行 date 确认时间；若已进入 DeepSeek 官方高峰（北京时间工作日 09:00–12:00 / 14:00–18:00）立即停止，输出 KANBAN-RESULT: failed 并说明。
2. **代码改动一律在文末「工作区」里做**。若工作区是 feature worktree，外层已准备好并 cd 到这里；
   **不要再 feature ensure / attach / new**，也不要写或提交主检出。
   - 外层可能把主检出工作树设为只读；无论是否开启，主检出都不是你该写的地方。
   - 工作区为空、不存在、或不是 git worktree：输出 KANBAN-RESULT: review，EVIDENCE 写 `pwd; git status`，不要自己建。
   - **不要用 DSH 自带的 create_worktree 工具**：外层已准备好 worktree，该工具还会绕过隔离约定。
3. **决策分级，不要一律送审**：
   - L0 可逆、低成本、在范围内（命名、顺序、等价工具、先做哪一步）：**自己做**，在 KANBAN-NOTE 写 `自决：<做了什么>｜理由：<为什么>`；不要送审。
   - L1 缺只有用户才能给的凭据/设备/拍板，或两条以上替代路径都走不通：送审；送审前先试至少 2 条路径，把原始输出写进 KANBAN-EVIDENCE。
   - L2 不可逆、高风险、生产变更、可能删数据/泄密：停手送审，并给回滚方案。
   - 卡里已有 `【确认 …】` 块：照它执行，**不得就同一问题再次送审**；只有确认块没覆盖到的**新**问题才允许再送审，并单独写清新问题。
4. 不做不可逆操作（不删数据、不推送远端、不改判据与阈值、不动生产配置）。
5. **必须自证**：跑过什么验证命令、观察到什么结果，写进 KANBAN-EVIDENCE；没有证据不得报 done。
6. **长任务要留断点**：预计超过 10 分钟或 20 个工具调用时，先在 worktree 里建 `.devloop/worker-progress.md`，每完成一个可验证小步追加一行（做了什么 / 下一步 / 证据）；超时后下一个 worker 或人据此续跑，不要从头重来。
7. 送审时必须附一份**审批单**（人只看它做决定；面板的审批窗口按 `- O<n>：` 行渲染成一键按钮，格式必须严格）：
   【审批单 · explain-plain】
   一句话：<这张卡在等什么，用大白话一句说清>
   卡在哪：F1 环境/闸门 | F2 缺前提 | F3 不可逆/判据面
   前因：<2–3 句：它在做什么、撞到什么、为什么按纪律停下而不是猜>
   选项：
   - O1：<选项内容>｜代价：<这么做要付什么>｜推荐｜动作：done（只有"批准即完成/归档"时才加）
   - O2：<选项内容>｜代价：<...>
   批准后：<你批准后它具体会做什么>
   不批准：<会一直停在这里 / 你的替代路径>
   必须再配一张 **ASCII 图**（用单独一行三个反引号 + text 围栏包住，紧跟在「一句话」之后）：架构/数据流/时序/状态机/决策树任选最合适的一种；宽度 ≤ 100 列、一图一事、图中节点与文字对应——人要在图上看懂"这件事发生在哪一层、卡在哪一步"。
   把这段原文放进 KANBAN-NOTE（可以压成一行，但字段名与 `- O<n>：` 行必须原样保留）。
   **上下文解释是硬要求（用户 2026-10-17 明确）**：审批单里光有选项不够——「前因」必须写到**一个没参与过这件事的人能独立看懂**：
   它属于系统哪一层、上下游是谁、以前发生过什么导致要在这里停、不处理的后果是什么；并配图（架构/时序/状态机任选）。
   判断标准：人读完**不需要再问你**就能选 O1/O2。
8. **别破坏缓存前缀**：这是你这次任务的唯一会话。不要在中途更换模型、增删工具集，也不要触发上下文压缩——那会让服务器端已有的缓存前缀全部作废，同样的活儿要按未命中价重算（贵 50 倍）。

回复的最后四行必须是（外层脚本据此更新看板）：
KANBAN-RESULT: done|review|failed
KANBAN-SUMMARY: <一行：做了什么；或送审/失败的原因>
KANBAN-EVIDENCE: <你实际运行过的验证命令与观察结果；没有验证就写 无>
KANBAN-NOTE: <review 时：①… ②… 的编号问题清单，每条附【建议】与【备选】；否则写「无」>
EOF
)
# 稳定头哈希：用于在日志里"看得见缓存前缀有没有被改坏"
PREFIX_HEAD_HASH=$(printf '%s' "$PROMPT_HEAD" | sha1sum | cut -c1-16)
BOARDKEY=$(basename "$(dirname "$BOARD")")          # 先定义：锁/槽位/状态文件都要它
LOCK=$RUNTIME_DIR/.lock-$BOARDKEY          # 每板一把锁（2026-10-16：允许 ops/hemou 并行）
SLOTS=$RUNTIME_DIR/slots                   # 全局 worker 槽位（跨板并发上限）
MAX_WORKERS=${NIGHTSHIFT_MAX_WORKERS:-3}
RUNS=$RUNTIME_DIR/runs
# 跑批前后要盯住的主检出（git 仓库）；一变就把卡转待审。见 README「事后侦测」一节。
# 两个实例（ops / hemou）必须各自隔离状态：预算、冷却、尝试计数都按看板分开，
# 否则一个板跑掉今天额度会影响另一个板（2026-10-16 修复）。
# 守卫仓库：项目名（查特性登记表 .repos.json）或主检出路径；跑批会按卡覆盖。
# 兼容旧键 GUARD_REPOS：旧 env 文件写的是 GUARD_REPOS，但脚本原来只读 NIGHTSHIFT_GUARD_REPOS，
# 导致配置静默失效（2026-10-18 复盘发现：ops 板 GUARD_REPOS=hemou 实际没生效）。
LEGACY_GUARD=${GUARD_REPOS:-}
GUARD_REPOS=${NIGHTSHIFT_GUARD_REPOS:-${LEGACY_GUARD:-}}
GUARD_REPOS=${GUARD_REPOS//,/ }
SANDBOX=${NIGHTSHIFT_SANDBOX:-auto}
BOARDKEY=$(basename "$(dirname "$BOARD")")
DISABLED=${NIGHTSHIFT_DISABLED:-$RUNTIME_DIR/DISABLED}
STORM_MIN=${STORM_MIN:-15}      # 熔断窗口（分钟）
STORM_MAX=${STORM_MAX:-10}      # 窗口内允许的"活动会话数"上限；超过即自动暂停
MAX_CNY_PER_DAY=${MAX_CNY_PER_DAY:-3.0}   # 今日花费上限（元，低谷价；按 runs/ 里的 usage 估算）
DAY=${NIGHTSHIFT_DAY:-$RUNTIME_DIR/day-$BOARDKEY.json}
export NIGHTSHIFT_STATE=${NIGHTSHIFT_STATE:-$RUNTIME_DIR/state-$BOARDKEY.json}
OUT=$RUNTIME_DIR/last-worker.out
ERR=$RUNTIME_DIR/last-worker.err
OVERLAY=${NIGHTSHIFT_OVERLAY:-}   # 默认为空：peak-block 已是 headless profile 的一部分（hooks 已移除，见 profile 注释）

IDLE_MIN=${IDLE_MIN:-15}
LOAD_MAX=${LOAD_MAX:-2.0}
CPU_MAX=${CPU_MAX:-40}
RUN_TIMEOUT=${RUN_TIMEOUT:-1800}
MAX_CARDS_PER_RUN=${MAX_CARDS_PER_RUN:-3}
MIN_WINDOW_LEFT=${MIN_WINDOW_LEFT:-1200}
COOLDOWN_MIN=${COOLDOWN_MIN:-10}
MAX_CARDS_PER_DAY=${MAX_CARDS_PER_DAY:-8}     # 0 = 不限
MAX_MINUTES_PER_DAY=${MAX_MINUTES_PER_DAY:-120}
# 0 表示"不限"（2026-10-31 修复：env 写 0 曾被当成"上限 0 分钟" ⇒ 永远跑不了）
KEEP_RUNS=${KEEP_RUNS:-200}
LOG_MAX_KB=${LOG_MAX_KB:-1024}
[ -n "$MAX_OVERRIDE" ] && MAX_CARDS_PER_RUN=$MAX_OVERRIDE

export MAX_ATTEMPTS=${MAX_ATTEMPTS:-2}
# 绝不覆盖 HOME/PATH：社区或非 root 用户必须保留自己的环境。
# dsh 可执行体与 feature 命令由调用方显式注入，避免依赖某个固定 PATH。
DSH_BIN=${DSH_BIN:-$(command -v dsh 2>/dev/null || true)}
if [ -z "$DSH_BIN" ]; then echo "DSH_BIN 未设置且 PATH 里找不到 dsh" >&2; exit 2; fi
FEATURE_BIN=${NIGHTSHIFT_FEATURE_BIN:-$(command -v feature 2>/dev/null || true)}
export NIGHTSHIFT_FEATURE_BIN="$FEATURE_BIN"
# 未值守 worker 的权限模式（写 .git/worktrees 需要 danger-full-access；由配置显式决定）。
WORKER_PERMISSION_MODE=${NIGHTSHIFT_WORKER_PERMISSION_MODE:-}
# 会话目录：DSH_HOME 优先，绝不写死 /root。
DSH_HOME=${DSH_HOME:-${HOME:-/tmp}/.dsh}
export DSH_HOME
SESSIONS_DIR=${NIGHTSHIFT_SESSIONS_DIR:-$DSH_HOME/sessions}

mkdir -p "$RUNTIME_DIR" "$RUNS" "$SLOTS"
log() { printf '%s [%s] %s\n' "$(date '+%F %T')" "$BOARDKEY" "$*" >> "$LOG"; }
say() { [ "$DRY" = 1 ] && echo "$@"; }
rotate_log() {
  local kb; kb=$(du -k "$LOG" 2>/dev/null | cut -f1)
  if [ -n "$kb" ] && [ "$kb" -gt "$LOG_MAX_KB" ]; then mv -f "$LOG" "$LOG.1"; fi
  return 0
}

# DAEMON 模式（2026-11-01 用户要求：槽位一空立刻补位，不留空闲）：
# 每轮跑完后立刻开始下一轮；没有可跑卡时等 10 秒再试，直到高峰/暂停。
if [ "$DAEMON" = 1 ]; then
  log "DAEMON 启动（每轮最多 $MAX_CARDS_PER_RUN 张，轮间空档 ≤10s）"
  # BOOT-RESET-ATTEMPTS：机器重启/实例故障后，把 attempts 清零——那是"环境中断"而不是"卡片失败"，
  # 否则连断两次就把好卡推进 review（用户 2026-11-04 明确要求：故障后要能及时治愈回来）。
  # 状态文件按 main 的「运行目录」口径（NIGHTSHIFT_STATE=$RUNTIME_DIR/state-<板>.json）扫描。
  python3 - "$RUNTIME_DIR" <<'PYEOF' 2>/dev/null || true
import json, os, sys, glob
d = sys.argv[1]
for f in glob.glob(os.path.join(d, "state.json")) + glob.glob(os.path.join(d, "state-*.json")):
    try:
        o = json.load(open(f, encoding="utf-8"))
    except Exception:
        continue
    if isinstance(o, dict) and o.get("attempts"):
        o["attempts"] = {}
        json.dump(o, open(f, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print("reset attempts:", f)
PYEOF
  log "已清零 attempts（视为上次中断是环境故障）"
  # HEARTBEAT-LOOP：独立的 10 秒心跳（轮次同步执行时也能证明"调度器活着"）
  # 读写方约定：panel/index.js 的 NS_DIR 与 deploy/selfcheck.sh 都读部署目录下的 DAEMON.heartbeat，
  # 所以写 $SELF_DIR（=扫描器所在目录）；不写 $RUNTIME_DIR，否则面板读不到。
  ( while :; do date +%s > "$SELF_DIR/DAEMON.heartbeat" 2>/dev/null; sleep 10; done ) &
  _HB_PID=$!
  trap 'kill $_HB_PID 2>/dev/null' EXIT
  while :; do
    [ -f "$DISABLED" ] && { log "DAEMON 暂停（DISABLED）"; sleep 30; continue; }
    python3 "$SELF_DIR/ns.py" offpeak >/dev/null 2>&1 || { log "DAEMON 峰段休眠 60s"; sleep 60; continue; }
    # INVARIANT-HEAL：每轮后自愈（僵尸槽/错位槽/孤儿卡），把"状态一致性"变成常态而非人工
    python3 "$SELF_DIR/ns.py" invariants "$BOARD" --heal >/dev/null 2>&1 || true
    # HEARTBEAT：面板在沙箱里无法 systemctl，只能靠心跳文件判断调度器是否活着
    date +%s > "$SELF_DIR/DAEMON.heartbeat" 2>/dev/null || true
    MAX_CARDS_PER_RUN="${NIGHTSHIFT_DAEMON_MAX_PER_ROUND:-3}" "$0" --force >/dev/null 2>&1 || true
    sleep 10
  done
fi

# ---- 一键停（NIGHTSHIFT_DISABLED 可覆盖路径，便于测试）----
if [ -f "$DISABLED" ]; then log "存在 DISABLED，跳过"; say "跳过：nightshift 处于停用状态"; exit 0; fi

# ---- 单实例 ----
exec 9>"$LOCK" || exit 0
# 轮锁（2026-10-28 用户要求"允许多个跑批同时跑"）：
# 旧实现是"每板一把整轮锁" ⇒ 同板第二轮必然跳过（日志：本板另一个跑批仍在运行）。
# 现在改成 MAX_WORKERS 个并发轮锁：谁先抢到谁跑，最多 N 轮并行；真正的互斥靠
#   · 全局 worker 槽位 slots/（上限 N）
#   · 看板写入的指纹锁（ns.py mutate_board，pick+mark 原子）
LOCK_SLOT=""
for _i in $(seq 1 "${MAX_WORKERS:-3}"); do
  exec 9>"$RUNTIME_DIR/.lock-$BOARDKEY-$_i"
  if flock -n 9; then LOCK_SLOT="$_i"; break; fi
done
if [ -z "$LOCK_SLOT" ]; then
  log "本板（$BOARDKEY）已有 ${MAX_WORKERS:-3} 轮跑批在跑（并发上限），跳过"
  say "跳过：本板并发轮已达上限"
  exit 0
fi
log "轮锁：$BOARDKEY #$LOCK_SLOT（并发上限 ${MAX_WORKERS:-3}）"

# ---- 崩溃恢复：上次被强杀留下的 in_progress 卡，不处理就**永远不会**再被捡起 ----
recover_orphan() {
  local cur alive
  cur=$(python3 - "${NIGHTSHIFT_STATE:-$RUNTIME_DIR/state-$BOARDKEY.json}" <<'PYR'
import json, sys
try:
    print(json.load(open(sys.argv[1])).get("currentCardId") or "")
except Exception:
    print("")
PYR
)
  [ -n "$cur" ] || return 0
  alive=$(python3 - "$SLOTS" <<'PYR'
import os, sys
d = sys.argv[1]
n = 0
if os.path.isdir(d):
    for x in os.listdir(d):
        try:
            os.kill(int(open(os.path.join(d, x, "pid")).read().strip()), 0)
            n += 1
        except Exception:
            pass
print(n)
PYR
)
  [ "${alive:-0}" -gt 0 ] && return 0
  local _r
  _r=$(python3 "$SELF_DIR/ns.py" recover "$BOARD" "$cur" 2>&1)
  printf '%s\n' "$_r" >> "$LOG"
  # 只在**真的写成功**时才说"已拉回"（此前无条件打印，曾出现"日志说成功、其实 NameError"的假成功）
  case "$_r" in *"-> ok"*) log "崩溃恢复：$cur 已从 in_progress 拉回（并记一次尝试）" ;; *) log "崩溃恢复：$cur 未能拉回（见上一条 ns.py 输出）" ;; esac
}

# ---- 全局 worker 槽位：最多 MAX_WORKERS 个 worker 同时跑（跨板共享）----
acquire_worker_slot() {
  # 槽位里写自己的 PID：这样"有没有在跑"是**可验证的**（进程死了就是僵尸槽位，必须回收）。
  # 2026-10-16 事故：跑批被 dsh-web 重启连带杀掉，留下空槽位 ⇒ 面板误报"正在跑 worker×2"。
  local i p
  for i in $(seq 1 "$MAX_WORKERS"); do
    if [ -d "$SLOTS/$i" ]; then
      p=$(cat "$SLOTS/$i/pid" 2>/dev/null)
      if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then continue; fi   # 真在跑
      rm -rf -- "$SLOTS/$i"                                          # 僵尸 ⇒ 回收
      log "回收僵尸槽位 $i（PID ${p:-未知} 已不在）"
    fi
    # SLOT-OWNER：槽位记录所属看板，避免对 A 板跑 invariants 时误伤 B 板的槽位
    mkdir -p "$SLOTS/$i" && echo $$ > "$SLOTS/$i/pid" && printf '%s\n' "${BOARDKEY:-ops}" > "$SLOTS/$i/board" 2>/dev/null || true
    echo "$i"; return 0
  done
  return 1
}

# 启动时先清一遍僵尸槽位（上次被强杀留下的）
cleanup_stale_slots() {
  local d p
  for d in "$SLOTS"/*; do
    [ -d "$d" ] || continue
    p=$(cat "$d/pid" 2>/dev/null)
    if [ -z "$p" ] || ! kill -0 "$p" 2>/dev/null; then rm -rf -- "$d"; fi
  done
  return 0
}
release_worker_slot() {
  [ -n "${1:-}" ] || return 0
  rm -f "$SLOTS/$1/card" "$SLOTS/$1/start" "$SLOTS/$1/worker_pid" 2>/dev/null || true
  rmdir "$SLOTS/$1" 2>/dev/null || true
  return 0
}
rotate_log
cleanup_stale_slots 2>/dev/null || true
recover_orphan 2>/dev/null || true
recover_all_orphans 2>/dev/null || true
prune_worker_sessions 2>/dev/null || true

# ---- 熔断：机器上正在疯狂产生会话 ⇒ 拒绝参与并自动暂停（"一定不要再出现拼命开会话烧 token"）----
# 它是机械判据（数会话目录的 mtime），不看模型、不花钱；昨天那次风暴（3 分钟 195 个会话）会被它
# 在第一次 tick 就拦下。触发时写 DISABLED（面板显示"已暂停"）+ 日志 + 回执，等你排查后从面板恢复。
if [ "$FORCE" = 0 ]; then
  if ! STORM_MSG=$(python3 "$SELF_DIR/ns.py" storm-check "$STORM_MIN" "$STORM_MAX"); then
    printf '自动暂停（熔断）%s：%s\n恢复：在「夜间跑批」面板点『恢复』，或删除本文件。\n' \
      "$(date '+%F %T')" "$STORM_MSG" > "$DISABLED"
    log "⚠ 熔断：$STORM_MSG —— 已写 DISABLED 自动暂停（防会话风暴）"
    printf 'KANBAN-RESULT: failed\nKANBAN-SUMMARY: ⚠ 熔断自动暂停：%s\n' "$STORM_MSG" > "$RUNTIME_DIR/last-result-$BOARDKEY.txt"
    python3 "$SELF_DIR/ns.py" receipt "$BOARD" "" "$RUNTIME_DIR/last-result-$BOARDKEY.txt" "熔断" >> "$LOG" 2>&1
    exit 0
  fi
  say "熔断检查：$(python3 "$SELF_DIR/ns.py" storm-check "$STORM_MIN" "$STORM_MAX")"
fi

# ---- 日预算（独立文件，避免与 ns.py 的 state.json 互相覆盖）----
DAYCARDS=0; DAYMIN=0
if [ -f "$DAY" ]; then
  read -r _d DAYCARDS DAYMIN < <(python3 - "$DAY" <<'PY'
import json, sys, datetime
try: d = json.load(open(sys.argv[1]))
except Exception: d = {}
today = datetime.datetime.now().strftime("%Y-%m-%d")
if d.get("dayKey") != today: d = {"dayKey": today, "cards": 0, "minutes": 0}
print(d.get("dayKey"), d.get("cards", 0), d.get("minutes", 0))
PY
)
fi
budget_add() {
  exec 7>"$RUNTIME_DIR/.budget.lock"
  flock -x 7
  python3 - "$DAY" "$1" "$2" <<'PY'
import json, sys, datetime
p, c, m = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
try: d = json.load(open(p))
except Exception: d = {}
today = datetime.datetime.now().strftime("%Y-%m-%d")
if d.get("dayKey") != today: d = {"dayKey": today, "cards": 0, "minutes": 0}
d["cards"] = d.get("cards", 0) + c
d["minutes"] = d.get("minutes", 0) + m
json.dump(d, open(p, "w"), ensure_ascii=False, indent=1)
PY
}
cost_deny_reason() {
  local c
  c=$(python3 "$SELF_DIR/ns.py" day-cost 2>/dev/null | sed -n 's/^COST=\([0-9.]*\).*/\1/p')
  [ -n "$c" ] || return 1
  if awk -v a="$c" -v b="$MAX_CNY_PER_DAY" 'BEGIN{exit !(a>=b)}'; then
    echo "今日花费 ${c} 元 ≥ 上限 ${MAX_CNY_PER_DAY} 元（低谷价估算）"; return 0
  fi
  return 1
}
budget_deny_reason() {
  # 0 = **逐项**不限（用户 2026-10-16 定："一天跑批的上限是 20 元" ⇒ 让金额成为真闸门）。
  # 注意：不能要求"两项同时为 0"才放行——那样只要有一项落地成 0 就会被自己堵死（2026-10-16 22:42 事故）。
  if [ "${MAX_CARDS_PER_DAY:-8}" != "0" ] && [ "$DAYCARDS" -ge "$MAX_CARDS_PER_DAY" ]; then
    echo "今日卡数已达上限 $MAX_CARDS_PER_DAY"; return 0
  fi
  if [ "${MAX_MINUTES_PER_DAY:-120}" != "0" ] && [ "$DAYMIN" -ge "$MAX_MINUTES_PER_DAY" ]; then
    echo "今日分钟预算已达上限 ${MAX_MINUTES_PER_DAY}min"; return 0
  fi
  return 1
}

# ---- 冷却（按看板各自的 state 文件）----
LAST=$(NIGHTSHIFT_STATE="${NIGHTSHIFT_STATE:-$RUNTIME_DIR/state-$BOARDKEY.json}" python3 - <<'PY'
import json, os
try:
    print(json.load(open(os.environ["NIGHTSHIFT_STATE"])).get("lastRunAt", 0))
except Exception:
    print(0)
PY
)
NOW=$(date +%s)
if [ "$FORCE" = 0 ] && [ -n "$LAST" ] && [ "$LAST" -gt 0 ] && [ $((NOW-LAST)) -lt $((COOLDOWN_MIN*60)) ]; then
  log "冷却中（距上次 $(( (NOW-LAST)/60 )) 分钟 < ${COOLDOWN_MIN}）"; say "跳过：冷却中"; exit 0
fi
if [ "$FORCE" = 0 ] && [ "$DRY" = 0 ]; then
  if r=$(budget_deny_reason); then log "预算拒绝：$r"; exit 0; fi
fi

# ---- worker 会话保留上限（可追溯；只清"我们自己那种"，绝不碰用户会话）----
KEEP_WORKER_SESSIONS=${KEEP_WORKER_SESSIONS:-30}
KEEP_WORKER_DAYS=${KEEP_WORKER_DAYS:-14}
prune_worker_sessions() {
  [ "$SKIP_EMPTY_SLOT" = 1 ] && return 0
  local i=0 sdir base first
  for sdir in $(ls -dt $SESSIONS_DIR/$SLOT/session-*/ 2>/dev/null); do
    i=$((i+1)); [ "$i" -le "$KEEP_WORKER_SESSIONS" ] && continue
    sdir=${sdir%/}; base=$(basename "$sdir")
    [ -n "$(find "$sdir" -maxdepth 1 -mtime +$KEEP_WORKER_DAYS -print -quit 2>/dev/null)" ] || continue
    first=$(timeout 15 zstd -dc "$sdir/session.v4.jsonl.zstd" 2>/dev/null | python3 -c "
import sys,json
for line in sys.stdin:
    o=json.loads(line)
    if o.get('type')=='user/message':
        c=o['data'].get('content') or []
        print(' '.join(b.get('text','') for b in c if isinstance(b,dict) and b.get('type')=='text')[:40]); break
" 2>/dev/null)
    case "$first" in
      *低谷空闲跑批*) rm -rf -- "$sdir"; rm -f -- "$DSH_HOME/storages/session_projcache/sessions/$base.json"
        log "清理过期 worker 会话 $base" ;;
    esac
  done
  return 0
}

# ---- worker 会话所在的槽位（用于清理）----
SLOT="--$(printf '%s' "${WORKDIR#/}" | tr '/' '-')--"

# SLOT 为空/不存在时**绝不能**退化成"扫描全机所有会话并解压"（会卡死：2026-10-16 实测 rc=124）
SKIP_EMPTY_SLOT=0
if [ -z "${SLOT:-}" ] || [ ! -d "$SESSIONS_DIR/$SLOT" ]; then SKIP_EMPTY_SLOT=1; fi

collect_worker_session() {   # $1=stamp $2=cardId
  [ "$SKIP_EMPTY_SLOT" = 1 ] && { log "SLOT 不可用（${SLOT:-空}）⇒ 跳过 worker 会话收集"; return 0; }
  local stamp="$1" cid="$2" sdir base first hid
  for sdir in $(ls -dt $SESSIONS_DIR/$SLOT/session-*/ 2>/dev/null | head -5); do
    sdir=${sdir%/}; base=$(basename "$sdir")
    first=$(timeout 15 zstd -dc "$sdir/session.v4.jsonl.zstd" 2>/dev/null | python3 -c "
import sys,json
for line in sys.stdin:
    o=json.loads(line)
    if o.get('type')=='user/message':
        c=o['data'].get('content') or []
        print(' '.join(b.get('text','') for b in c if isinstance(b,dict) and b.get('type')=='text')[:40]); break
" 2>/dev/null)
    case "$first" in
      *低谷空闲跑批*)
        timeout 15 zstd -dc "$sdir/session.v4.jsonl.zstd" > "$RUNS/$stamp-$cid.transcript.jsonl" 2>/dev/null
        hid=$(timeout 15 zstd -dc "$sdir/session.v4.jsonl.zstd" 2>/dev/null | head -1 | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
        if [ "$hid" = "$base" ]; then
          NIGHTSHIFT_WORKER_SESSION="$base"; export NIGHTSHIFT_WORKER_SESSION
          rm -f -- "$DSH_HOME/storages/session_projcache/sessions/$base.json"
          log "保留 worker 会话 $base（转录存 runs/；卡片写入该会话 id，超出上限由 prune_worker_sessions 清理）"
        fi
        return 0 ;;
    esac
  done
  return 0
}

run_one() {   # $1=cardId $2=title $3=desc
  # 参数声明必须在任何使用之前（ISOLATED 段也用 $cid；曾因声明在后 ⇒ set -u 崩 ⇒ ISOLATED 从未跑通）
  local cid="$1" title="$2" desc="$3"
  local RESFILE="$RUNTIME_DIR/last-result-$BOARDKEY-$1.txt"   # 每卡自己的结果文件（P6 并行安全：原来 6 处共用一份）
  STATE_F="${NIGHTSHIFT_STATE:-$RUNTIME_DIR/state-$BOARDKEY.json}"
  STATE_LOCK="$RUNTIME_DIR/.state.lock"   # P6：串行化 state 与 apply 的读改写

  # 开跑前先把「当前正在跑的卡 + 开始时间」写进 state。
  # 为什么：state.lastCardId/lastRunAt 只在**跑完**才更新 ⇒ 面板会显示上一张卡和错误的"已跑 N 分钟"。
  local card_id="$1"   # run_one($1=卡 id)；这里**不能**用 $cid（那是外层循环的变量），否则 set -u 直接崩
  flock -x "$STATE_LOCK" python3 - "$STATE_F" "$card_id" <<'PYST'
import json, sys, time
p, cid = sys.argv[1], sys.argv[2]
try:
    d = json.load(open(p))
except Exception:
    d = {}
d["currentCardId"] = cid
d["currentSince"] = int(time.time())
json.dump(d, open(p, "w"), ensure_ascii=False, indent=1)
PYST
  # --- 独占 worktree（仅 ISOLATED=1 时）：代码必须落到"衍生这张卡的会话"的 worktree 里 ---
  local CARD_GUARD_REPOS="" WORKER_SLUG="" SOURCE_PROJECT="" GUARD_WARN=""
  local -a SANDBOX_ARGS=()
  local SANDBOX_ACTIVE=0
  if [ "$ISOLATED" = 1 ]; then
    PREP=$(python3 "$SELF_DIR/ns.py" prep-worktree "$BOARD" "$cid" --go 2>&1)
    W=$(printf '%s\n' "$PREP" | sed -n 's/^WORKDIR=//p' | tail -1)
    WORKER_SLUG=$(printf '%s\n' "$PREP" | sed -n 's/^WORKER_SLUG=//p' | tail -1)
    SOURCE_PROJECT=$(printf '%s\n' "$PREP" | sed -n 's/^SOURCE_PROJECT=//p' | tail -1)
    CARD_GUARD_REPOS=$(printf '%s\n' "$PREP" | sed -n 's/^GUARD_REPOS=//p' | tail -1)
    if [ -z "$W" ] || [ ! -d "$W" ] || [ -L "$W" ]; then
      SKIP=$(printf '%s\n' "$PREP" | sed -n 's/^SKIP //p' | tail -1)
      printf 'KANBAN-RESULT: review\nKANBAN-SYSTEM: system\nKANBAN-SUMMARY: E_WORKTREE_PREP 无法确定代码去向：%s\nKANBAN-EVIDENCE: prep-worktree 输出：%s\nKANBAN-NOTE: 先修源会话的 feature 关联（feature attach/ensure），或开 NIGHTSHIFT_AUTO_FEATURE=1 + NIGHTSHIFT_AUTO_PROJECT。\n' "$SKIP" "$SKIP" > "$RESFILE"
      flock -x "$STATE_LOCK" python3 "$SELF_DIR/ns.py" apply "$BOARD" "$cid" "$RESFILE" >> "$LOG" 2>&1
      log "独占 worktree 不可用：$SKIP（已按待审停下）"
      return 0
    fi
    WORKDIR="$W"; export NIGHTSHIFT_WORKDIR="$W"
    CARD_GUARD_REPOS=${CARD_GUARD_REPOS:-$GUARD_REPOS}
    CARD_GUARD_REPOS=${CARD_GUARD_REPOS//,/ }
    if [ -n "$WORKER_SLUG" ]; then
      if ! python3 "$SELF_DIR/ns.py" card-update "$BOARD" "$cid" --worker-slug "$WORKER_SLUG" >> "$LOG" 2>&1; then
        printf 'KANBAN-RESULT: review\nKANBAN-SYSTEM: system\nKANBAN-SUMMARY: E_CARD_WRITE 无法把 workerSlug=%s 写回卡片\nKANBAN-EVIDENCE: card-update 失败（看板冲突/形状被拒）\nKANBAN-NOTE: 重跑即可；若持续冲突，检查看板是否被别的会话占用。\n' "$WORKER_SLUG" > "$RESFILE"
        flock -x "$STATE_LOCK" python3 "$SELF_DIR/ns.py" apply "$BOARD" "$cid" "$RESFILE" >> "$LOG" 2>&1
        log "workerSlug 写回失败：$WORKER_SLUG"
        return 0
      fi
    fi
    log "独占 worktree：$W（project=${SOURCE_PROJECT:-?}，slug=${WORKER_SLUG:-?}，guard=${CARD_GUARD_REPOS:-?}）"
  else
    CARD_GUARD_REPOS="$GUARD_REPOS"
  fi
  local wleft tmo rc start_ts mins stamp prompt card_timeout base_timeout
  wleft=$(python3 "$SELF_DIR/ns.py" window-left)
  # 卡级超时优先；没有/非法则回落 RUN_TIMEOUT。窗口仍然封顶（绝不跨进高峰）。
  card_timeout=$(python3 "$SELF_DIR/ns.py" card-timeout "$BOARD" "$cid" 2>/dev/null || true)
  base_timeout=${card_timeout:-$RUN_TIMEOUT}
  case "$base_timeout" in *[!0-9]*|"") base_timeout=1800 ;; esac
  if [ "$FORCE" = 0 ]; then
    if [ "$wleft" -lt "$MIN_WINDOW_LEFT" ]; then
      log "剩余窗口仅 ${wleft}s < ${MIN_WINDOW_LEFT}s，不开跑"; say "跳过：剩余窗口不足"; return 10
    fi
    tmo=$(( wleft - 60 )); [ "$tmo" -gt "$base_timeout" ] && tmo=$base_timeout
  else
    tmo=$base_timeout
  fi
  if [ "$tmo" -lt 300 ]; then
    printf 'KANBAN-RESULT: review\nKANBAN-SYSTEM: system\nKANBAN-SUMMARY: E_WINDOW_TOO_SMALL 剩余窗口只有 %ss，不足 300s 安全线\nKANBAN-EVIDENCE: window-left=%s；base_timeout=%s；MIN_WINDOW_LEFT=%s\nKANBAN-NOTE: 等下一个低谷窗口再跑，或把卡拆小。\n' "$tmo" "$wleft" "$base_timeout" "$MIN_WINDOW_LEFT" > "$RESFILE"
    flock -x "$STATE_LOCK" python3 "$SELF_DIR/ns.py" apply "$BOARD" "$cid" "$RESFILE" >> "$LOG" 2>&1
    log "窗口不足：${tmo}s < 300s，转待审"
    return 0
  fi
  # 变量尾：**只有这里逐卡变化**。上面的 PROMPT_HEAD 是全体 worker 的共享前缀，
  # 变量放最后 ⇒ 前缀不会在开头就分叉 ⇒ 头那段可被 DeepSeek 缓存识别并命中。
  prompt=$(cat <<EOF
$PROMPT_HEAD

=== 本次任务（以下为逐卡变量；上面的硬规则对本次任务同样适用）===

### DEVLOOP-CLOSE（2026-11-04）：与 dev-loop 闭环
- 若工程存在 `scripts/devloop-round.sh`：**必须**按 dev-loop 一轮执行
  `status` → `begin --round=<n>` → 干活 → `gate --all` → `finish`；
- **判据以 gate 退出码/gate 报告为准**，不许用"看起来对"代替；
- gate 红：只修本次改动引入的问题；与本次无关的历史红，写进卡证据并继续可做的部分；
- 收尾把三行结论写进 `docs/devloop/ledger.md`（工程有该文件时）。
卡片 id：$cid
源自会话：${SOURCE_SESSION:-未记录}（DSH 无 fork CLI，血缘记在卡上）
工作区：$WORKDIR （看板文件 $BOARD 由外层脚本维护：**你不要读改看板、也不要调用 board 相关工具——本 profile 没有它们**）
卡标题：$title
卡内容：
$desc
=== 本次任务结束 ===
EOF
)
  # ---- 稳定头哈希 + 重复 run 机械防护（2026-10-17，缓存最大化主线）----
  # 稳定头哈希：一旦变化，说明 worker 提示词的共享前缀被改坏、已有缓存作废 ⇒ 必须在日志里看得见。
  log "PREFIX-HEAD $PREFIX_HEAD_HASH（worker 提示词稳定头哈希）"
  # 重复防护：今天实测 52 次跑批里 49 次是同一张卡的逐字节重复（card-9921660a×28、card-63079402×23）。
  # 指纹 = 卡 id + 提示词全文 + 期望状态；TTL 内重复 ⇒ 不启动 worker、不花 token、卡状态不动。
  local fp
  # 指纹只对"人可编辑的核心"取哈希（不能用提示词全文：apply 会追加【处理会话】等块 ⇒ 每次都变）
  fp=$(python3 "$SELF_DIR/ns.py" fp "$BOARD" "$cid" "$PREFIX_HEAD_HASH" 2>/dev/null)
  if [ -z "$fp" ]; then
    log "WARN 指纹计算失败（fp 为空）⇒ 本次不做重复防护（绝不能用空指纹当键，否则会误拦所有卡）"
  elif [ "${FORCE:-0}" = 0 ] && python3 "$SELF_DIR/ns.py" dup-check "$fp" >/dev/null 2>&1; then
    log "DUPLICATE-SKIP $fp（card=$cid）：指纹相同的 worker 已在 TTL 内跑过，跳过不烧 token"
    return 12
  fi
  # 原子认领（2026-11-04）：原来这里只是 mark，而 pick 是只读的 ⇒ 两轮并行可能挑中同一张卡
  # （实测 card-ade3b643 同时占 slot 1/5）。现在由 claim 做「todo→in_progress」的单次状态迁移，
  # 抢输的那一轮在起 worker 之前退出，不烧 token。
  if [ "${NIGHTSHIFT_CLAIMED:-0}" = "1" ]; then
    : # 外层（并行路径）已原子认领
  elif ! python3 "$SELF_DIR/ns.py" claim "$BOARD" "$cid" >/dev/null; then
    log "CLAIM-LOST $cid：已被另一轮认领（或已不在 todo），本轮不启动 worker"
    return 13
  fi
      # CARD-FILE-GUARANTEE：槽位必须记录自己跑的是哪张卡（巡检器靠它对账）
      # 单 worker 路径只设了 WSLOT；CARD-FILE-GUARANTEE 块却引用 WSLOT_PAR
      # → set -u 直接中止（卡停在 in_progress、summary 丢失）。这里补默认值。
      WSLOT_PAR=${WSLOT_PAR:-${WSLOT:-slot-$$}}
      mkdir -p "$SLOTS/$WSLOT_PAR" 2>/dev/null || true
      printf '%s\n' "$cid" > "$SLOTS/$WSLOT_PAR/card" 2>/dev/null || true
      date +%s > "$SLOTS/$WSLOT_PAR/start" 2>/dev/null || true
  log "开跑：$title（card=$cid，timeout=${tmo}s，base=${base_timeout}s，剩余窗口=${wleft}s）"
  local gbefore="" gafter="" guard_err="" diff_json="" head_changed="" paths_changed=""
  if [ -z "$CARD_GUARD_REPOS" ]; then
    log "守卫仓库未配置（跳过主检出侦测；卡级 guard 由 prep-worktree 提供，或显式设置 NIGHTSHIFT_GUARD_REPOS）"
  else
  # 守卫必须先解析成功；配置写错时绝不能“静默无守卫”地跑。
  if ! gbefore=$(python3 "$SELF_DIR/ns.py" repo-state --strict $CARD_GUARD_REPOS 2>"$RUNS/guard-before.err"); then
    guard_err=$(tr '\n' ' ' < "$RUNS/guard-before.err" 2>/dev/null | cut -c1-500)
    printf 'KANBAN-RESULT: review\nKANBAN-SYSTEM: system\nKANBAN-SUMMARY: E_GUARD_UNRESOLVED 守卫仓库无法解析：%s\nKANBAN-EVIDENCE: %s\nKANBAN-NOTE: 检查 NIGHTSHIFT_GUARD_REPOS（项目名用 feature repo list 查）/ NIGHTSHIFT_AUTO_PROJECT。\n' "$CARD_GUARD_REPOS" "$guard_err" > "$RESFILE"
    flock -x "$STATE_LOCK" python3 "$SELF_DIR/ns.py" apply "$BOARD" "$cid" "$RESFILE" >> "$LOG" 2>&1
    log "守卫仓库无法解析：$CARD_GUARD_REPOS（已转待审）"
    return 0
  fi
  if [ -z "$gbefore" ] || [ "$gbefore" = "{}" ]; then
    printf 'KANBAN-RESULT: review\nKANBAN-SYSTEM: system\nKANBAN-SUMMARY: E_GUARD_EMPTY 守卫仓库为空（%s）\nKANBAN-EVIDENCE: repo-state 输出空 JSON\nKANBAN-NOTE: 守卫仓库必须是已登记项目或主检出路径。\n' "$CARD_GUARD_REPOS" > "$RESFILE"
    flock -x "$STATE_LOCK" python3 "$SELF_DIR/ns.py" apply "$BOARD" "$cid" "$RESFILE" >> "$LOG" 2>&1
    log "守卫仓库为空：$CARD_GUARD_REPOS（已转待审）"
    return 0
  fi
  log "守卫仓库：$CARD_GUARD_REPOS（沙箱 mode=$SANDBOX）"
  fi

  # 预防式沙箱：把主检出的工作树 bind 成只读，但保留 .git 可写（worktree 提交要写共享 git 元数据）。
  # 这样 worker 即使 headless 无 feature-guard，也写不进主检出；事后指纹只作为第二道防线。
  if [ -n "$CARD_GUARD_REPOS" ] && [ "$SANDBOX" != "off" ]; then
    if command -v bwrap >/dev/null 2>&1; then
      local -a _sa=(bwrap --die-with-parent --dev-bind / /)
      local _ok=1 _repo _path _gitdir
      for _repo in $CARD_GUARD_REPOS; do
        if ! _path=$(python3 "$SELF_DIR/ns.py" repo-path "$_repo" 2>/dev/null); then _ok=0; break; fi
        [ -n "$_path" ] || { _ok=0; break; }
        _gitdir=$(git -C "$_path" rev-parse --git-dir 2>/dev/null || true)
        case "$_gitdir" in
          /*) ;;
          "") _ok=0; break ;;
          *) _gitdir="$_path/$_gitdir" ;;
        esac
        [ -e "$_gitdir" ] || { _ok=0; break; }
        _sa+=(--ro-bind "$_path" "$_path" --bind "$_gitdir" "$_gitdir")
      done
      if [ "$_ok" = 1 ] && "${_sa[@]}" true >/dev/null 2>&1; then
        SANDBOX_ARGS=("${_sa[@]}")
        SANDBOX_ACTIVE=1
        log "沙箱：主检出工作树只读（bwrap），git 元数据可写"
      else
        SANDBOX_ARGS=(); SANDBOX_ACTIVE=0
        log "WARN 沙箱不可用（bwrap 探测失败）"
      fi
    else
      SANDBOX_ARGS=(); SANDBOX_ACTIVE=0
      log "WARN 沙箱不可用（未安装 bwrap）"
    fi
    if [ "$SANDBOX" = "on" ] && [ "$SANDBOX_ACTIVE" != 1 ]; then
      printf 'KANBAN-RESULT: review\nKANBAN-SYSTEM: system\nKANBAN-SUMMARY: E_SANDBOX_UNAVAILABLE NIGHTSHIFT_SANDBOX=on 但 bwrap 不可用\nKANBAN-EVIDENCE: command -v bwrap 或探测失败\nKANBAN-NOTE: 安装 bubblewrap，或把 NIGHTSHIFT_SANDBOX 改成 auto/off。\n' > "$RESFILE"
      flock -x "$STATE_LOCK" python3 "$SELF_DIR/ns.py" apply "$BOARD" "$cid" "$RESFILE" >> "$LOG" 2>&1
      log "沙箱强制开启但不可用（已转待审）"
      return 0
    fi
  else
    log "沙箱跳过（无守卫仓库或 NIGHTSHIFT_SANDBOX=off）"
  fi
  start_ts=$(date +%s); stamp=$(date '+%Y%m%d-%H%M%S')
  # WORKDIR 必须可用：未传 NIGHTSHIFT_WORKDIR 时回落到看板所在目录（原来为空 ⇒ cd 失败 ⇒ 静默 return 11，
  # 卡片卡在 in_progress、槽位泄漏——2026-10-16 冒烟测试抓到的真缺陷）
  WORKDIR=${WORKDIR:-${NIGHTSHIFT_WORKDIR:-$(dirname "$BOARD")}}
  [ -d "$WORKDIR" ] || WORKDIR=$HOME
  if ! cd "$WORKDIR"; then
    log "工作目录不可用：$WORKDIR（结算为 failed，不静默退出）"
    printf 'KANBAN-RESULT: failed\nKANBAN-SUMMARY: 工作目录不可用：%s\nKANBAN-EVIDENCE: cd 失败\nKANBAN-NOTE: 无\n' "$WORKDIR" > "$RUNS/$stamp-$cid.out"
    flock -x "$STATE_LOCK" python3 "$SELF_DIR/ns.py" apply "$BOARD" "$cid" "$RUNS/$stamp-$cid.out" >> "$LOG" 2>&1
    return 11
  fi
  local -a WORKER_CMD=(timeout "$tmo")
  if [ "$SANDBOX_ACTIVE" = 1 ]; then WORKER_CMD+=("${SANDBOX_ARGS[@]}"); fi
  if [ -n "$WORKER_PERMISSION_MODE" ]; then
    WORKER_CMD+=("env" "DSH_PERMISSION_MODE=$WORKER_PERMISSION_MODE")
  fi
  WORKER_CMD+=("$DSH_BIN" --profile headless --json)
  [ -f "$OVERLAY" ] && WORKER_CMD+=(--patch "$OVERLAY")
  WORKER_CMD+=("$prompt")
  "${WORKER_CMD[@]}" 9>&- > "$OUT" 2> "$ERR"
  rc=$?
  mins=$(( ($(date +%s) - start_ts + 59) / 60 ))
  cp -f "$OUT" "$RUNS/$stamp-$cid.out" 2>/dev/null
  cp -f "$ERR" "$RUNS/$stamp-$cid.err" 2>/dev/null
  collect_worker_session "$stamp" "$cid"
  [ "$rc" = 124 ] && log "worker 超时（${tmo}s）"
  RES="$OUT"
  if grep -q "梁文峰时间拦截" "$OUT" "$ERR" 2>/dev/null; then
    printf 'KANBAN-RESULT: failed\nKANBAN-SUMMARY: 被 dsh-peak-block 拦截（高峰期），本轮未向模型发出请求\n' > "$RESFILE"
    RES="$RESFILE"
    log "检测到 peak-block 拦截：worker 的请求被挡下"
  elif [ "$rc" = 124 ]; then
    local _wt_status _wt_diff
    _wt_status=$(git -C "$WORKDIR" status --porcelain 2>/dev/null | tr '\n' ';' | cut -c1-600)
    _wt_diff=$(git -C "$WORKDIR" diff --stat 2>/dev/null | tr '\n' ';' | cut -c1-600)
    printf 'KANBAN-RESULT: review\nKANBAN-SYSTEM: system\nKANBAN-SUMMARY: E_TIMEOUT worker 超时（%ss）被终止；建议把卡级 runTimeoutSec 调到 1800-3600，或拆卡\nKANBAN-EVIDENCE: worktree=%s；git-status=%s；git-diff-stat=%s\nKANBAN-NOTE: 超时不等于失败；工作区可能留有未提交改动，加长超时/拆卡后重跑即可。\n' "$tmo" "$WORKDIR" "$_wt_status" "$_wt_diff" > "$RESFILE"
    RES="$RESFILE"
    log "worker 超时：已写 worktree 状态与建议（review，不再计 failed）"
  fi
  # 第二道防线：主检出指纹分级。HEAD 变化=严重（可能有人提交到主检出）；dirty 变化在沙箱开启时判为外部会话。
  if [ -n "$gbefore" ]; then
    if ! gafter=$(python3 "$SELF_DIR/ns.py" repo-state --strict $CARD_GUARD_REPOS 2>"$RUNS/guard-after.err"); then
      printf 'KANBAN-RESULT: review\nKANBAN-SYSTEM: system\nKANBAN-SUMMARY: E_GUARD_LOST 跑批后守卫仓库无法解析（%s）\nKANBAN-EVIDENCE: repo-state --strict 失败\nKANBAN-NOTE: 检查项目是否被移除/重命名；不要把守卫静默关掉。\n' "$CARD_GUARD_REPOS" > "$RESFILE"
      RES="$RESFILE"
      log "守卫仓库跑批后无法解析：$CARD_GUARD_REPOS"
    elif [ -z "$gafter" ] || [ "$gafter" = "{}" ]; then
      printf 'KANBAN-RESULT: review\nKANBAN-SYSTEM: system\nKANBAN-SUMMARY: E_GUARD_EMPTY 跑批后守卫仓库为空（%s）\nKANBAN-EVIDENCE: repo-state 输出空 JSON\nKANBAN-NOTE: 守卫必须始终可解析。\n' "$CARD_GUARD_REPOS" > "$RESFILE"
      RES="$RESFILE"
      log "守卫仓库跑批后为空：$CARD_GUARD_REPOS"
    else
      diff_json=$(python3 "$SELF_DIR/ns.py" repo-diff "$gbefore" "$gafter" 2>/dev/null || true)
      if [ -z "$diff_json" ]; then
        printf 'KANBAN-RESULT: review\nKANBAN-SYSTEM: system\nKANBAN-SUMMARY: E_GUARD_DIFF 守卫状态变化但无法计算差异\nKANBAN-EVIDENCE: repo-diff 失败\nKANBAN-NOTE: 检查 repo-state 输出是否完整。\n' > "$RESFILE"
        RES="$RESFILE"
      else
        head_changed=$(printf '%s' "$diff_json" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(", ".join(d.get("head_changed") or []))' 2>/dev/null || true)
        paths_changed=$(printf '%s' "$diff_json" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("yes" if (d.get("paths_added") or d.get("paths_removed")) else "")' 2>/dev/null || true)
        if [ -n "$head_changed" ]; then
          # F2（2026-10-31）：HEAD 变化不一定是 worker 干的。autosave 钩子会自己往主检出提交
          # （提交信息形如 "autosave: …" / "chore(board)…"），那是别的会话的正常行为 ⇒
          # 只有**出现非自动提交**才判 E_MAIN_HEAD；否则只记一条外部写入告警，不改卡片状态。
          _subj=$(printf '%s' "$gbefore" > /tmp/ns-gb.json; printf '%s' "$gafter" > /tmp/ns-ga.json; python3 - "$CARD_GUARD_REPOS" <<'PYEOF' 2>/dev/null || true
import json, subprocess, sys
try:
    before = json.load(open('/tmp/ns-gb.json')); after = json.load(open('/tmp/ns-ga.json'))
except Exception:
    sys.exit(0)
repos = sys.argv[1].split() if len(sys.argv) > 1 else []
out = []
for r in repos:
    b = ((before.get(r) or {}).get('head') or '')
    a = ((after.get(r) or {}).get('head') or '')
    if not b or not a or b == a:
        continue
    p = subprocess.run(["git", "-C", r, "log", "--format=%s", "%s..%s" % (b, a)], capture_output=True, text=True)
    out += [x for x in (p.stdout or '').splitlines() if x.strip()]
print('\n'.join(out))
PYEOF
)
          _manual=$(printf '%s\n' "$_subj" | grep -vE '^(autosave:|chore\((board|deploy|devloop)\))' | grep -v '^$' | head -3 | tr '\n' ' ')
          if [ -n "$_subj" ] && [ -z "$_manual" ]; then
            GUARD_WARN="【守卫·外部写入】主检出 HEAD 变化但全是 autosave/收口类提交（${_subj//$'\n'/','}），判为别的会话写入，未改变本卡状态"
            log "守卫：HEAD 变化仅自动提交（$(printf '%s' "$_subj" | tr '\n' ',')）⇒ 不判 E_MAIN_HEAD"
            head_changed=""
          fi
        fi
        if [ -n "$head_changed" ]; then
          printf 'KANBAN-RESULT: review\nKANBAN-SYSTEM: system\nKANBAN-SUMMARY: E_MAIN_HEAD 主检出 HEAD 在跑批期间变化（疑似 worker 提交到主检出）\nKANBAN-EVIDENCE: %s\nKANBAN-NOTE: 检查这些提交是不是 worker 做的；若是，回滚并修 worker 提示/沙箱。\n' "$head_changed" > "$RESFILE"
          RES="$RESFILE"
          log "⚠ 主检出 HEAD 变化：$head_changed"
        elif [ -n "$paths_changed" ]; then
          if [ "$SANDBOX_ACTIVE" = 1 ]; then
            GUARD_WARN="【守卫·外部写入】主检出 dirty 变化，但沙箱已把工作树设为只读，判为别的会话写入，未改变本卡状态。详情：$diff_json"
            log "守卫：dirty 变化但沙箱开启，记为外部写入（不改状态）"
          else
            printf 'KANBAN-RESULT: review\nKANBAN-SYSTEM: system\nKANBAN-SUMMARY: E_MAIN_DIRTY 主检出工作区在跑批期间变化（沙箱关闭，无法归因）\nKANBAN-EVIDENCE: %s\nKANBAN-NOTE: 确认是 worker 还是别的会话写的；建议开启 NIGHTSHIFT_SANDBOX=auto。\n' "$paths_changed" > "$RESFILE"
            RES="$RESFILE"
            log "⚠ 主检出 dirty 变化（沙箱关闭）：$paths_changed"
          fi
        fi
      fi
    fi
  fi
  flock -x "$STATE_LOCK" python3 "$SELF_DIR/ns.py" apply "$BOARD" "$cid" "$RES" >> "$LOG" 2>&1
  if [ -n "$GUARD_WARN" ]; then
    if ! python3 "$SELF_DIR/ns.py" card-update "$BOARD" "$cid" --append-description "$GUARD_WARN" >> "$LOG" 2>&1; then
      log "WARN 守卫外部写入提示未能写回卡片"
    fi
  fi
  # 记录重复指纹：只在 worker 正常结束（done/review）时写；失败/超时不写 ⇒ 保证可重试。
  local _st
  # 注意：不能 grep NDJSON —— 结果文本被转义在 JSON 字符串里（换行是字面 \n），曾因此**从未记录成功**。
  # 改为直接问看板（apply 已经写完了状态）。
  _st=$(python3 "$SELF_DIR/ns.py" card-status "$BOARD" "$cid" 2>/dev/null)
  case "$_st" in
    done|review) [ -n "$fp" ] && python3 "$SELF_DIR/ns.py" dup-record "$fp" "$cid" "$_st" >> "$LOG" 2>&1 ;;
  esac
  if [ "$ISOLATED" = 1 ]; then
    python3 "$SELF_DIR/ns.py" merge-back "$BOARD" "$cid" auto --go >> "$LOG" 2>&1
  fi
  python3 "$SELF_DIR/ns.py" receipt "$BOARD" "$cid" "$RES" "rc=$rc" >> "$LOG" 2>&1
  budget_add 1 "$mins"
  DAYCARDS=$((DAYCARDS+1)); DAYMIN=$((DAYMIN+mins))
  flock -x "$STATE_LOCK" python3 - "$STATE_F" "$(date +%s)" "$cid" <<'PY'
import json, sys
p, now, cid = sys.argv[1], int(sys.argv[2]), sys.argv[3]
try: d = json.load(open(p))
except Exception: d = {}
d["lastRunAt"] = now; d["lastCardId"] = cid; d.pop("currentCardId", None); d.pop("currentSince", None)
json.dump(d, open(p, "w"), ensure_ascii=False, indent=1)
PY
  ls -1t "$RUNS" 2>/dev/null | tail -n +$((KEEP_RUNS+1)) | while read -r f; do rm -f -- "$RUNS/$f"; done
  return 0
}

# 注意（2026-10-16 事故）：改完需要重启 dsh-web 的改动，**不要**用 systemd-run --on-active=N 定时重启 ——
# 那个时刻可能正有会话回合在跑，重启会把它当场打断。请改用 restart-web-when-idle.sh（空闲才重启）。
# ---- P6 护栏：同板并行必须每卡独占 worktree（否则两张卡在同一主检出上互相踩）----
PARALLEL_GUARD=1
case "$PARALLEL" in ''|*[!0-9]*) log "并行度非法（$PARALLEL），回落 1"; PARALLEL=1 ;; esac
if [ "$PARALLEL" -gt 1 ] && [ "$ISOLATED" != "1" ]; then
  log "并行度 $PARALLEL 被拒：同板并行要求 NIGHTSHIFT_ISOLATED_WORKTREE=1（多卡同主检出会互相覆盖）"
  PARALLEL=1
fi
[ "$PARALLEL" -gt 1 ] && log "并行度 $PARALLEL（每卡独占 worktree；每卡独立结果文件 + state/budget/注册表加锁）"

# ---- 广义孤儿回收：in_progress 的卡若没有任何活着的 worker 在做，就拉回待办 ----
# 为什么需要：单卡崩溃/被强杀会留下 in_progress；这类卡既不在 todo（不会被捡起）又没人在做 ⇒ 永久卡住。
# 判据是"进程命令行里有没有这张卡的 id"（worker 的提示词里必然带"卡片 id：card-xxx"），比状态更可靠。
recover_all_orphans() {
  local cid n=0
  for cid in $(python3 "$SELF_DIR/ns.py" orphan-list "$BOARD" 2>/dev/null); do
    n=$((n+1)); [ "$n" -gt 20 ] && break
    local _o
    _o=$(python3 "$SELF_DIR/ns.py" recover "$BOARD" "$cid" 2>&1)
    printf '%s\n' "$_o" >> "$LOG"
    case "$_o" in *"-> ok"*) log "孤儿回收：$cid 无活 worker ⇒ 已拉回待办/review" ;; *) log "孤儿回收：$cid 未拉回（见 ns.py 输出）" ;; esac
  done
  return 0
}

# ---- 主流程：一次扫描内最多做 MAX_CARDS_PER_RUN 张 ----

# ---- P6 并行批处理（仅 PARALLEL>1 时进入；顺序路径完全不变）----
if [ "$PARALLEL" -gt 1 ] && [ "$DRY" != 1 ]; then
  parallel_batch() {
    local launched=0 pids="" cid title desc r wave=0
    # 波次循环：每波并发 PARALLEL 张，跑满 MAX_CARDS_PER_RUN 为止
    # 2026-11-01：槽位一空就补位（条件加 pids 非空）
    pids=""; wave_n=0        # 只在进入循环前初始化一次；循环内不得重置，否则会丢掉仍在跑的 pid
    # 2026-11-10：同源会话串行保护。同一 sourceSessionId 的多张卡并行时 merge-back 会撞
    # 同一个源 worktree（实测 .devloop/posture 冲突、结果行串味），本轮只放一个 worker。
    ACTIVE_SESSIONS=""
    while [ "$launched" -lt "$MAX_CARDS_PER_RUN" ] || [ -n "$pids" ]; do
    wave=$((wave+1))
    while [ "$wave_n" -lt "$PARALLEL" ] && [ "$launched" -lt "$MAX_CARDS_PER_RUN" ]; do
      if [ "$FORCE" = 0 ]; then
        python3 "$SELF_DIR/ns.py" offpeak >/dev/null || break
        if r=$(budget_deny_reason); then log "预算拒绝：$r"; break; fi
        if r=$(cost_deny_reason); then log "花费拒绝：$r"; break; fi
      fi
      PICK=$(NIGHTSHIFT_ACTIVE_SESSIONS="$ACTIVE_SESSIONS" python3 "$SELF_DIR/ns.py" pick "$BOARD")
      cid=$(printf '%s' "$PICK" | python3 -c "import sys,json;print((json.load(sys.stdin).get('picked') or {}).get('id',''))")
      [ -n "$cid" ] || break
      title=$(printf '%s' "$PICK" | python3 -c "import sys,json;print((json.load(sys.stdin).get('picked') or {}).get('title',''))")
      desc=$(printf '%s' "$PICK" | python3 -c "import sys,json;print((json.load(sys.stdin).get('picked') or {}).get('description',''))")
      # **先取到全局 worker 槽位**，再 mark in_progress 并起子进程。
      # 以前先 mark 后取槽 ⇒ 槽满时子进程 exit 3，卡被永久留在 in_progress（2026-10-17 五并发密闭测试实测到）。
      WSLOT_PAR=$(acquire_worker_slot) || { log "并发槽已满（MAX_WORKERS=$MAX_WORKERS），本轮并行到此为止"; break; }
      printf '%s\n' "${CID:-}" > "$SLOTS/$WSLOT_PAR/card" 2>/dev/null || true
      printf '%s\t%s\t%s\n' "${CID:-}" "${TITLE:-}" "$(date '+%F %T')" >> "$RUNTIME_DIR/worker-index.tsv" 2>/dev/null || true
  rename_worker_session() { # <out文件> <卡标题>  —— best-effort，绝不失败
    local out=$1 title=$2 sid tok
    [ -f "$out" ] || return 0
    sid=$(grep -oE '"sessionId"[[:space:]]*:[[:space:]]*"session-[0-9a-f-]+"' "$out" 2>/dev/null | head -1 | sed 's/.*"session-\([0-9a-f-]*\)"/session-\1/')
    [ -n "$sid" ] || return 0
    tok=$(journalctl -u dsh-web --since "-6h" --no-pager 2>/dev/null | grep -oE 'token=[A-Za-z0-9_-]+' | tail -1 | cut -d= -f2)
    curl -s -m 5 -X POST "http://127.0.0.1:3080/nightshift/api/action${tok:+?token=$tok}" \
      -H 'content-type: application/json' -H 'x-nightshift: 1' \
      -d "{\"action\":\"rename-session\",\"sessionId\":\"$sid\",\"title\":\"跑批·${title:0:60}\"}" >/dev/null 2>&1 || true
  }
  rename_worker_session "${OUT:-}" "${TITLE:-}" || true
      date +%s > "$SLOTS/$WSLOT_PAR/start" 2>/dev/null || true
      # 原子认领（2026-11-04）：原来这里是**无条件 mark**，而 pick 是只读的 ⇒ 两轮并行会挑中
      # 同一张卡（实测 card-ade3b643 同时占 slot 1/5，双份 worker 烧 token、I4 违例）。
      # 现在 claim 做「todo→in_progress」的单次状态迁移；抢输的一轮在起 worker 之前退出。
      if ! python3 "$SELF_DIR/ns.py" claim "$BOARD" "$cid" >/dev/null; then
        log "CLAIM-LOST $cid：已被另一轮认领（并行路径不启动 worker，不占 token）"
        release_worker_slot "$WSLOT_PAR" 2>/dev/null || true
        continue
      fi

      # 父进程先解析这张卡的源 worktree（零副作用），用 env 注入子进程 ——
      # 子进程因此**不依赖**那个会被并发改写的会话关联文件（并行串味的根因）
      SRC=$(python3 "$SELF_DIR/ns.py" source-of "$BOARD" "$cid" 2>/dev/null || true)
      SRC_S=$(printf '%s\n' "$SRC" | sed -n 's/^SESSION=//p')
      SRC_F=$(printf '%s\n' "$SRC" | sed -n 's/^FEATURE=//p')
      SRC_P=$(printf '%s\n' "$SRC" | sed -n 's/^PROJECT=//p')
      # source-of 在“自动建特性”的卡上只返回 E_DRY_RUN（父进程不建特性），不带 SESSION；
      # 这时用 pick 自带的 sourceSessionId 作为串行键，否则同源会话保护会漏掉首轮。
      if [ -z "$SRC_S" ]; then
        SRC_S=$(printf '%s' "$PICK" | python3 -c "import sys,json;print((json.load(sys.stdin).get('picked') or {}).get('sourceSessionId') or '')" 2>/dev/null || true)
      fi
      SRC_W=$(printf '%s\n' "$SRC" | sed -n 's/^WORKTREE=//p')
      # 这张卡的源会话进入本轮 active 集：同会话下一张卡等到下一轮/下一波。
      [ -n "$SRC_S" ] && ACTIVE_SESSIONS="$ACTIVE_SESSIONS $SRC_S"
      log "并行开跑（$((launched+1))/$PARALLEL）：$title（card=$cid）"
      (
        export NIGHTSHIFT_SOURCE_SESSION="$SRC_S" NIGHTSHIFT_SOURCE_FEATURE="$SRC_F" \
               NIGHTSHIFT_SOURCE_PROJECT="$SRC_P" NIGHTSHIFT_SOURCE_WORKTREE="$SRC_W" \
               NIGHTSHIFT_CLAIMED=1
        run_one "$cid" "$title" "$desc"; rc=$?
        release_worker_slot "$WSLOT_PAR"
        exit "$rc"
      ) &
      pids="$pids $!"
      launched=$((launched+1)); wave_n=$((wave_n+1))
    done
    [ -n "$pids" ] || break
    # 等任意一个结束，剔除已退出的 pid，并把 wave_n 对齐到存活数 ⇒ 内层 while 会立刻回填
    wait -n 2>/dev/null || true
    _alive=""
    for pid in $pids; do kill -0 "$pid" 2>/dev/null && _alive="$_alive $pid"; done
    pids="$_alive"
    wave_n=$(echo $pids | wc -w)
    done   # 波次循环结束
    # 复查：被强杀的子进程会把卡留在 in_progress ⇒ 收回来（避免永久卡住）
    for cid in $(python3 - "$BOARD" <<'PYB'
import json, sys
b = json.load(open(sys.argv[1], encoding="utf-8"))
print(" ".join(c["id"] for c in b.get("cards", []) if c.get("status") == "in_progress"))
PYB
); do
      python3 "$SELF_DIR/ns.py" recover "$BOARD" "$cid" >> "$LOG" 2>&1 || true
    done
    log "并行批结束：本次启动 $launched 张"
    recover_all_orphans 2>/dev/null || true
  }
  parallel_batch
  exit 0
fi
done_cards=0
log "TRACE-ROUND 开始 board=$BOARDKEY par=$PARALLEL only=${ONLY:-<无>} force=$FORCE"
while [ "$done_cards" -lt "$MAX_CARDS_PER_RUN" ]; do
  if [ "$FORCE" = 0 ]; then
    python3 "$SELF_DIR/ns.py" offpeak >/dev/null || { log "高峰时段，跳过"; say "跳过：当前是高峰"; break; }
    # IDLE_MIN=0 = 关闭空闲闸门（原来 0 会被判成"必须比 0 分钟还空闲" ⇒ 永远拦住，测试时踩到）
    if [ "${IDLE_MIN:-5}" -gt 0 ]; then
      msg=$(python3 "$SELF_DIR/ns.py" idle "$IDLE_MIN" "$LOAD_MAX" "$CPU_MAX")
      if [ $? -ne 0 ]; then
        if [ "$DRY" = 1 ]; then say "跳过：$msg"; else log "非空闲：$msg"; fi
        break
      fi
    fi
    if r=$(budget_deny_reason); then log "预算拒绝：$r"; say "跳过：$r"; break; fi
    if r=$(cost_deny_reason); then log "花费拒绝：$r"; say "跳过：$r"; break; fi
  fi

  ONLY_ONE=""
  if [ -n "$ONLY_LIST" ]; then ONLY_ONE=$(printf '%s' "$ONLY_LIST" | cut -d' ' -f$((done_cards+1))); fi
  if [ -n "$ONLY_LIST" ] && [ -z "$ONLY_ONE" ]; then break; fi   # 列表走完
  PICK=$(python3 "$SELF_DIR/ns.py" pick "$BOARD" "$ONLY_ONE")
  jqget() { printf '%s' "$PICK" | python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }
  CID=$(jqget "(d.get('picked') or {}).get('id','')")
  TITLE=$(jqget "(d.get('picked') or {}).get('title','')")
  REASON=$(jqget "d.get('reason') or ''")
  DECN=$(jqget "len(d.get('decisionCards') or [])")
  # 注意：不要用 "$ONLY" 覆盖 CID —— ns.py pick 已按 --only 返回该卡（不存在/非 todo 时返回 picked=null），
  # 覆盖会让"指定了不存在的卡"照样开跑（2026-10-16 事故：白烧 0.0245 元）。
  if [ -z "$CID" ]; then
    log "无可跑待办：${REASON}（需你拍板 ${DECN} 张已跳过）"
    say "跳过：${REASON}"
    [ "$DECN" != "0" ] && say "  另有 ${DECN} 张需要你拍板的卡（无人值守不碰）；执行 ns.py triage 看清单"
    break
  fi
  if [ "$DRY" = 1 ]; then
    wl=$(python3 "$SELF_DIR/ns.py" window-left)
    say "会跑：$TITLE"
    say "  card=$CID  剩余窗口=${wl}s  今日已用=${DAYCARDS}卡/${DAYMIN}min"
    [ "$wl" -lt "$MIN_WINDOW_LEFT" ] && say "  注意：剩余窗口 < MIN_WINDOW_LEFT(${MIN_WINDOW_LEFT}s)，实际不会开跑"
    break
  fi

  DESC=$(jqget "(d.get('picked') or {}).get('description','')")
  SOURCE_SESSION=$(jqget "(d.get('picked') or {}).get('sourceSessionId','')")
  WSLOT=$(acquire_worker_slot) || { log "并发槽已满（MAX_WORKERS=$MAX_WORKERS），本轮到此为止"; break; }
  printf '%s\n' "${CID:-}" > "$SLOTS/$WSLOT/card" 2>/dev/null || true
  # 可回溯索引：会话 id ⇄ 卡片 ⇄ 标题（会话标题由首条消息决定、无法改写，故用索引补足）
  printf '%s\t%s\t%s\n' "${CID:-}" "${TITLE:-}" "$(date '+%F %T')" >> "$RUNTIME_DIR/worker-index.tsv" 2>/dev/null || true
  date +%s > "$SLOTS/$WSLOT/start" 2>/dev/null || true
  run_one "$CID" "$TITLE" "$DESC"; rc=$?
  release_worker_slot "$WSLOT"
  if [ "$rc" = 10 ] || [ "$rc" = 11 ]; then break; fi
  if [ "$rc" = 13 ]; then continue; fi   # 被另一轮认领：不计完成、继续下一张
  done_cards=$((done_cards+1))
  [ "$done_cards" -lt "$MAX_CARDS_PER_RUN" ] && sleep 5
done
# 花费取值加回落（跨日/空 day 文件时曾出现"今日花费约  元"的空值显示）
  # 注意：这里是**主流程层**，不是函数内部 ⇒ 不能用 local（写错过一次：报错且花费显示为空）
  _c=$(python3 "$SELF_DIR/ns.py" day-cost 2>/dev/null | sed -n 's/^COST=\([0-9.]*\).*/\1/p')
  [ -n "$_c" ] || _c=0.0000
  log "本轮结束：做了 $done_cards 张（今日累计 ${DAYCARDS} 卡 / ${DAYMIN} min；今日花费约 ${_c} 元）"
  # 缓存/成本摘要（纯本地读 transcript，零 token）：命中率/输出占比/重复 run 每轮都看得见。
  python3 "$SELF_DIR/ns.py" cost-report 2>/dev/null | head -6 | while IFS= read -r _l; do log "  $_l"; done
exit 0
