#!/usr/bin/env python3
"""nightshift 判定与记账内核（**零 token**：本文件不做任何模型调用）。

子命令
  offpeak [--force]                    现在是否 DeepSeek 官方低谷（北京时间）
  window-left                          距下一个高峰边界还有多少秒（上限 6h=21600）
  idle <IDLE_MIN> <LOAD_MAX> <CPU_MAX> 机器是否空闲（会话静默 + 负载 + CPU + loginctl IdleHint）
  pick <BOARD>                         选本轮要做的卡（JSON：picked/reason/todoCount/held/decisions）
  mark <BOARD> <CID> <STATUS>          置状态（in_progress 用）
  apply <BOARD> <CID> <RESULT_FILE>    按 worker 结果落状态（done 需证据；失败计次；超限转待审）
  receipt <BOARD> <CID> <RESULT_FILE> [EXTRA]   维护「夜间跑批回执」卡
  triage <BOARD>                       零 token 可跑性报告（不写看板）
  status                               打印 state（上次决策/今日计数/尝试次数）

设计约束
  * 看板读写全在这里（确定性）；worker 只干活并输出 KANBAN-RESULT/SUMMARY/NOTE/EVIDENCE。
  * 写看板带**防丢更新**：写前重读核对指纹，若文件已被别人（你/别的会话）改过，就把我们的
    字段增量重放到新内容上再写（最多 3 次）；仍冲突则放弃本次写入——绝不覆盖你的编辑。
  * 写盘格式与 dsh-kanban 插件一致（indent=2 + 末尾换行），避免每次写入都翻转文件格式。
  * 门槛口径唯一：todo 且 tags 不含 hold 才可跑；带 auto 的优先；决策类卡不交给无人值守。
  * 状态副作用（attempts 计数）在 mutate 之外做一次，避免冲突重放时重复计数。
"""
import json
import os
import re
import sys
import uuid
import time
import glob
import datetime
import hashlib
import shutil
import subprocess   # 顶层导入：_source_worktree 的 AUTO_FEATURE 与 prep-worktree 都要用（原先进口在函数内）

# 代码目录（可能位于 npm 包/符号链接）与运行目录（状态/日志/锁/槽位）分离。
CODE_DIR = os.path.dirname(os.path.abspath(__file__))
RUNTIME_DIR = os.environ.get("NIGHTSHIFT_RUNTIME_DIR") or CODE_DIR
DSH_HOME = os.environ.get("DSH_HOME") or os.path.expanduser("~/.dsh")
SESSIONS_GLOB = os.path.join(DSH_HOME, "sessions", "*", "*", "session.v4.jsonl.zstd")
KANBAN_DEFAULT = os.environ.get("NIGHTSHIFT_BOARD", "")
STATE = os.environ.get("NIGHTSHIFT_STATE", os.path.join(RUNTIME_DIR, "state.json"))
WINDOW_CAP = 6 * 3600
DECISION_TAGS = {"decision-needed", "human-review", "blocking", "legal", "needs-direction"}
DECISION_TITLE = ("拍板", "人审", "要不要", "请裁决", "need decision")
RECEIPT_TITLE = "夜间跑批回执（自动维护）"
RECEIPT_KEEP = 10
# 门槛可配：默认「todo 且非 hold」都算可跑（ops 板口径）。
# 置 NIGHTSHIFT_REQUIRE_AUTO=1 改为「必须带 auto 才算可跑」——给那些**显式约定 auto** 的看板用
# （推荐做法：只在明确可无人值守时才打 auto，其余待办留给人拍板）。
MAX_ATTEMPTS = int(os.environ.get("MAX_ATTEMPTS", "2"))   # 与 scan.sh 同源：连续未完成多少次后转送审
REQUIRE_AUTO = os.environ.get("NIGHTSHIFT_REQUIRE_AUTO", "0").lower() not in ("0", "", "false", "no")


# ------------------------------------------------------------------ 时段
# ── 峰谷口径（与 dsh-peak-pause 的 lib/peak-window.js 完全一致；由 verify-peak-parity.sh 逐点核对）
# 峰时 = 北京时间周一至周五（不含法定节假日）09:00–12:00、14:00–18:00；其余为谷价。
PEAK_HOLIDAYS_2026 = {
    "2026-01-01", "2026-01-02", "2026-01-03",
    "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20",
    "2026-02-21", "2026-02-22", "2026-02-23",
    "2026-04-04", "2026-04-05", "2026-04-06",
    "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
    "2026-06-19", "2026-06-20", "2026-06-21",
    "2026-09-25", "2026-09-26", "2026-09-27",
    "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07",
}


BJ_TZ = datetime.timezone(datetime.timedelta(hours=8))


def _bj(now=None):
    """把任意时刻换成**带 +08:00 时区**的北京时间（与插件同口径，且可安全与真实时间相减）。"""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    if now.tzinfo is None:
        now = now.astimezone()
    return now.astimezone(BJ_TZ)


def is_peak(now=None):
    p = _bj(now)
    if p.weekday() >= 5:                       # 周六/周日全天空闲
        return False
    if p.strftime("%Y-%m-%d") in PEAK_HOLIDAYS_2026:   # 法定节假日整天空闲
        return False
    return 9 <= p.hour < 12 or 14 <= p.hour < 18


def next_offpeak(now=None):
    """下一个山谷价时刻（精确到分钟边界，不靠逐分钟试探）。"""
    p = _bj(now).replace(second=0, microsecond=0)
    day0 = p.replace(hour=0, minute=0)
    for _ in range(400):                        # 最多找 400 天
        dkey = p.strftime("%Y-%m-%d")
        off_day = p.weekday() >= 5 or dkey in PEAK_HOLIDAYS_2026
        if off_day:
            return p
        for (h0, h1) in ((9, 12), (14, 18)):
            st = day0.replace(hour=h0)
            en = day0.replace(hour=h1)
            if st <= p < en:
                return en
        if p < day0.replace(hour=9):
            return p
        # 当天 18:00 之后 → 次日零点（若次日是谷日）或次日 09:00 前的谷段
        p = day0 + datetime.timedelta(days=1)
        day0 = p.replace(hour=0, minute=0)
        if p.weekday() >= 5 or p.strftime("%Y-%m-%d") in PEAK_HOLIDAYS_2026:
            return p
    return p


def next_peak_start(now=None):
    """下一个**峰段开始**的绝对时刻（当前已在峰段则返回 now ⇒ window_left=0）。"""
    p = _bj(now).replace(second=0, microsecond=0)
    if is_peak(p):
        return p
    for _ in range(400):
        dkey = p.strftime("%Y-%m-%d")
        off_day = p.weekday() >= 5 or dkey in PEAK_HOLIDAYS_2026
        if not off_day:
            d0 = p.replace(hour=0, minute=0)
            nine, fourteen = d0.replace(hour=9), d0.replace(hour=14)
            if p < nine:
                return nine
            if d0.replace(hour=12) <= p < fourteen:
                return fourteen
        p = (p + datetime.timedelta(days=1)).replace(hour=0, minute=0)
    return p


def window_left(now=None):
    """距下一个**峰段开始**的秒数（跑批据此封顶本轮超时，绝不跨进高峰）。"""
    now2 = now or datetime.datetime.now(datetime.timezone.utc)
    if now2.tzinfo is None:
        now2 = now2.astimezone()
    nxt = next_peak_start(now2)
    return max(0, int((nxt - now2.astimezone(BJ_TZ)).total_seconds()))


def peak_reason(now=None):
    """峰/谷的成因：只描述判定依据，不猜外部事件（钩子用它组织文案）。"""
    p = _bj(now)
    if p.strftime("%Y-%m-%d") in PEAK_HOLIDAYS_2026:
        return "holiday"
    if p.weekday() >= 5:
        return "weekend"
    if 9 <= p.hour < 12 or 14 <= p.hour < 18:
        return "in-peak"
    if p.hour < 9:
        return "before-peak"
    if 12 <= p.hour < 14:
        return "lunch"
    return "past-peak"


def seconds_to_switch(now=None):
    """距下一个时段切换的秒数：谷 → 下次峰段开始；峰 → 本段结束。"""
    now2 = now or datetime.datetime.now(datetime.timezone.utc)
    if now2.tzinfo is None:
        now2 = now2.astimezone()
    p = now2.astimezone(BJ_TZ)
    if not is_peak(now2):
        return window_left(now2)
    end_hour = 12 if p.hour < 12 else 18
    end = p.replace(hour=end_hour, minute=0, second=0, microsecond=0)
    return max(0, int((end - p).total_seconds()))


def cmd_offpeak(argv):
    """offpeak [--force] [--json] [--at <ISO8601>]

    退出码沿用历史语义：峰时 1、谷时 0（调用方若只用 --json，请忽略退出码）。
    --json 是给钩子用的**只读视图**：不改判定、不改节假日数据。
    """
    if "--force" in argv:
        print("FORCED"); return 0
    now = None
    if "--at" in argv:
        i = argv.index("--at")
        try:
            now = datetime.datetime.fromisoformat(argv[i + 1])
        except (IndexError, ValueError):
            print("usage: ns.py offpeak [--json] [--at <ISO8601>]", file=sys.stderr); return 2
        if now.tzinfo is None:
            now = now.replace(tzinfo=BJ_TZ)
    peak = is_peak(now)
    if "--json" in argv:
        print(json.dumps({"peak": peak, "why": peak_reason(now),
                          "next_seconds": seconds_to_switch(now),
                          "calendar": "builtin"}, ensure_ascii=False))
    else:
        print("PEAK" if peak else "OFFPEAK")
    return 1 if peak else 0


def cmd_window_left(argv):
    print(window_left())
    return 0


# ------------------------------------------------------------------ 空闲
def newest_session_activity():
    newest = 0.0
    for p in glob.glob(SESSIONS_GLOB):
        try: m = os.path.getmtime(p)
        except OSError: continue
        if m > newest: newest = m
    return newest


def cpu_busy(interval=1.0):
    """CPU 使用率；平台没有 /proc/stat（如 macOS）时返回 0，让 loadavg/IdleHint 继续当判据。"""
    try:
        def snap():
            return [int(x) for x in open("/proc/stat").readline().split()[1:8]]
        a = snap(); time.sleep(interval); b = snap()
    except OSError:
        return 0.0
    d = [y - x for x, y in zip(a, b)]
    tot = sum(d)
    return 100.0 * (tot - d[3]) / tot if tot else 0.0


def loginctl_idle_hint():
    """有活动座席且全部 IdleHint=yes → True；有 IdleHint=no → False；查不到 → None。"""
    try:
        out = os.popen("loginctl list-sessions --no-legend 2>/dev/null").read().strip()
    except Exception:
        return None
    ids = [l.split()[0] for l in out.splitlines() if l.strip()]
    if not ids:
        return None
    hints = []
    for sid in ids:
        v = os.popen("loginctl show-session %s -p IdleHint 2>/dev/null" % sid).read().strip()
        if v.startswith("IdleHint="):
            hints.append(v.split("=", 1)[1].strip().lower() == "yes")
    return all(hints) if hints else None


def cmd_idle(argv):
    idle_min = float(argv[0]) if len(argv) > 0 else 15.0
    # LOAD_MAX_AUTO：默认阈值不再写死 2.0。本机常态 load≈2.7–3.1（openclaw/dsh 自身），
    # 写死 2.0 ⇒ 永远 BUSY ⇒ 跑批永远不领任务（2026-10-31 用户遇到的正是这个）。
    # 改为 max(传入值, 核数*0.9)，并允许 NIGHTSHIFT_LOAD_MAX 显式覆盖。
    _cores = os.cpu_count() or 2
    _auto = max(2.0, _cores * 0.9)
    _arg = (argv[1] if len(argv) > 1 else "")
    load_max = float(os.environ.get("NIGHTSHIFT_LOAD_MAX") or (_arg if _arg.strip() else _auto))
    cpu_max = float(argv[2]) if len(argv) > 2 else 40.0
    load1 = os.getloadavg()[0]
    if load1 > load_max:
        print("BUSY load1=%.2f > %.2f" % (load1, load_max)); return 1
    newest = newest_session_activity()
    quiet = (time.time() - newest) / 60.0 if newest else 1e9
    if quiet < idle_min:
        print("BUSY 最近一次会话活动在 %.1f 分钟前（阈值 %.0f）" % (quiet, idle_min)); return 1
    busy = cpu_busy()
    if busy > cpu_max:
        print("BUSY CPU busy=%.0f%% > %.0f%%" % (busy, cpu_max)); return 1
    hint = loginctl_idle_hint()
    if hint is False:
        print("BUSY loginctl IdleHint=no（有活动座席）"); return 1
    print("IDLE load1=%.2f CPU=%.0f%% 会话静默=%.1f分钟 IdleHint=%s" % (load1, busy, quiet, hint))
    return 0


# ------------------------------------------------------------------ 看板
def load_board(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def fingerprint(path):
    try:
        st = os.stat(path)
        return (st.st_mtime_ns, st.st_size)
    except OSError:
        return None


BOARD_STATUSES = ("todo", "in_progress", "review", "done")


def card_shape_errors(card):
    """按 dsh-kanban 的形状规则检查一张卡（必须与插件 isBoardCard 一致）。

    为什么要有这道闸门：插件用 `cards.every(isBoardCard)` 判定整板；**一张卡的字段类型不对
    就会让整板被判「shape 不对」→ 看板页与所有 board_* 工具全部失效**（2026-10-16 实测：
    某看板里恰好 1 张卡的 rationale 被写成了数组，整页因此什么都不显示）。
    插件的立场是「fail loud，不静默修复」，这里同样：宁可不写，也不把坏形状落盘。
    """
    e = []
    if not isinstance(card.get("id"), str) or card.get("id") == "":
        e.append("id")
    if not isinstance(card.get("title"), str) or card.get("title", "").strip() == "":
        e.append("title")
    if card.get("status") not in BOARD_STATUSES:
        e.append("status=%r" % (card.get("status"),))
    tags = card.get("tags")
    if not isinstance(tags, list) or not all(isinstance(t, str) for t in tags):
        e.append("tags=%r" % (tags,))
    for k in ("createdAt", "updatedAt"):
        v = card.get(k)
        if not isinstance(v, (int, float)) or isinstance(v, bool):
            e.append("%s=%r" % (k, v))
    for k in ("description", "summary", "rationale", "rejected", "sourceSessionId"):
        if k in card and not isinstance(card[k], str):
            e.append("%s(%s)" % (k, type(card[k]).__name__))
    return e


def board_shape_errors(board):
    if not isinstance(board, dict):
        return ["根不是对象"]
    if board.get("version") != 1:
        return ["version != 1"]
    cards = board.get("cards")
    if not isinstance(cards, list):
        return ["cards 不是数组"]
    out = []
    for c in cards:
        errs = card_shape_errors(c if isinstance(c, dict) else {})
        if errs:
            out.append("%s: %s" % ((c or {}).get("id", "?") if isinstance(c, dict) else "?", ",".join(errs)))
    return out


def _write_board(path, board):
    errs = board_shape_errors(board)
    if errs:
        raise ValueError("拒绝写入：看板形状不合法（会让插件整板失效）→ %s" % "; ".join(errs[:3]))
    tmp = "%s.nightshift.%d.tmp" % (path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(board, ensure_ascii=False, indent=2) + "\n")
    os.replace(tmp, path)


def mutate_board(path, mutate, attempts=3):
    """读→改→（写前核对指纹）→写；冲突则重读重放。返回 ok/nochange/conflict/missing。"""
    for _ in range(attempts):
        if not os.path.exists(path):
            return "missing"
        fp = fingerprint(path)
        board = load_board(path)
        if mutate(board) is not True:
            return "nochange"
        if fingerprint(path) != fp:          # 期间被别人改过 → 重读重放，绝不覆盖
            continue
        try:
            _write_board(path, board)
        except ValueError as exc:            # 形状不合法：宁可不写，也不让整板失效
            print("REFUSED %s" % exc, file=sys.stderr)
            return "invalid"
        return "ok"
    return "conflict"


def _find(board, cid):
    for c in board.get("cards", []):
        if c.get("id") == cid:
            return c
    return None


def _tags(card):
    return [t.lower() for t in (card.get("tags") or [])]


def eligible(card):
    """门槛：todo 且不带 hold；REQUIRE_AUTO 时还要求带 auto。auto 表示“明确安全、优先”。"""
    if card.get("status") != "todo":
        return False
    tags = _tags(card)
    if "hold" in tags:
        return False
    # PREFLIGHT_ELIGIBLE（2026-11-01）：没有 sourceSessionId 又没开自动建特性 ⇒ 一定 E_NO_SOURCE，
    # 挑它等于白烧一轮（日志里"3 张并行全秒失败"就是这么来的）。先在选卡阶段就排除。
    if not card.get("sourceSessionId") and os.environ.get("NIGHTSHIFT_AUTO_FEATURE") != "1":
        return False
    # 决策/待审类（tags 带 review）不进无人值守
    if "review" in tags or "decision" in tags:
        return False
    # HOLD_IN_TEXT（2026-11-01）：标题或描述里写明 HOLD 的卡（外部依赖未就绪，如"需 key+设备"）
    # 以前只写在标题里、没有 hold 标签 ⇒ 会被反复挑中然后必然失败。
    _t = (card.get("title") or "") + "\n" + (card.get("description") or "")[:2000]
    # 2026-11-04：不再用"解除"二字做豁免（说明文字里的"解除 hold"会把阻塞卡误放行）。
    # 放行必须显式加结构化标签 released（或去掉标题里的 HOLD）。
    if "HOLD" in _t.upper() and "released" not in tags:
        return False
    if REQUIRE_AUTO and "auto" not in tags:
        return False
    return True


def is_decision(card):
    """是否属于"无人值守不许碰"的决策卡。

    2026-10-16 用户要求后的口径：**`auto` 是人工显式放行** —— 带 auto 的卡即使标题/标签像决策卡，
    也照跑（人已经明确说"交给跑批"）；但 `hold`（绝不允许无人值守）优先于 auto，仍然拦住。
    """
    tags = _tags(card)
    # 人工显式 auto 压过全部决策启发式（含标题规则）；hold 仍然优先（下一行起各分支照旧）
    if "auto" in tags and "hold" not in tags:
        return False
    if DECISION_TAGS & set(tags):
        return True
    if any(t.startswith("blocked") for t in tags):     # 阻塞于某人拍板：跑了也白跑
        return True
    title = (card.get("title") or "").strip()
    return any(title.startswith(k) or k in title[:12] for k in DECISION_TITLE)


# PICK-INCLUDE-SOURCE 2026-11-01：picked 必须带 sourceSessionId，否则跑批永远 E_NO_SOURCE
def cmd_pick(argv):
    path = argv[0] if argv else KANBAN_DEFAULT
    only = argv[1] if len(argv) > 1 and argv[1] else None
    board = load_board(path)
    cards = board.get("cards", [])
    todos = [c for c in cards if c.get("status") == "todo"]

    if only:                       # 人工定向：必须取这张卡自己的标题/描述（不能借用别人的）
        c = next((x for x in cards if x.get("id") == only), None)
        if c is None:
            print(json.dumps({"picked": None, "reason": "指定的卡不存在：%s" % only,
                              "todoCount": len(todos), "runnableCount": 0,
                              "decisionCards": [], "heldCount": 0}, ensure_ascii=False))
            return 0
        if c.get("status") != "todo":
            print(json.dumps({"picked": None, "reason": "指定的卡状态是 %s，不是 todo" % c.get("status"),
                              "todoCount": len(todos), "runnableCount": 0,
                              "decisionCards": [], "heldCount": 0}, ensure_ascii=False))
            return 0
        print(json.dumps({"picked": {"id": c["id"], "title": c["title"],
                                     "description": c.get("description") or "",
                                     "sourceSessionId": c.get("sourceSessionId") or "",
                                     "tags": c.get("tags") or []},
                          "reason": None, "todoCount": len(todos), "runnableCount": 1,
                          "decisionCards": [], "heldCount": 0}, ensure_ascii=False))
        return 0

    cand = [c for c in todos if eligible(c)]
    decisions = [c for c in cand if is_decision(c)]
    runnable_all = sorted([c for c in cand if not is_decision(c)],
                          key=lambda c: 0 if "auto" in _tags(c) else 1)     # auto 优先
    # 同源会话串行保护：同一次扫描里，同一个 sourceSessionId 只允许一个 worker。
    # 原因（2026-11-10 实测）：同一会话派生的多张卡虽然各有 worker worktree，但 merge-back
    # 都回到同一个源 worktree；并行合并会撞 .devloop/posture / worker-progress，并让 worker
    # 看到别人的现场，最终出现「结果行无法解析/串味」。宁可串行，不要串味。
    active_sessions = {x for x in os.environ.get("NIGHTSHIFT_ACTIVE_SESSIONS", "").split() if x}
    blocked = [c for c in runnable_all
               if (c.get("sourceSessionId") or "").strip() in active_sessions]
    runnable = [c for c in runnable_all
                if (c.get("sourceSessionId") or "").strip() not in active_sessions]
    missing_session = [c for c in todos if not (c.get("sourceSessionId") or "").strip()]
    picked = runnable[0] if runnable else None
    reason = None
    if picked is None:
        if not todos:
            reason = "看板没有 todo 卡"
        elif not cand and missing_session:
            reason = ("有 %d 张 todo 缺 sourceSessionId，跑批不会捡（用 offhours card add 建卡，"
                      "或在 dsh 会话里给它补 --session）" % len(missing_session))
        elif not cand:
            reason = "所有 todo 都标了 hold（禁跑）"
        elif blocked:
            reason = ("同源会话已有 worker 在跑（%d 张同会话卡暂时串行），等这一波结束再跑"
                      % len(blocked))
        else:
            reason = "只剩需你拍板的卡（%d 张），无人值守不碰" % len(decisions)
    print(json.dumps({
        "picked": None if picked is None else {
            "id": picked["id"], "title": picked["title"],
            "description": picked.get("description") or "", "tags": picked.get("tags") or [],
            # 必须带来源会话：跑批靠它决定把代码提交到哪个特性 worktree（缺了就 E_NO_SOURCE）
            "sourceSessionId": picked.get("sourceSessionId") or ""},
        "reason": reason,
        "todoCount": len(todos), "runnableCount": len(runnable),
        "blockedSessionCount": len(blocked),
        "decisionCards": [{"id": c["id"], "title": c["title"][:60]} for c in decisions],
        "heldCount": len(todos) - len(cand),
        "missingSessionCount": len(missing_session),
    }, ensure_ascii=False))
    return 0


def cmd_claim(argv):
    """claim <BOARD> <cid>：把 todo 卡**原子地**改成 in_progress。

    为什么需要（2026-11-04 实测事故）：扫描器原来的顺序是 pick（只读，筛 status==todo）
    → …起 worker 前才 mark in_progress。而新的并发模型允许同板最多 MAX_WORKERS 轮并行
    （daemon --force 轮 + timer 轮就会同时在场），于是**两轮可能挑中同一张卡**：
    实测 card-ade3b643 同时占了 slot 1/5，两个 worker 重复烧 token，不变量 I4 报违例。
    修法：把「认领」做成一次 mutate_board 内的状态迁移——抢输的那一轮在起 worker 之前退出。

    退出码：0 认领成功（或本来就是我们的可选重入）；1 已被别人认领/卡不存在/写失败。
    """
    path, cid = argv[0], argv[1]
    got = {"ok": False, "why": ""}

    def m(board):
        c = _find(board, cid)
        if c is None:
            got["why"] = "not-found"
            return False
        if c.get("status") != "todo":
            got["why"] = "already-%s" % c.get("status")
            return False
        c["status"] = "in_progress"
        c["updatedAt"] = int(time.time() * 1000)
        got["ok"] = True
        got["why"] = "claimed"
        return True

    r = mutate_board(path, m)
    print("claim %s : %s (%s)" % (cid, r, got["why"]))
    return 0 if (r == "ok" and got["ok"]) else 1


def cmd_mark(argv):
    path, cid, status = argv[0], argv[1], argv[2]
    def m(board):
        c = _find(board, cid)
        if c is None: return False
        c["status"] = status
        c["updatedAt"] = int(time.time() * 1000)
        return True
    r = mutate_board(path, m)
    print("mark %s -> %s : %s" % (cid, status, r))
    return 0 if r == "ok" else 1


# -------- worker 结果 --------
RX = {
    "result":   re.compile(r"^\s*KANBAN-RESULT:\s*(done|review|failed)\s*$", re.I | re.M),
    "summary":  re.compile(r"^\s*KANBAN-SUMMARY:\s*(.+)$", re.M),
    "note":     re.compile(r"^\s*KANBAN-NOTE:\s*(.+)$", re.M),
    "evidence": re.compile(r"^\s*KANBAN-EVIDENCE:\s*(.+)$", re.M),
    "system":   re.compile(r"^\s*KANBAN-SYSTEM:\s*(.+)$", re.M),
}


def _text_from_ndjson(text):
    """worker 用 `--json` 跑时，stdout 是事件流；把里面的文本还原成最终答复。

    事件形状（实测 2026-10-16）：{"type":"session"/"status"/"thinking"/"text"/"final", ...}
    ⇒ 优先取最后一条 `final`，否则拼接所有 `text`。
    """
    final = None
    chunks = []
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            o = json.loads(line)
        except Exception:
            continue
        if not isinstance(o, dict) or "type" not in o:
            continue
        if o.get("type") == "final" and isinstance(o.get("text"), str):
            final = o["text"]
        elif o.get("type") == "text" and isinstance(o.get("text"), str):
            chunks.append(o["text"])
    if final is not None:
        return final
    return "\n".join(chunks) if chunks else text


def parse_result(text):
    text = _text_from_ndjson(text or "")     # worker 用 --json 跑：先把事件流还原成文本
    out = {"result": "failed", "summary": "", "note": "", "evidence": "", "system": ""}
    for k, rx in RX.items():
        ms = list(rx.finditer(text or ""))
        if ms:
            out[k] = ms[-1].group(1).strip()
    if out["result"] == "failed" and not out["summary"]:
        out["summary"] = "worker 未给出可解析的结果行"
    return out


def load_state():
    try: return json.load(open(STATE, encoding="utf-8"))
    except Exception: return {}


def save_state(d):
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(d, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, STATE)


def today_key():
    return datetime.datetime.now().strftime("%Y-%m-%d")


def attempt_count(cid):
    return int((load_state().get("attempts") or {}).get(cid, 0))


def set_attempt(cid, n):
    st = load_state()
    at = st.get("attempts") or {}
    if n <= 0:
        at.pop(cid, None)
    else:
        at[cid] = n
    st["attempts"] = at
    save_state(st)


REVIEW_FIELDS = ("一句话", "卡在哪", "前因", "选项", "批准后", "不批准")


def review_compliance(text):
    """检查"待审核说明"是否达标（2026-10-17 用户标准，已替代早期的六字段审批单口径）。

    必须有：① 架构级 ASCII 图（```text 围栏，宽度 ≤100）
            ② 至少 1 个明确编号的**待决策项**（D1/O1/R1…；R 用于「归档 or 保留」这类收尾决定）
            ③ 每个决策项的「代价」
            ④ 「需要澄清的前提/需澄清」
            ⑤ 「不处理的后果」
    为什么：用户要的是"跟这张卡严格相关、架构级可视、小白能懂、点明要你决策什么"，
    而不是通用模板或纯选项清单。
    """
    miss = []
    s = text or ""
    blocks, cur = [], None
    OPEN_RE = re.compile(r"^```\s*(?:text|Text|TEXT|language-text|txt)?\s*$")
    for line in s.splitlines():
        st = line.strip()
        if cur is None and st.startswith("```"):   # st 已 strip ⇒ 容忍缩进
            if st != "```":                      # 带语言的围栏（```text / ```Text / ```language-text …）
                cur = []
        elif st == "```" and cur is not None:
            blocks.append(cur); cur = None
        elif cur is not None:
            cur.append(line)
    if not blocks:
        miss.append("```text 围栏的 ASCII 架构图")
    else:
        wide = [len(b) for blk in blocks for b in blk if len(b) > 100]
        if wide:
            miss.append("ASCII 图宽度超 100（最宽 %d）" % max(wide))
    dec = re.findall(r"(\|\s*\*\*[DOR]\d+\*\*|^[\s-]*\*\*[DOR]\d+\*\*|^[\s-]*\*\*[DOR]\d+[):：]|^[\s-]*[DOR]\d+\s*[：:),、])", s, re.M)
    if not dec:
        miss.append("明确编号的待决策项（D*/O*）")
    if "代价" not in s:
        miss.append("决策项的「代价」")
    if "澄清" not in s and "前提" not in s:
        miss.append("「需要澄清的前提」")
    if "后果" not in s and "不处理" not in s:
        miss.append("「不处理的后果」")
    return (len(miss) == 0), miss


def _bounded_desc(desc, limit=6000):
    """把卡描述限制在 limit 字符内（用户要求"不要无限膨胀"）。

    保留：头部原文（最早的历史，通常是人写的）＋ 最近 2 段（当前状态）；
    中间折叠成一行标记。任何写路径都应先过这里，避免每次 apply 追加把卡撑大。
    """
    s = desc or ""
    if len(s) <= limit:
        return s
    keep = max(400, limit // 3)
    head, tail = s[:keep], s[-keep:]
    # 尾部按空行切段，保留最近 2 段
    segs = [x for x in re.split(r"\n{2,}", tail) if x.strip()]
    tail2 = "\n\n".join(segs[-2:]) if segs else ""
    folded = len(s) - len(head) - len(tail2)
    return head.rstrip() + "\n\n…(已折叠 %d 字符旧记录，原文可按卡 id 与 git 历史追溯)…\n\n" % max(0, folded) + tail2


def cmd_apply(argv):
    path, cid, res_path = argv[0], argv[1], argv[2]
    max_attempts = int(os.environ.get("MAX_ATTEMPTS", "2"))
    text = open(res_path, encoding="utf-8", errors="replace").read() if os.path.exists(res_path) else ""
    res = parse_result(text)
    stamp = datetime.datetime.now().strftime("%m-%d %H:%M")

    # 先定结果（attempts 计数只在 mutate 之外做一次，避免重放重复计数）
    decision = {"status": None, "suffix": ""}
    if res["result"] == "done" and not res["evidence"]:
        decision = {"status": "review",
                    "suffix": "\n\n【夜间跑批 %s 缺验证证据，转待审】worker 声明完成但没给 KANBAN-EVIDENCE；总结：%s"
                              % (stamp, res["summary"][:200])}
    elif res["result"] == "done":
        decision = {"status": "done", "suffix": ""}
    elif res["result"] == "review":
        # 送审材料合规闸门（能力）：不合规的 review 不予受理 ⇒ 转 failed 让 worker 补齐重来
        # 系统生成的 review（守卫/超时/窗口/沙箱）没有“审批单”，不应被 worker 的审批单格式闸门误杀。
        _gate = (os.environ.get("NIGHTSHIFT_REVIEW_GATE", "1") not in ("0", "false", "no")
                 and not (res.get("system") or "").strip())
        _ok, _miss = (True, []) if not _gate else review_compliance((res["note"] or "") + "\n" + (res["summary"] or ""))
        if not _ok:
            # 注意：failed 不是看板合法状态（BOARD_STATUSES=todo/in_progress/review/done）；
            # 这里必须退回 todo/review，否则 mutate 会因形状非法被拒，卡会永远卡在 in_progress。
            n = attempt_count(cid) + 1
            set_attempt(cid, n)
            if n >= max_attempts:
                decision = {"status": "review",
                            "suffix": "\n\n【夜间跑批 %s 送审材料连续 %d 次不合规，转人工】缺：%s。请补 explain-plain 上下文"
                                      "（L0 全景 ASCII + 白话因果链 + 选项与代价 + 不处理的后果）。"
                                      % (stamp, n, "；".join(_miss))}
            else:
                decision = {"status": "todo",
                            "suffix": "\n\n【夜间跑批 %s 送审材料不合规（第 %d 次），退回重跑】缺：%s。请按硬规则 7 补齐"
                                      " explain-plain 上下文后重新送审。"
                                      % (stamp, n, "；".join(_miss))}
        else:
            # summary 是“为什么送审”（尤其系统 review 的 E_* 原因码），note 是细节；两者都要留。
            _detail = (res.get("summary") or "").strip()
            if res.get("note"):
                _detail = (_detail + "\n" + res["note"]).strip()
            decision = {"status": "review",
                    "suffix": "\n\n【夜间跑批送审 %s】%s" % (stamp, (_detail or "需要你确认")[:600])}
    else:
        n = attempt_count(cid) + 1
        set_attempt(cid, n)
        if n >= max_attempts:
            decision = {"status": "review",
                        "suffix": "\n\n【夜间跑批连续 %d 次未完成 %s】%s" % (n, stamp, res["summary"][:300])}
        else:
            decision = {"status": "todo",
                        "suffix": "\n\n【夜间跑批 %s 未完成（第 %d 次）】%s" % (stamp, n, res["summary"][:300])}

    # 最后一道防御：看板只认 todo/in_progress/review/done；任何内部非法状态都转 review，绝不写坏看板。
    if decision["status"] not in BOARD_STATUSES:
        print("WARN apply 内部状态非法：%r → 转 review" % (decision["status"],), file=sys.stderr)
        decision = {"status": "review",
                    "suffix": "\n\n【夜间跑批 %s】内部状态 %r 非法，已转待审；请人工检查。" % (stamp, decision["status"])}

    wsid = os.environ.get("NIGHTSHIFT_WORKER_SESSION", "").strip()

    def m(board):
        c = _find(board, cid)
        if c is None: return False
        now = int(time.time() * 1000)
        c["status"] = decision["status"]
        # HOLD_ON_REPEAT_V2：连续失败 / 连续不合规的卡自动加 hold，终止"送审→批准→再送审"循环
        if decision["status"] == "review":
            try:
                _att = int((load_state().get("attempts") or {}).get(cid, 0))
            except Exception:
                _att = 0
            if _att >= MAX_ATTEMPTS and "hold" not in (c.get("tags") or []):
                c["tags"] = list(c.get("tags") or []) + ["hold"]
                c["description"] = (c.get("description") or "").rstrip() + (
                    "\n【停止重试 2026-10-31】连续 %d 次未通过 ⇒ 自动加 hold（不再被跑批捡起）。"
                    "补上缺失前提后去掉 hold 再批准。\n" % _att)
        if decision["status"] == "done":
            c["summary"] = ((res["summary"] or ("夜间跑批于 %s 完成" % stamp))[:400]
                            + "\n证据：" + res["evidence"][:600])
            if not (c.get("rationale") or "").strip(): c["rationale"] = "由夜间跑批（低谷+空闲）执行"
            if not (c.get("rejected") or "").strip(): c["rejected"] = "无"
        elif decision["suffix"]:
            c["description"] = _bounded_desc((c.get("description") or "").rstrip() + decision["suffix"])
        if wsid:
            src = (c.get("sourceSessionId") or "").strip()
            d0 = c.get("description") or ""
            if "<!-- nightshift: worker=" not in d0:          # 幂等：冲突重放时不重复追加
                c["description"] = d0.rstrip() + (
                    "\n\n【处理会话】%s（源自会话 %s）—— 可直接打开该会话看它怎么做的\n"
                    "<!-- nightshift: worker=%s source=%s -->\n" % (wsid, src or "未记录", wsid, src))
        c["updatedAt"] = now
        return True

    r = mutate_board(path, m)
    if decision["status"] == "done" and r == "ok":
        set_attempt(cid, 0)
    print("apply %s -> %s (=> %s, board=%s)" % (cid, res["result"], decision["status"], r))
    return 0


def cmd_receipt(argv):
    path, cid, res_path = argv[0], argv[1], argv[2]
    extra = argv[3] if len(argv) > 3 else ""
    res = parse_result(open(res_path, encoding="utf-8", errors="replace").read() if os.path.exists(res_path) else "")
    stamp = datetime.datetime.now().strftime("%m-%d %H:%M")
    line = "%s 结果=%s 卡=%s；说明=%s" % (stamp, res["result"], cid or "无", (res["summary"] or extra)[:160])

    def m(board):
        now = int(time.time() * 1000)
        r = next((c for c in board.get("cards", []) if c.get("title") == RECEIPT_TITLE), None)
        if r is None:
            board.setdefault("cards", []).append({
                "id": "card-receipt-nightshift", "title": RECEIPT_TITLE, "status": "done",
                "tags": ["nightly", "auto"],   # 默认要能跑；不想跑的人显式加 hold
                "description": "夜间跑批（低谷+空闲）的可见回执，由扫描器自动维护；不要手工改。\n"
                               "最近 1 轮（新在上）：\n- " + line,
                "summary": line, "rationale": "让「昨晚跑批做了什么、为什么没做」一眼可见",
                "rejected": "无", "createdAt": now, "updatedAt": now})
            return True
        r["summary"] = line
        hist = [l for l in (r.get("description") or "").splitlines() if l.startswith("- ")]
        hist = (hist + ["- " + line])[-RECEIPT_KEEP:]
        r["description"] = "最近 %d 轮（新在上）：\n%s" % (len(hist), "\n".join(reversed(hist)))
        r["updatedAt"] = now
        return True

    print("receipt: %s (board=%s)" % (line[:90], mutate_board(path, m)))
    return 0


def cmd_triage(argv):
    path = argv[0] if argv else KANBAN_DEFAULT
    board = load_board(path)
    todos = [c for c in board.get("cards", []) if c.get("status") == "todo"]
    runnable = [c for c in todos if eligible(c) and not is_decision(c)]
    decisions = [c for c in todos if eligible(c) and is_decision(c)]
    held = [c for c in todos if not eligible(c)]
    print("# 可跑性报告 %s（看板 %s）" % (datetime.datetime.now().strftime("%F %T"), path))
    print("todo=%d 可跑=%d 需你拍板(暂不跑)=%d 已hold=%d" % (len(todos), len(runnable), len(decisions), len(held)))
    for label, group in (("可跑", runnable), ("需拍板", decisions), ("已hold", held)):
        for c in group:
            print("  [%s] %-54s tags=%s" % (label, c["title"][:54], ",".join(c.get("tags") or [])))
    return 0


def cmd_repo_state(argv):
    """打印每个 git 仓库的 HEAD + working tree 指纹（跑批前后对比，侦测主检出是否被改动）。

    参数可以是项目名（查特性登记表 .repos.json）或主检出路径。
    --strict：任何一个仓库解析失败就返回 2；跑批守卫必须用 strict，绝不允许“配置写错 ⇒ 守卫静默失效”。
    """
    strict = "--strict" in argv
    repos = [a for a in argv if a != "--strict"]
    out = {}
    unresolved = []
    for name in repos:
        repo = _repo_path(name)
        if not repo:
            unresolved.append(name)
            continue

        def git(*a):
            try:
                return subprocess.run(["git", "-C", repo, *a], capture_output=True,
                                      text=True, timeout=30).stdout
            except Exception:
                return ""
        st = git("status", "--porcelain=v1", "--untracked-files=all")
        ignore = [p.strip() for p in os.environ.get("NIGHTSHIFT_GUARD_IGNORE", "KANBAN.json").split(",") if p.strip()]
        paths = sorted(l[:140] for l in st.splitlines()
                       if l.strip() and not any(ig in l for ig in ignore))
        out[repo] = {"head": git("rev-parse", "HEAD").strip()[:12], "paths": paths}
    if unresolved:
        print("repo-state: 无法解析仓库：%s（用 feature repo list 看项目名）" % ",".join(unresolved),
              file=sys.stderr)
        print(json.dumps(out, ensure_ascii=False))
        return 2 if strict else 0
    print(json.dumps(out, ensure_ascii=False))
    return 0


def cmd_repo_path(argv):
    """项目名/路径 → 主检出绝对路径（给 shell 沙箱拼 bwrap 参数用）。"""
    if len(argv) < 1:
        print("用法: repo-path <项目名|路径>", file=sys.stderr); return 2
    p = _repo_path(argv[0])
    if not p:
        print("repo-path: 无法解析 %s" % argv[0], file=sys.stderr); return 1
    print(p)
    return 0


def cmd_repo_diff(argv):
    """比较两次 repo-state JSON，分出 HEAD 变化与 dirty 路径变化（守卫分级用）。"""
    if len(argv) < 2:
        print("用法: repo-diff <BEFORE_JSON> <AFTER_JSON>", file=sys.stderr); return 2
    try:
        a = json.loads(argv[0]); b = json.loads(argv[1])
    except Exception as e:
        print("repo-diff: JSON 解析失败：%s" % e, file=sys.stderr); return 2
    out = {"head_changed": [], "paths_added": {}, "paths_removed": {}, "changed": False}
    for repo in sorted(set(a) | set(b)):
        x = a.get(repo) or {}; y = b.get(repo) or {}
        if x.get("head") != y.get("head"):
            out["head_changed"].append(repo)
        px = set(x.get("paths") or []); py = set(y.get("paths") or [])
        if py - px:
            out["paths_added"][repo] = sorted(py - px)[:20]
        if px - py:
            out["paths_removed"][repo] = sorted(px - py)[:20]
    out["changed"] = bool(out["head_changed"] or out["paths_added"] or out["paths_removed"])
    print(json.dumps(out, ensure_ascii=False))
    return 0


def recent_active_sessions(minutes=15.0):
    """最近 N 分钟内活动过（写入过）的会话数——用于侦测"会话风暴"（昨天那次是一分钟十几个）。

    必须看**会话日志文件**的 mtime：目录 mtime 只在增删文件时变，追加日志不会改它
    （第一版写成目录，结果恒为 0，等于熔断永不触发）。
    """
    cutoff = time.time() - minutes * 60
    n = 0
    for p in glob.glob(SESSIONS_GLOB):
        try:
            if os.path.getmtime(p) > cutoff:
                n += 1
        except OSError:
            pass
    return n


def _runs_dir():
    return os.environ.get("NIGHTSHIFT_RUNS_DIR") or os.path.join(RUNTIME_DIR, "runs")


def recent_runs(minutes=15.0):
    """最近 N 分钟内**跑批实际启动**的次数（数 runs/*.out 的 mtime）。

    为什么不再数"活动会话"：那会把用户/其它会话的正常使用误判成风暴
    （2026-10-22 23:45 就是这样误停的：13 个会话 > 阈值 10，其实没有任何 worker 风暴）。
    """
    cutoff = time.time() - minutes * 60
    n = 0
    for p in glob.glob(os.path.join(_runs_dir(), "*.out")):
        try:
            if os.path.getmtime(p) > cutoff:
                n += 1
        except OSError:
            pass
    return n


def active_workers():
    """正在跑的 worker 数（slots/ 里 pid 存活的个数）。"""
    d = os.environ.get("NIGHTSHIFT_SLOTS_DIR") or os.path.join(RUNTIME_DIR, "slots")
    n = 0
    try:
        for name in os.listdir(d):
            pf = os.path.join(d, name, "pid")
            try:
                pid = int(open(pf).read().strip())
                os.kill(pid, 0)
                n += 1
            except Exception:
                pass
    except OSError:
        pass
    return n


def cmd_storm_check(argv):
    """熔断判据（机械）：最近 N 分钟内活动过的会话数超过阈值 ⇒ 判为疑似会话风暴，拒绝开工。

    这是"一定不要再出现拼命开会话烧 token"的最后一道机械保险：
    即使闸门、预算、冷却、锁全被绕过，只要机器上正在疯狂产生会话，跑批就拒绝参与并自动暂停。
    """
    minutes = float(argv[0]) if len(argv) > 0 else 15.0
    limit = int(argv[1]) if len(argv) > 1 else 10
    runs = recent_runs(minutes)
    workers = active_workers()
    max_workers = int(os.environ.get("NIGHTSHIFT_MAX_WORKERS") or 5)
    if runs > limit:
        print("STORM 最近 %.0f 分钟内产生 %d 次跑批（阈值 %d）——疑似风暴" % (minutes, runs, limit))
        return 1
    if workers > max_workers * 2:
        print("STORM 当前 %d 个 worker 在跑（上限 %d）——疑似风暴" % (workers, max_workers * 2))
        return 1
    print("OK 最近 %.0f 分钟跑批 %d 次 / 并行 worker %d 个（阈值 %d）" % (minutes, runs, workers, limit))
    return 0


def _boards_from_env():
    """需要跨板查找的看板列表：只从 NIGHTSHIFT_BOARDS 读，绝不写死主机路径。"""
    raw = os.environ.get("NIGHTSHIFT_BOARDS", "").strip()
    return [b for b in re.split(r"[,\s]+", raw) if b]


def _feature_cards(feature):
    """某特性的全部卡片（按会话关联 → 卡片的 sourceSessionId 反查）。"""
    import glob as _g
    sids = set()
    for f in _g.glob(os.path.join(FEATURES_ROOT, ".sessions", "*.json")):
        try:
            d = json.load(open(f, encoding="utf-8"))
            if (d.get("feature") or d.get("name")) == feature:
                sids.add(os.path.basename(f)[:-5])
        except Exception:
            pass
    cards = []
    for board in _boards_from_env():
        try:
            for c in (json.load(open(board, encoding="utf-8")).get("cards") or []):
                sid = c.get("sourceSessionId") or ""
                if sid in sids or (c.get("feature") == feature):
                    cards.append((board, c))
        except Exception:
            pass
    return cards


def cmd_backfill_worker_sessions(argv):
    """把 runs/*.out 里的 sessionId 回填到卡片的 workerSessionId（幂等）。

    为什么要它：worker 是 `dsh --json` 启的，会话 id 只在它自己 stdout 里；
    runner 没回填 ⇒ 面板「打开处理会话」按钮用不了。这里从 journal 反推，零 token。
    用法：backfill-worker-sessions [--dry]
    """
    dry = "--dry" in argv
    runs = _runs_dir()
    import glob as _g, re as _re
    # card_id -> session_id（同卡多次取最新）
    found = {}
    for p in sorted(_g.glob(os.path.join(runs, "*.out"))):
        base = os.path.basename(p)
        m = _re.search(r"(card-[0-9a-f]{8})", base)
        if not m:
            continue
        try:
            head = open(p, encoding="utf-8", errors="ignore").read(20000)
        except OSError:
            continue
        sm = _re.search(r'"sessionId"\s*:\s*"(session-[0-9a-f-]+)"', head)
        if sm:
            found[m.group(1)] = sm.group(1)
    n = 0
    for board in _boards_from_env():
        try:
            d = json.load(open(board, encoding="utf-8"))
        except Exception:
            continue
        for c in d.get("cards") or []:
            cid = (c.get("id") or "")[:16]
            sid = found.get(cid) or next((v for k, v in found.items() if (c.get("id") or "").startswith(k)), None)
            if sid and not c.get("workerSessionId"):
                c["workerSessionId"] = sid
                n += 1
        if not dry:
            json.dump(d, open(board, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(("%s回填 %d 张卡的 workerSessionId（共找到 %d 个会话）" % ("(dry) " if dry else "", n, len(found))))
    return 0


def cmd_feature_finish(argv):
    """特性收尾：所有卡 done ⇒ 合入父分支(main) ⇒ 产出架构级汇报。

    用法：feature-finish <特性名> [--dry] [--no-push]
    判据（机械）：该特性下**没有任何** todo/in_progress/review 卡；否则拒绝并列出来。
    """
    if not argv:
        print("用法: feature-finish <特性名> [--dry] [--no-push]", file=sys.stderr); return 2
    feature = argv[0]
    dry = "--dry" in argv
    push = "--no-push" not in argv
    fj = _feature_json(feature)
    title = (fj or {}).get("title") or feature
    cards = _feature_cards(feature)
    if not cards:
        print("✗ 找不到该特性的卡片（无法判断完成度）⇒ 拒绝合入")
        print("  排查：feature context %s 看会话关联；或卡片的 sourceSessionId 是否指向该特性的会话" % feature)
        return 2
    blocked = [(b, c) for b, c in cards if c.get("status") != "done"]
    report_dir = os.path.join(RUNTIME_DIR, "feature-reports")
    os.makedirs(report_dir, exist_ok=True)
    rp = os.path.join(report_dir, "%s-%s.md" % (feature, time.strftime("%Y%m%d-%H%M")))
    lines = ["# 特性收尾汇报：%s（%s）" % (title, feature), "",
             "- 时间：%s" % time.strftime("%F %T"), "- 卡片：%d 张" % len(cards)]
    if blocked:
        lines += ["", "## ✗ 未完成（拒绝合入）", ""]
        for b, c in blocked:
            lines.append("- [%s] %s（%s）" % (c.get("status"), c.get("title", "")[:60], c.get("id", "")[:16]))
        open(rp, "w", encoding="utf-8").write("\n".join(lines) + "\n")
        print("✗ 该特性还有 %d 张卡未完成，不执行合入：" % len(blocked))
        for b, c in blocked[:10]:
            print("  [%s] %s" % (c.get("status"), c.get("title", "")[:64]))
        print("  报告：%s" % rp)
        return 1
    # 合入父分支（feature recycle 内部：主检出切 main → merge --no-ff feat/<name> → 标记 recycled）
    cmd = [_feature_bin() or "feature",
           "recycle", feature, "--yes"] + (["--push"] if push else [])
    repo_diff = {}
    for proj, info in ((fj or {}).get("repos") or {}).items():
        try:
            repo = info.get("repo"); br = info.get("branch")
            st = subprocess.run(["git", "-C", repo, "diff", "--stat", "main...%s" % br],
                                capture_output=True, text=True, timeout=60)
            cnt = subprocess.run(["git", "-C", repo, "rev-list", "--count", "main..%s" % br],
                                 capture_output=True, text=True, timeout=60)
            repo_diff[proj] = {"stat": (st.stdout or "").strip().splitlines(), "commits": (cnt.stdout or "").strip()}
        except Exception as e:
            repo_diff[proj] = {"error": str(e)}
    lines += ["", "## 代码变更", ""]
    for proj, d in repo_diff.items():
        lines.append("### %s（%s 个提交）" % (proj, d.get("commits", "?")))
        for ln in (d.get("stat") or [])[-10:]:
            lines.append("```text\n%s\n```" % ln if False else "- `%s`" % ln)
    if dry:
        lines += ["", "## 合入命令（dry-run 未执行）", "```bash", " ".join(cmd), "```"]
        open(rp, "w", encoding="utf-8").write("\n".join(lines) + "\n")
        from collections import Counter
    print("（dry）卡片 %d 张，状态分布 %s" % (len(cards), dict(Counter(c.get("status") for _, c in cards))))
    print("（dry）将执行：%s" % " ".join(cmd)); print("报告：%s" % rp); return 0
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    lines += ["", "## 合入结果", "```text", (r.stdout or "")[-1500:], (r.stderr or "")[-800:], "```"]
    ok = r.returncode == 0
    if ok:
        lines += ["", "## 目标达成（按卡片的判据汇总）", ""]
        for b, c in cards:
            lines.append("- ✓ %s" % (c.get("title", "")[:70]))
    else:
        lines += ["", "## ✗ 合入失败（需人工）", "", "原因见上面的 stdout/stderr；未做任何强制操作。"]
    open(rp, "w", encoding="utf-8").write("\n".join(lines) + "\n")
    print(("✓ 已合入并生成汇报：%s" if ok else "✗ 合入失败（报告：%s）") % rp)
    return 0 if ok else 1


def cmd_confirm(argv):
    """人工确认一张「待审」卡 → 写结构化确认块 → 状态回 todo → 清尝试计数（零 token）。

    用法：
      confirm <BOARD> <CARD_ID> "<结论>" ["<执行要点>"] [--by <谁/哪个会话>] [--unhold] [--dry]

    为什么要有它（用户 2026-10-16 要求）：「待审」不能是黑洞——跑批送审时把问题写在卡里，
    人（或在会话里讨论后）给出结论，**结论必须落回卡片本身**，下一个 worker 才不会再问同一个问题。
    所以这里做三件事，且都是机械的：
      1. 把结论写成 `【确认 <时间> · by <谁>】结论/执行要点` 追加进 description（worker 的提示词
         明确要求：见到确认块就照办，不得就同一问题再送审）；
      2. 状态回 `todo`（除 `--dry`）；
      3. 清掉 attempts 计数（否则那张卡的历史失败次数会立刻把它再次推进待审）。
    额外规矩：卡上带 `hold` 时默认**保留** hold 并提示"跑批不会自动捡它"，要放行必须显式 `--unhold`
    （hold=绝不允许无人值守动，这是安全默认，不能被"确认"顺手推翻）。
    """
    if len(argv) < 3:
        print("用法: confirm <BOARD> <CARD_ID> \"<结论>\" [\"<执行要点>\"] [--by X] [--unhold] [--dry]",
              file=sys.stderr)
        return 2
    dry = "--dry" in argv
    unhold = "--unhold" in argv
    close_it = "--done" in argv   # 人审结论是"归档/判完成"时直接置 done（否则回 todo 等跑批）
    by = ""
    rest = []
    i = 0
    while i < len(argv):
        if argv[i] == "--by":
            by = argv[i + 1] if i + 1 < len(argv) else ""
            i += 2
        elif argv[i].startswith("--"):
            i += 1
        else:
            rest.append(argv[i]); i += 1
    if len(rest) < 3:
        print("用法: confirm <BOARD> <CARD_ID> \"<结论>\" [\"<执行要点>\"]", file=sys.stderr)
        return 2
    board_path, cid, decision = rest[0], rest[1], rest[2]
    detail = rest[3] if len(rest) > 3 else ""
    stamp = datetime.datetime.now().strftime("%F %H:%M")

    board = load_board(board_path)
    card = _find(board, cid)
    if card is None:
        print("找不到卡：%s" % cid, file=sys.stderr); return 1
    if card.get("status") != "review":
        print("拒绝：这张卡当前是 %s，只有「待审」的卡需要确认（不要绕过讨论直接推它）" % card.get("status"),
              file=sys.stderr); return 1
    if len(decision.strip()) < 8:
        print("拒绝：结论太短（至少 8 个字）。写清你拍的是什么，下一个 worker 才能照着做。", file=sys.stderr)
        return 1

    block = ["", "【确认 %s · by %s】" % (stamp, by or "发起人"),
             "结论：%s" % decision.strip()]
    if detail.strip():
        block.append("执行要点：%s" % detail.strip())
    block.append("（本条是人工确认：worker 不得就同一问题再次送审；确有必要时另立卡或写清新问题。）")
    tags = [t.lower() for t in (card.get("tags") or [])]
    held = "hold" in tags
    if held and not unhold:
        block.append("（注意：本卡仍带 hold，跑批不会自动捡它；要放行请在面板勾选「同时解除 hold」或加 --unhold。）")
    if unhold and held:
        block.append("（本次已按请求移除 hold 标签，跑批可以捡它了。）")

    if dry:
        print("DRY：将把 %s 从 review 改为 todo，并追加：\n%s" % (cid, "\n".join(block)))
        return 0

    def mutate(b):
        c = _find(b, cid)
        if c is None:
            return False
        c["description"] = (c.get("description") or "").rstrip() + "\n".join(block) + "\n"
        c["status"] = "done" if close_it else "todo"
        if close_it:
            c["summary"] = (c.get("summary") or "") + "人审批准（%s）：%s" % (stamp, decision.strip()[:300])
        # 注意：必须在 mutate 内改标签——mutate_board 会重读看板再套用本函数，
        # 在外层改读出来的副本会被丢弃（第一版就踩了这个坑：--unhold 静默无效）。
        if unhold:
            c["tags"] = [t for t in (c.get("tags") or []) if t.lower() != "hold"]
        c["updatedAt"] = int(time.time() * 1000)
        return True

    r = mutate_board(board_path, mutate)
    if r == "ok":
        set_attempt(cid, 0)          # 清历史失败计数，否则会立刻再被推进待审
    print("confirm %s -> %s (board=%s%s)" % (cid, "done" if close_it else "todo", r, "，已解除 hold" if (unhold and held) else ""))
    return 0 if r == "ok" else 1


PRICE = {"cache": 0.02, "unc": 1.0, "out": 4.0}   # 元/百万 token（DeepSeek 低谷价）


def day_cost(day=None):
    """今天（或指定 YYYYMMDD）跑批的花费估算：扫 runs/<day>-*.transcript.jsonl 里的 usage。

    为什么要按"钱"而不是只按"张数"封顶（2026-10-16 加）：实测每张卡的成本差异极大
    （轻卡 ≈0.05 元，重的开发卡 ≈0.3–0.5 元；当天 10 轮共 ≈2.85 元，其中输出 token 占 1.63 元）。
    只数张数会让"重卡日"的花费失控。
    """
    day = day or datetime.datetime.now().strftime("%Y%m%d")
    runs_dir = os.path.join(RUNTIME_DIR, "runs")
    tot = {"unc": 0, "cache": 0, "out": 0}
    files = 0
    for path in glob.glob(os.path.join(runs_dir, "%s-*.transcript.jsonl" % day)):
        files += 1
        try:
            fh = open(path, encoding="utf-8", errors="replace")
        except OSError:
            continue
        with fh:
            for line in fh:
                try:
                    u = (json.loads(line).get("data") or {}).get("usage")
                except Exception:
                    continue
                if not u:
                    continue
                tot["unc"] += u.get("inputTokens", 0) or 0
                tot["cache"] += u.get("cacheReadTokens", 0) or 0
                tot["out"] += u.get("outputTokens", 0) or 0
    cost = sum(tot[k] / 1e6 * PRICE[k] for k in tot)
    return cost, tot, files


def cmd_day_cost(argv):
    day = argv[0] if argv and argv[0] and not argv[0].startswith("-") else None
    cost, tot, files = day_cost(day)
    print("COST=%.4f UNC=%d CACHE=%d OUT=%d RUNS=%d DAY=%s"
          % (cost, tot["unc"], tot["cache"], tot["out"], files, day or today_key().replace("-", "")))
    return 0


def cmd_confirm_recommended(argv):
    """把当前所有「带审批单的待审卡」按其**推荐选项**一键批准（结论仍逐张写回卡里）。

    这是审批窗口的「全部按推荐批准」钮的内核：复用 cmd_confirm 的同一条路径
    （写【确认】块 → 状态回 todo → 清 attempts），所以批量与单张的语义完全一致。
    """
    board_path = argv[0] if argv else KANBAN_DEFAULT
    dry = "--dry" in argv
    by = "审批窗口-按推荐"
    for i, a in enumerate(argv):
        if a == "--by" and i + 1 < len(argv):
            by = argv[i + 1]
    board = load_board(board_path)
    done = skipped = 0
    for c in [x for x in board.get("cards", []) if x.get("status") == "review"]:
        desc = c.get("description") or ""
        opts = [l.strip() for l in desc.splitlines() if l.strip().startswith("- O")]
        rec = [l for l in opts if "推荐" in l] or opts[:1]
        # 2026-11-10：审批窗口对「没有审批单」的 review 卡也显示「全部按推荐批准」。
        # 以前这里静默跳过 ⇒ 按钮看起来无效。没有审批单时退化为单卡一键放行
        # （与卡上「审核通过（回待办）」完全同一结论；hold 仍保留，除非显式 --unhold）。
        if "【审批单 · explain-plain】" not in desc or not rec:
            decision = "审核通过（按卡内推荐执行）"
            detail = "人审通过 ⇒ 回到待办，由后续轮次按卡内推荐执行"
            if dry:
                print("DRY  %-20s ← %s" % (c["id"][:20], decision))
                continue
            rc = cmd_confirm([board_path, c["id"], decision, detail, "--by", by])
            if rc == 0:
                done += 1
            else:
                skipped += 1
            continue
        text = rec[0]
        m = re.match(r"-\s*(O\d+)[：:]\s*(.*)$", text)
        label = m.group(1) if m else "O1"
        body = m.group(2).split("｜")[0].strip() if m else text
        decision = "采用 %s：%s（按审批单推荐方案自动批准）" % (label, body)
        if dry:
            print("DRY  %-20s ← %s" % (c["id"][:20], decision[:70]))
            continue
        extra = ["--done"] if "动作：done" in text or "动作:done" in text else []
        rc = cmd_confirm([board_path, c["id"], decision, "按审批单的推荐方案执行", "--by", by] + extra)
        if rc == 0:
            done += 1
        else:
            skipped += 1
    print("按推荐批准：成功 %d 张，跳过 %d 张（%s）" % (done, skipped, "dry-run" if dry else board_path))
    return 0


FEATURES_ROOT = os.environ.get("FEATURE_ROOT") or os.path.expanduser("~/features")


def _sid_of(card):
    return (card or {}).get("sourceSessionId") or ""


def _assoc_path_for_session(sid):
    """会话关联文件路径（feature 工具写的 FEATURE_ROOT/.sessions/sid.json）。"""
    if not sid:
        return None
    return os.path.join(FEATURES_ROOT, ".sessions", "%s.json" % sid)


def _repos_file():
    return os.environ.get("NIGHTSHIFT_REPOS_FILE") or os.path.join(FEATURES_ROOT, ".repos.json")


def _load_repos():
    try:
        with open(_repos_file(), encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _repo_meta(value):
    """登记表值：兼容旧的字符串路径与新的 {path, baseBranch, remote} 对象。"""
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        return {"path": value}
    return {}


def _repo_path(name_or_path):
    """项目名或主检出路径 → 绝对路径；无法解析返回 None。"""
    if not name_or_path:
        return None
    cand = os.path.abspath(os.path.expanduser(name_or_path))
    if os.path.isdir(os.path.join(cand, ".git")) or os.path.isfile(os.path.join(cand, ".git")):
        return cand
    meta = _repo_meta(_load_repos().get(name_or_path))
    p = meta.get("path")
    if p:
        p = os.path.abspath(os.path.expanduser(p))
        if os.path.isdir(os.path.join(p, ".git")) or os.path.isfile(os.path.join(p, ".git")):
            return p
    return None


def _base_branch(project):
    """基准分支：env NIGHTSHIFT_BASE_BRANCH > 登记表 baseBranch > origin/HEAD > main/master。"""
    env = os.environ.get("NIGHTSHIFT_BASE_BRANCH", "").strip()
    if env:
        return env
    meta = _repo_meta(_load_repos().get(project))
    if meta.get("baseBranch"):
        return str(meta["baseBranch"]).strip()
    repo = _repo_path(project)
    if repo:
        try:
            r = subprocess.run(["git", "-C", repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
                               capture_output=True, text=True, timeout=15)
            if r.returncode == 0 and r.stdout.strip():
                return r.stdout.strip().split("/")[-1]
        except Exception:
            pass
        for b in ("main", "master"):
            try:
                r = subprocess.run(["git", "-C", repo, "show-ref", "--verify", "--quiet", "refs/heads/" + b],
                                   timeout=15)
                if r.returncode == 0:
                    return b
            except Exception:
                pass
    return "main"


def _project_name(name_or_path):
    """路径 → 项目名；找不到就原样返回（可能本来就是项目名）。"""
    if not name_or_path:
        return ""
    want = os.path.abspath(os.path.expanduser(name_or_path))
    for name, value in _load_repos().items():
        p = _repo_meta(value).get("path")
        if p and os.path.abspath(os.path.expanduser(p)) == want:
            return name
    return name_or_path


def _auto_project():
    """自动特性的工程：显式 NIGHTSHIFT_AUTO_PROJECT > 守卫列表第一项 > 空。"""
    explicit = os.environ.get("NIGHTSHIFT_AUTO_PROJECT", "").strip()
    if explicit:
        return explicit
    guard = os.environ.get("NIGHTSHIFT_GUARD_REPOS", "").strip()
    if guard:
        return _project_name(guard.split(",")[0].strip())
    return ""


def _feature_json(feature):
    try:
        with open(os.path.join(FEATURES_ROOT, feature, "feature.json"), encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _feature_status(feature):
    return _feature_json(feature).get("status") or ""


def _feature_projects(feature):
    data = _feature_json(feature)
    repos = data.get("repos") or {}
    if isinstance(repos, dict) and repos:
        return sorted(repos.keys())
    proj = (data.get("project") or "").strip()
    return [proj] if proj else []


def _feature_worktree(feature, project):
    data = _feature_json(feature)
    repos = data.get("repos") or {}
    if isinstance(repos, dict):
        info = repos.get(project) or {}
        if isinstance(info, dict) and info.get("path"):
            return info["path"]
    return os.path.join(FEATURES_ROOT, feature, project)


def _feature_counts_as_usable(feature, project):
    st = _feature_status(feature)
    if st != "active":
        return False, "特性 %s 状态=%s（不是 active）" % (feature, st or "缺失")
    wt = _feature_worktree(feature, project)
    if not os.path.isdir(wt) or os.path.islink(wt):
        return False, "特性 %s/%s 的 worktree 不可用：%s" % (feature, project, wt)
    return True, ""


def _write_assoc(sid, feature, project, worktree):
    path = _assoc_path_for_session(sid)
    if not path:
        return False
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = "%s.tmp.%d" % (path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump({"session": sid, "feature": feature, "project": project, "worktree": worktree,
                   "attachedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "attachedCwd": worktree},
                  fh, ensure_ascii=False, indent=1)
    os.replace(tmp, path)
    return True


def _feature_bin():
    """feature 可执行体：显式 env > PATH > 仓库内自带（npm 包布局）。"""
    explicit = os.environ.get("NIGHTSHIFT_FEATURE_BIN", "").strip()
    if explicit:
        return explicit
    found = shutil.which("feature")
    if found:
        return found
    bundled = os.path.join(CODE_DIR, "..", "feature-worktrees", "feature")
    if os.path.exists(bundled):
        return bundled
    return "feature"


def _feature_env():
    """feature 子进程环境：去掉 DSH_SESSION_ID，避免把“跑批进程”误关联到特性。"""
    env = os.environ.copy()
    env.pop("DSH_SESSION_ID", None)
    env.setdefault("FEATURE_ROOT", FEATURES_ROOT)
    return env


def _choose_auto_slug(sid, project):
    """auto 特性名：优先复用 active，绝不复用 recycled/closed；墓碑可清理后复用。"""
    base = "ns-auto-%s" % sid.replace("session-", "")[:8]
    for slug in [base] + ["%s-%d" % (base, i) for i in range(2, 7)]:
        path = os.path.join(FEATURES_ROOT, slug)
        if not os.path.exists(path):
            return slug, ""
        st = _feature_status(slug)
        if st == "active":
            ok, why = _feature_counts_as_usable(slug, project)
            return (slug, "") if ok else ("", "AUTO_FEATURE 同名特性不可用：%s" % why)
        if st in ("recycled", "closed"):
            continue
        if not os.path.exists(os.path.join(path, "feature.json")):
            return slug, "tombstone"
        return "", "AUTO_FEATURE 同名特性状态未知：%s" % (st or "?")
    return "", "AUTO_FEATURE 候选名全部占用（%s-2..6）" % base


def _ensure_feature(slug, project, allow_create=True, dry_run=False):
    """确保特性可用；不删 active，不碰 recycled（换名由调用方处理）。"""
    if not allow_create:
        ok, why = _feature_counts_as_usable(slug, project)
        return (slug, "") if ok else ("", why)
    path = os.path.join(FEATURES_ROOT, slug)
    if os.path.exists(os.path.join(path, "feature.json")):
        st = _feature_status(slug)
        if st == "recycled":
            return "", "特性 %s 已回收，不能复用；请换名" % slug
        ok, why = _feature_counts_as_usable(slug, project)
        if ok:
            return slug, ""
        if st == "active" and not os.path.isdir(_feature_worktree(slug, project)):
            return "", why + "（active 但 worktree 缺失；不自动重建，请人工处理）"
        return "", why
    if os.path.exists(path):
        # 只有目录、没有 feature.json：旧的 close 墓碑；prune --purge 只清记录，不动主检出
        if dry_run:
            return slug, ""
        r = subprocess.run([_feature_bin(), "prune", slug, "--purge", "--yes"],
                           capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            return "", "清理同名墓碑失败：%s" % (r.stdout or r.stderr or "").strip()[:160]
    if dry_run:
        return slug, ""
    # 不把当前会话关联到 auto 特性；关联由 _write_assoc 写源会话
    r = subprocess.run([_feature_bin(), "ensure", slug, "--repos", project],
                       capture_output=True, text=True, timeout=180, env=_feature_env())
    if r.returncode != 0:
        return "", "feature ensure 失败（%s/%s）：%s" % (slug, project, (r.stdout or r.stderr or "").strip()[:200])
    ok, why = _feature_counts_as_usable(slug, project)
    if not ok:
        return "", why
    return slug, ""


def _worker_slug_for_card(card, project):
    """worker 特性名：优先复用 active；recycled/closed 换 -2..-6；墓碑可清理后复用。"""
    cid = (card or {}).get("id") or ""
    base = "ns-" + cid.replace("card-", "")[:12]
    have = (card or {}).get("workerSlug") or ""
    if have:
        ok, why = _feature_counts_as_usable(have, project)
        if ok:
            return have, ""
        if _feature_status(have) == "active":
            return "", "worker 特性 active 但 worktree 不可用：%s" % why
    for slug in [base] + ["%s-%d" % (base, i) for i in range(2, 7)]:
        path = os.path.join(FEATURES_ROOT, slug)
        if not os.path.exists(path):
            return slug, ""
        st = _feature_status(slug)
        if st == "active":
            ok, why = _feature_counts_as_usable(slug, project)
            return (slug, "") if ok else ("", "worker 特性不可用：%s" % why)
        if st in ("recycled", "closed"):
            continue
        if not os.path.exists(os.path.join(path, "feature.json")):
            return slug, ""
        return "", "worker 特性状态未知：%s" % (st or "?")
    return "", "worker 候选名全部占用（%s-2..6）" % base


def _source_worktree(card, allow_create=False):
    """卡片 → 源 worktree。默认只读；allow_create=True 才允许 AUTO_FEATURE 建/清理。

    重要：dry-run（prep-worktree 无 --go）必须零副作用，所以 allow_create=False 时不建特性。
    """
    # 并行模式：父进程已解析好源 worktree 并通过 env 注入 ⇒ 直接用，**不读**那个会被并发改写的关联文件
    env_wt = os.environ.get("NIGHTSHIFT_SOURCE_WORKTREE", "").strip()
    if env_wt:
        proj = os.environ.get("NIGHTSHIFT_SOURCE_PROJECT", "").strip()
        feature = os.environ.get("NIGHTSHIFT_SOURCE_FEATURE", "").strip()
        if not proj and feature:
            projs = _feature_projects(feature)
            proj = projs[0] if projs else ""
        return ({"session": os.environ.get("NIGHTSHIFT_SOURCE_SESSION", ""),
                 "feature": feature, "project": proj, "worktree": env_wt}, "")
    sid = card.get("sourceSessionId")
    if not sid:
        return None, "E_NO_SOURCE 卡片没有 sourceSessionId（无法确定代码该提交到哪个 worktree）"
    assoc_path = _assoc_path_for_session(sid)
    if os.path.exists(assoc_path):
        try:
            with open(assoc_path, encoding="utf-8") as fh:
                a = json.load(fh)
        except Exception as e:
            return None, "E_ASSOC_BAD 读源会话关联失败：%s" % e
        feature = a.get("feature")
        project = a.get("project")
        if not feature or not project:
            return None, "E_ASSOC_INCOMPLETE 源会话关联文件缺 feature/project：%s" % assoc_path
        ok, why = _feature_counts_as_usable(feature, project)
        if not ok:
            # P2-ASSOC-HOLD（2026-11-04）：源特性缺失 ⇒ 这张卡每次被领都会失败。
            # 在这里就把 hold 打上并写清原因，停止空转；人修好关联后去掉 hold 即可。
            try:
                def _fix(bd):
                    cc = _find(bd, card["id"])
                    if cc is None:
                        return False
                    tags = list(cc.get("tags") or [])
                    if "hold" not in [t.lower() for t in tags]:
                        tags.append("hold")
                        cc["tags"] = tags
                        cc["description"] = (cc.get("description") or "").rstrip() + (
                            "\n【自动止血 %s】源特性缺失（%s）⇒ 已加 hold 停止空转；请 feature attach 后去掉 hold。\n"
                            % (time.strftime("%Y-%m-%d %H:%M"), (why or "")[:80]))
                        cc["updatedAt"] = int(time.time() * 1000)
                    return True
                mutate_board(board_path or KANBAN_DEFAULT, _fix)
            except Exception:
                pass
            return None, "E_ASSOC_STALE %s；请重新 feature attach <特性名>（或删掉该关联后重跑）" % why
        wt = _feature_worktree(feature, project)
        return {"session": sid, "feature": feature, "project": project, "worktree": wt}, ""
    if os.environ.get("NIGHTSHIFT_AUTO_FEATURE", "0") not in ("1", "true", "yes"):
        return None, ("E_NO_FEATURE 源会话 %s 没有关联任何特性；先 feature attach/ensure，"
                      "或开 NIGHTSHIFT_AUTO_FEATURE=1" % sid)
    project = _auto_project()
    if not _repo_path(project):
        return None, "E_PROJECT_UNKNOWN 自动特性工程 %s 未登记（feature repo list）" % project
    # 先看有没有 active 的候选；有就直接复用（不需要 allow_create）
    slug, why = _choose_auto_slug(sid, project)
    if not slug:
        return None, "E_FEATURE_CONFLICT " + why
    if not allow_create:
        return None, "E_DRY_RUN 将自动创建/复用特性 %s（%s）；加 --go 才执行" % (slug, project)
    slug, why = _ensure_feature(slug, project, allow_create=True)
    if not slug:
        return None, "E_FEATURE_ENSURE " + why
    wt = _feature_worktree(slug, project)
    _write_assoc(sid, slug, project, wt)
    print("AUTO_FEATURE 已为源会话 %s 准备特性 %s（工程 %s，worktree %s）" % (sid, slug, project, wt))
    return {"session": sid, "feature": slug, "project": project, "worktree": wt}, ""


def _feature_has_pending(board_path, sid):
    """该源会话名下的卡是否还有未结算的（todo/in_progress）⇒ 有则返回说明串，没有则返回 ''。

    用途：merge-back 决定能不能把源特性回收进主分支（提前回收会让后续卡找不到源 worktree）。
    """
    if not sid:
        return "源会话未知（不敢自动回收）"
    try:
        cards = (load_board(board_path) or {}).get("cards", [])
    except Exception as e:
        return "读看板失败：%s" % e
    pend = [c.get("id") for c in cards
            if c.get("sourceSessionId") == sid and c.get("status") in ("todo", "in_progress")]
    if pend:
        return "%d 张：%s" % (len(pend), ",".join(pend[:3]))
    return ""

def cmd_orphan_list(argv):
    """打印"处于 in_progress 但没有任何活 worker 在做"的卡 id（每行一个）。

    判据：扫 /proc/*/cmdline，若没有任何进程命令行里含该卡 id，就认定它没有活 worker。
    """
    if not argv:
        print("用法: orphan-list <BOARD>", file=sys.stderr); return 2
    b = load_board(argv[0]) or {}
    out = []
    for c in b.get("cards", []):
        if c.get("status") != "in_progress":
            continue
        cid = c.get("id") or ""
        if not cid:
            continue
        alive = False
        for p in glob.glob("/proc/[0-9]*/cmdline"):
            try:
                with open(p, "rb") as fh:
                    if cid.encode() in fh.read():
                        alive = True
                        break
            except Exception:
                continue
        if not alive:
            out.append(cid)
    print("\n".join(out))
    return 0


def _dup_path():
    # 可用 NIGHTSHIFT_DUP_FILE 覆盖（测试密闭用；生产不设该变量）
    return os.environ.get("NIGHTSHIFT_DUP_FILE") or os.path.join(
        RUNTIME_DIR, "runs", ".fingerprints.json")


def _dup_load():
    try:
        with open(_dup_path(), encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {}


def _dup_save(d):
    p = _dup_path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(d, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, p)


def cmd_dup_check(argv):
    """指纹在 TTL 内出现过 ⇒ 退出码 0（= 重复，调用方应跳过 worker）；否则 1。

    TTL 由 NIGHTSHIFT_DUP_TTL_HOURS 控制（默认 6 小时；0 = 关闭防护）。
    为什么需要：2026-10-17 实测 52 次跑批里 49 次（94%）是同一张卡的逐字节重复
    （card-9921660a×28、card-63079402×23），纯属把钱重复烧掉。
    """
    if not argv:
        return 1
    try:
        ttl = float(os.environ.get("NIGHTSHIFT_DUP_TTL_HOURS", "6") or 0)
    except Exception:
        ttl = 6.0
    if ttl <= 0:
        return 1
    rec = _dup_load().get(argv[0])
    if not rec:
        return 1
    try:
        ts = float(rec.get("ts") or 0)
    except Exception:
        return 1
    return 0 if (time.time() - ts) <= ttl * 3600 else 1


def cmd_dup_record(argv):
    """记录一次"正常结束"的 worker 指纹（done/review 才记；失败/超时不记 ⇒ 可重试）。"""
    if len(argv) < 2:
        print("用法: dup-record <指纹> <卡id> [状态]", file=sys.stderr)
        return 2
    d = _dup_load()
    d[argv[0]] = {"card": argv[1], "status": argv[2] if len(argv) > 2 else "", "ts": time.time()}
    if len(d) > 500:                      # 只留最近 500 条，防文件无限长大
        for k, _ in sorted(d.items(), key=lambda kv: kv[1].get("ts", 0))[:len(d) - 500]:
            d.pop(k, None)
    _dup_save(d)
    print("dup-record %s card=%s -> ok" % (argv[0], argv[1]))
    return 0


def cmd_cost_report(argv):
    """成本与缓存报告（纯本地读 runs/*.transcript.jsonl，零 token）。

    用法：cost-report [YYYYMMDD|YYYY-MM-DD] [--by-card]
    """
    day = ""
    by_card = "--by-card" in argv
    for a in argv:
        if a.startswith("-"):
            continue
        if len(a) == 8 and a.isdigit():
            day = a
        elif len(a) == 10 and a[4] == "-" and a.replace("-", "").isdigit():
            day = a.replace("-", "")
    if not day:
        day = today_key().replace("-", "")
    runs = os.path.join(RUNTIME_DIR, "runs")
    files = sorted(glob.glob(os.path.join(runs, "%s-*.transcript.jsonl" % day)))
    tot = {"hit": 0, "miss": 0, "out": 0}
    per_card = {}
    seen = {}
    dups = 0
    used = 0
    for f in files:
        miss = hit = out = 0
        card = ""
        for line in open(f, encoding="utf-8", errors="ignore"):
            try:
                o = json.loads(line)
            except Exception:
                continue
            if not card:
                m = re.search(r"card-[0-9a-f]{8}", json.dumps(o, ensure_ascii=False))
                if m:
                    card = m.group(0)
            u = (o.get("data") or {}).get("usage")
            if not u:
                continue
            miss += u.get("inputTokens", 0) or 0
            hit += u.get("cacheReadTokens", 0) or 0
            out += u.get("outputTokens", 0) or 0
        if not (miss or hit or out):
            continue
        used += 1
        tot["hit"] += hit
        tot["miss"] += miss
        tot["out"] += out
        c = per_card.setdefault(card or "(未知卡)", {"hit": 0, "miss": 0, "out": 0, "runs": 0})
        c["hit"] += hit
        c["miss"] += miss
        c["out"] += out
        c["runs"] += 1
        key = (card, miss, hit, out)
        if key in seen:
            dups += 1
        else:
            seen[key] = 1
    inp = tot["hit"] + tot["miss"]
    cost = (tot["hit"] / 1e6 * PRICE["cache"] + tot["miss"] / 1e6 * PRICE["unc"]
            + tot["out"] / 1e6 * PRICE["out"])
    nocache = inp / 1e6 * PRICE["unc"] + tot["out"] / 1e6 * PRICE["out"]
    print("COST-REPORT day=%s runs=%d" % (day, used))
    print("  输入 %s  命中 %s（%.1f%%）  未命中 %s" % (f"{inp:,}", f"{tot['hit']:,}",
          (100.0 * tot["hit"] / inp if inp else 0.0), f"{tot['miss']:,}"))
    print("  输出 %s（输出占花费 %.1f%%）" % (f"{tot['out']:,}",
          (100.0 * tot["out"] / 1e6 * PRICE["out"] / cost if cost else 0.0)))
    print("  花费 %.4f 元 = 命中 %.4f + 未命中 %.4f + 输出 %.4f" % (
        cost, tot["hit"] / 1e6 * PRICE["cache"], tot["miss"] / 1e6 * PRICE["unc"],
        tot["out"] / 1e6 * PRICE["out"]))
    print("  疑似重复 run %d 个（占 %.0f%%）" % (dups, (100.0 * dups / used if used else 0.0)))
    if nocache:
        print("  缓存若完全失效需 %.2f 元（现省 %.0f%%）" % (nocache, 100.0 * (1 - cost / nocache)))
    if by_card:
        print("  ── 按卡（花费降序前 10）:")
        rows = sorted(per_card.items(), key=lambda kv: -(
            kv[1]["hit"] / 1e6 * PRICE["cache"] + kv[1]["miss"] / 1e6 * PRICE["unc"]
            + kv[1]["out"] / 1e6 * PRICE["out"]))
        for k, v in rows[:10]:
            cc = (v["hit"] / 1e6 * PRICE["cache"] + v["miss"] / 1e6 * PRICE["unc"]
                  + v["out"] / 1e6 * PRICE["out"])
            i2 = v["hit"] + v["miss"]
            print("     %-22s run=%-3d 命中率 %3.0f%%  输出占比 %3.0f%%  %.4f 元" % (
                k, v["runs"], (100.0 * v["hit"] / i2 if i2 else 0.0),
                (100.0 * v["out"] / 1e6 * PRICE["out"] / cc if cc else 0.0), cc))
    return 0


def cmd_card_status(argv):
    """打印某张卡的当前状态（给脚本用：比 grep NDJSON 可靠）。"""
    if len(argv) < 2:
        print("用法: card-status <BOARD> <CARD_ID>", file=sys.stderr); return 2
    c = _find(load_board(argv[0]), argv[1])
    if c is None:
        return 1
    print(c.get("status") or "")
    return 0


def cmd_fp(argv):
    """打印某张卡用于"重复 run 防护"的指纹。

    用法：fp <BOARD> <CARD_ID> <稳定头哈希>
    为什么要单独算：apply 每次都会往卡描述里追加【处理会话】【代码去向】等块 ⇒ 直接哈希提示词
    会导致指纹每次都变、防护永不触发（2026-10-17 A/B 实测到）。这里剔掉**我们自己追加的**块，
    只对"人可编辑的核心"取哈希；人工改标题/改核心描述仍会改变指纹（这是想要的语义）。
    """
    if len(argv) < 3:
        print("用法: fp <BOARD> <CARD_ID> <HEAD_HASH>", file=sys.stderr); return 2
    c = _find(load_board(argv[0]), argv[1])
    if c is None:
        return 1
    desc = c.get("description") or ""
    for marker in ("\n【处理会话", "\n【代码去向", "\n【跑批中断恢复", "\n【preflight"):
        i = desc.find(marker)
        if i != -1:
            desc = desc[:i]
    core = "\x1f".join([argv[1], c.get("title") or "", desc.strip(), c.get("sourceSessionId") or "", argv[2]])
    print(hashlib.sha1(core.encode()).hexdigest()[:16])
    return 0


def cmd_source_of(argv):
    """只读打印某张卡的源会话/特性/worktree（并行父进程用，零副作用）。

    用法：source-of <BOARD> <CARD_ID>
    """
    if len(argv) < 2:
        print("用法: source-of <BOARD> <CARD_ID>", file=sys.stderr); return 2
    card = _find(load_board(argv[0]), argv[1])
    if card is None:
        print("找不到卡：%s" % argv[1], file=sys.stderr); return 1
    src, why = _source_worktree(card)
    if src is None:
        print("SKIP %s" % why); return 1
    print("SESSION=%s" % src.get("session", ""))
    print("FEATURE=%s" % src.get("feature", ""))
    print("PROJECT=%s" % src.get("project", ""))
    print("WORKTREE=%s" % src.get("worktree", ""))
    return 0


def cmd_prep_worktree(argv):
    """给一张卡准备"独占 worktree"并打印 WORKDIR（默认 dry，只打印将执行的命令）。

    用法：prep-worktree <BOARD> <CARD_ID> [--go]
      · 无 --go：只解析与打印（零副作用，便于核对）
      · 有 --go：真正执行 feature ensure / feature new
    """
    if len(argv) < 2:
        print("用法: prep-worktree <BOARD> <CARD_ID> [--go]", file=sys.stderr); return 2
    board_path, cid = argv[0], argv[1]
    go = "--go" in argv
    card = _find(load_board(board_path), cid)
    if card is None:
        print("找不到卡：%s" % cid, file=sys.stderr); return 1
    src, why = _source_worktree(card, allow_create=go)
    if src is None:
        print("SKIP %s" % why); return 1
    if go:
        _raw = subprocess.run(["git", "-C", src["worktree"], "status", "--porcelain"],
                              capture_output=True, text=True, timeout=60).stdout
        # 噪声路径（autosave 的 .devloop 进度台账、docs 收口）不算"有未提交代码"
        _NOISE = (".devloop/", "docs/", ".DS_Store")
        _lines = [l for l in (_raw or "").splitlines() if l.strip()]
        _dirty_lines = [l for l in _lines if not any(n in l for n in _NOISE)]
        if _dirty_lines:
            # 真脏：自动 stash 保住别人的改动（不再让整板卡死），并在卡上看得到
            _msg = "nightshift-auto-stash-%s" % time.strftime("%Y%m%d-%H%M%S")
            _r = subprocess.run(["git", "-C", src["worktree"], "stash", "push", "-u", "-m", _msg],
                                capture_output=True, text=True, timeout=120)
            if _r.returncode != 0:
                print("SKIP E_SOURCE_DIRTY 源 worktree 有未提交改动且自动 stash 失败；"
                      "先 commit/stash 再跑：%s" % " | ".join(_dirty_lines)[:300])
                return 1
            print("AUTO_STASH 源 worktree 脏 ⇒ 已 stash(%s)：%s" % (_msg, " | ".join(_dirty_lines)[:200]))
    slug, why = _worker_slug_for_card(card, src["project"])
    if not slug:
        print("SKIP E_WORKER_SLUG %s" % why); return 1
    worker_wt = os.path.join(FEATURES_ROOT, slug, src["project"])
    # 级联起点（用户要求 2026-10-17）：每个要跑的卡都从**最新主干**出发；
    # 已有 worktree 的也要把父级最新内容合进来。父级链：main → 源特性 → worker 特性。
    # 注意：源特性可能已被回收（此时它的路径是只读路标）⇒ 基准回落 main，杜绝把 worker 分支合进主检出。
    base_ref = "feat/%s" % src["feature"]
    src_is_redirect = os.path.islink(src["worktree"])
    steps = [
        [_feature_bin(), "ensure", src["feature"], "--repos", src["project"]],
        [_feature_bin(), "new", slug, "--repos", src["project"], "--from", _base_branch(src["project"]) if src_is_redirect else base_ref,
         "--title", "夜间跑批 %s（自动回收）" % cid],
    ]
    projects = _feature_projects(src["feature"]) or [src["project"]]
    print("SOURCE_SESSION=%s" % src["session"])
    print("SOURCE_FEATURE=%s" % src["feature"])
    print("SOURCE_PROJECT=%s" % src["project"])
    print("SOURCE_WORKTREE=%s" % src["worktree"])
    print("GUARD_REPOS=%s" % " ".join(projects))
    print("WORKER_SLUG=%s" % slug)
    print("WORKDIR=%s" % worker_wt)
    # feature new 会把"本会话 → 特性"的关联改成 worker 特性 ⇒ 先备份源关联，跑完恢复，
    # 否则 merge-back 会把 worker worktree 当成"源 worktree"而自合并（2026-10-16 P2 真机实测）。
    SKIP_ASSOC_IOF = bool(os.environ.get("NIGHTSHIFT_SOURCE_WORKTREE", "").strip())   # 并行模式：不碰共享关联文件

    ASSOC_BAK_PATH = os.path.join(FEATURES_ROOT, ".sessions", "%s.json" % src["session"])
    ASSOC_BAK = None
    if (not SKIP_ASSOC_IOF) and os.path.exists(ASSOC_BAK_PATH):
        try:
            ASSOC_BAK = open(ASSOC_BAK_PATH, encoding="utf-8").read()
        except Exception:
            ASSOC_BAK = None
    # 级联同步（用户要求 2026-10-17）：先父后子 —— 源特性 ← 最新 main；worker 特性（已存在时）← 源特性。
    # **必须在取 ns-feature.lock 之前**：feature sync 自己也要拿同一把锁，
    # 若本函数先持锁再调它 ⇒ 互等死锁（2026-10-17 实测到，进程挂住不返回）。
    if go and os.environ.get("NIGHTSHIFT_SYNC_BEFORE_RUN", "1") in ("1", "true", "yes"):
        def _sync(name, why):
            try:
                r = subprocess.run([_feature_bin(), "sync", name], capture_output=True, text=True, timeout=300,
                                   env=_feature_env())
                tail = (r.stdout or r.stderr or "").strip().splitlines()
                print("SYNC %s（%s）-> rc=%d %s" % (name, why, r.returncode, tail[-1][:120] if tail else ""))
            except Exception as e:
                print("SYNC 跳过 %s：%s" % (name, e))

        if not src_is_redirect:
            _sync(src["feature"], "源特性 ← 最新 main")
        if os.path.exists(os.path.join(FEATURES_ROOT, slug, "feature.json")):
            _sync(slug, "worker 特性 ← 源特性（worktree 已存在）")
    # P6：feature 注册表是共享文件，并行时串行化 feature ensure/new（否则互相打架）
    import fcntl as _fcntl
    _feat_lock_fh = open(os.path.join(FEATURES_ROOT, ".ns-feature.lock"), "a+")
    _fcntl.flock(_feat_lock_fh, _fcntl.LOCK_EX)
    # 同名 worker 特性的墓碑清理：上次跑完 feature close 会留下"目录在、但不是在用特性"的墓碑，
    # 直接 feature new 会失败 ⇒ 先 prune --purge。不做这步，同一张卡的重试会永久卡在送审
    # （2026-10-17 密闭并行测试实测到；ops 板已开 ISOLATED ⇒ 生产会遇到）。
    _wt_dir = os.path.join(FEATURES_ROOT, slug)
    if os.path.isdir(_wt_dir) and not os.path.exists(os.path.join(_wt_dir, "feature.json")):
        _pr = subprocess.run([_feature_bin(), "prune", slug, "--purge", "--yes"], capture_output=True, text=True,
                             timeout=120, env=_feature_env())
        print("PRUNE 清理同名墓碑 %s -> rc=%d" % (slug, _pr.returncode))

    for s in steps:
        print("STEP %s" % " ".join(s))
    if not go:
        print("DRY（未执行；加 --go 才真正创建）")
        return 0
    # 悬挂注册清理：删掉仍被 git 注册的 worktree 目录之后，feature new 会报
    # "already used by worktree"（2026-10-17 实测踩到）⇒ 建之前先 prune 一次（只清 git 元数据，不动文件）。
    try:
        _pr2 = subprocess.run(["git", "-C", src["worktree"], "worktree", "prune"],
                              capture_output=True, text=True, timeout=60)
        print("WORKTREE-PRUNE rc=%d" % _pr2.returncode)
    except Exception as e:
        print("WARN worktree prune 失败：%s" % e)
    for s in steps:
        if s[1] == "new" and os.path.exists(os.path.join(FEATURES_ROOT, slug, "feature.json")):
            continue          # 幂等：worker 特性已存在就别再 new
        r = subprocess.run(s, capture_output=True, text=True, timeout=180, env=_feature_env())
        print("RUN %s -> rc=%d %s" % (" ".join(s), r.returncode, (r.stdout or r.stderr or "").strip()[:200]))
        if r.returncode != 0:
            print("FAIL 创建失败，保持原状"); return 1
    if os.path.islink(worker_wt) or not os.path.isdir(worker_wt):
        print("FAIL E_WORKER_WORKTREE 不可用（符号链接/不存在）：%s" % worker_wt)
        return 1
    if _feature_status(slug) != "active":
        print("FAIL E_WORKER_FEATURE worker 特性不是 active：%s（%s）" % (slug, _feature_status(slug)))
        return 1
    print("READY %s" % worker_wt)

    try:
        _fcntl.flock(_feat_lock_fh, _fcntl.LOCK_UN)
        _feat_lock_fh.close()
    except Exception:
        pass
    if (not SKIP_ASSOC_IOF) and ASSOC_BAK is not None:
        try:
            open(ASSOC_BAK_PATH, "w", encoding="utf-8").write(ASSOC_BAK)
            print("RESTORE 已把会话关联恢复回源特性（防 merge-back 自合并）")
        except Exception as e:
            print("WARN 恢复会话关联失败：%s" % e)
    return 0


def cmd_merge_back(argv):
    """完成时把 worker 分支合并回"源会话的 worktree"，并把去向写进卡片。

    用法：merge-back <BOARD> <CARD_ID> <done|review|failed> [--go]
    规则：只有 done 才合并；review/failed 保留 worker worktree 与分支并在卡上写明（供人进去看）。
    """
    if len(argv) < 3:
        print("用法: merge-back <BOARD> <CARD_ID> <done|review|failed> [--go]", file=sys.stderr); return 2
    board_path, cid, status = argv[0], argv[1], argv[2]
    go = "--go" in argv
    card = _find(load_board(board_path), cid)
    if card is None:
        print("找不到卡：%s" % cid, file=sys.stderr); return 1
    if status == "auto":          # 按卡当前状态决定：done 才合并，其余保留待人工
        status = card.get("status", "review")
    src, why = _source_worktree(card)
    if src is None:
        print("SKIP %s" % why); return 1
    slug = (card.get("workerSlug") or ("ns-" + cid.replace("card-", "")[:12])).strip()
    branch = "feat/%s" % slug
    worker_wt = os.path.join(FEATURES_ROOT, slug, src["project"])
    # worker worktree 必须是真实目录且在用的 active 特性；绝不能顺着已回收的路标（符号链接 → 主检出）
    # 把 worker 分支合进主检出。
    if os.path.islink(worker_wt) or not os.path.isdir(worker_wt):
        print("SKIP E_WORKER_WORKTREE worker worktree 不可用（符号链接/不存在）：%s" % worker_wt)
        return 1
    if _feature_status(slug) != "active":
        print("SKIP E_WORKER_FEATURE worker 特性不是 active：%s（%s）" % (slug, _feature_status(slug)))
        return 1
    # 源特性已被回收时，源路径是只读路标（符号链接 → 主检出）。绝不能顺着它把 worker 分支合进主检出
    # （那会绕过 recycle 的预检与路标语义）。改为拒绝并给出正确命令，卡会按纪律转待审。
    if os.path.islink(src["worktree"]):
        print("SKIP 源特性 %s 已被回收（源路径是只读路标）——不把 worker 分支直接合进主检出；"
              "请人工执行：feature recycle %s --yes（合并进主干）" % (src["feature"], slug))
        return 1
    # 防御：源 worktree 绝不能是 worker 自己的（会话关联被 feature new 覆盖时就会自合并 ⇒ 代码回不了源 + 卡上写假记录）
    if os.path.realpath(src["worktree"]) == os.path.realpath(worker_wt) or src.get("feature") == slug:
        print("SKIP 源 worktree 解析成了 worker 自己的 worktree（会话关联被覆盖）——拒绝自合并；请先把会话关联修回源特性")
        return 1
    note = []
    if status == "done":
        cmds = [
            ["git", "-C", worker_wt, "add", "-A"],
            ["git", "-C", worker_wt, "commit", "-m", "nightshift: %s (%s)" % (card.get("title", "")[:60], cid)],
            ["git", "-C", src["worktree"], "merge", "--no-ff", branch, "-m",
             "nightshift: 合并 %s —— %s" % (slug, card.get("title", "")[:60])],
        ]
        # 合并成功后收掉 worker 特性：代码已并入源 worktree ⇒ 用 feature close（只拆 worktree，不再合并）

        cleanup = [_feature_bin(), "close", slug, "--delete-branch", "--force"]

        note.append("【代码去向】worker 分支 %s → 已并入 %s（worktree %s）" % (branch, src["feature"], src["worktree"]))
    else:
        cmds = []
        note.append("【代码去向】未合并（状态 %s）：worker worktree 保留在 %s，分支 %s 供人工查看" % (status, worker_wt, branch))
    for c in cmds:
        print("STEP %s" % " ".join(c))
    if not go:
        print("DRY（未执行；加 --go 才真正提交/合并）")
        return 0
    # 并行合并必须串行化：多张卡共用一个源 worktree 时，并发 `git merge` 会撞 .git/index.lock
    # （2026-10-17 五并发密闭测试实测到：个别卡 review / 卡在 in_progress）。锁只覆盖合并这一段。
    import fcntl as _fcntl2
    _merge_lock_fh = open(os.path.join(FEATURES_ROOT, ".ns-merge.lock"), "a+")
    _fcntl2.flock(_merge_lock_fh, _fcntl2.LOCK_EX)
    failed = ""
    for c in cmds:
        r = subprocess.run(c, capture_output=True, text=True, timeout=180)
        out = (r.stdout or r.stderr or "").strip()
        # "nothing to commit" 不算失败（worker 通常已自己提交过）
        if r.returncode != 0 and "nothing to commit" not in out and "no changes added" not in out:
            failed = out[:300]
            print("FAIL rc=%d %s" % (r.returncode, failed))
            if c[3] == "merge":
                subprocess.run(["git", "-C", src["worktree"], "merge", "--abort"], capture_output=True)
                print("已 merge --abort（冲突不硬闯，转人工）")
            break
        print("RUN ok: %s" % out[:120])
    if failed:
        note.append("【代码去向】⚠ 合并失败（已 merge --abort），代码仍在 worker worktree %s 的分支 %s 上；请人工处理后重跑。" % (worker_wt, branch))
        # 冲突文件名单独列出来：原来只截 220 字符，会把 CONFLICT 行吃掉 ⇒ 人看不到该改哪个文件。
        _files = []
        for _ln in (failed or "").splitlines():
            _s = _ln.strip()
            if _s.startswith("CONFLICT") or _s.startswith("Auto-merging"):
                if _s not in _files:
                    _files.append(_s)
        if _files:
            note.append("冲突文件（最多 10 条）：\n" + "\n".join("  - " + x for x in _files[:10]))
        note.append("恢复步骤：cd %s && git merge feat/%s → 人工解决冲突 → git commit → 重跑这张卡"
                    % (worker_wt, src["feature"]))
        note.append("失败输出（截断）：%s" % failed.replace("\n", " ")[:220])
    elif status == "done":
        # 合并成功 ⇒ 收掉 worker 特性（代码已在源 worktree；feature close = 只拆 worktree，不再合并）
        try:
            cr = subprocess.run(cleanup, capture_output=True, text=True, timeout=180)
            if cr.returncode == 0:
                print("CLEANUP 已收掉 worker 特性 %s（代码已并入源）" % slug)
                note.append("【代码去向】worker 特性 %s 已收掉（worktree 已移除；代码在源 worktree 里）" % slug)
            else:
                print("CLEANUP 跳过 rc=%d：%s" % (cr.returncode, (cr.stdout or cr.stderr or "").strip()[:120]))
        except Exception as e:
            print("CLEANUP 跳过：%s" % e)
        # feature close 会**解除本会话关联** ⇒ 必须把「源会话 → 源特性」写回去，
        # 否则下一次 prep-worktree 找不到源 worktree 就会 SKIP → 送审（2026-10-17 密闭并行测试实测到）。
        try:
            ap = _assoc_path_for_session(src.get("session"))
            if ap:
                os.makedirs(os.path.dirname(ap), exist_ok=True)
                with open(ap, "w", encoding="utf-8") as fh:
                    json.dump({"session": src["session"], "feature": src["feature"], "project": src["project"],
                               "worktree": src["worktree"],
                               "attachedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                               "attachedCwd": src["worktree"]}, fh, ensure_ascii=False, indent=1)
                print("RESTORE 已把源会话关联写回 %s（feature close 会解除关联）" % src["feature"])
        except Exception as e:
            print("WARN 写回源关联失败：%s" % e)

        # RECYCLE_TO_MAIN（默认关；按板开启）：源特性名下**已无未结算的卡** ⇒ 把它并入项目主分支。
        # 为什么这样判定：提前回收会让后续卡找不到源 worktree；所以只在"这个会话的卡都结算了"时回收。
        # 刻意**不自动推送**（推送是发布动作）。
        if os.environ.get("NIGHTSHIFT_RECYCLE_TO_MAIN", "0") in ("1", "true", "yes"):
            try:
                pending = _feature_has_pending(board_path, src.get("session"))
                if pending:
                    print("RECYCLE 跳过：该源会话名下仍有未结算的卡（%s）" % pending)
                else:
                    # 用户要求（2026-10-17）：合并完就 push。默认带 --push（可用 NIGHTSHIFT_PUSH_AFTER_RECYCLE=0 关掉）。
                    _args = [_feature_bin(), "recycle", src["feature"], "--yes"]
                    if os.environ.get("NIGHTSHIFT_PUSH_AFTER_RECYCLE", "1") in ("1", "true", "yes"):
                        _args.append("--push")
                    rc2 = subprocess.run(_args, capture_output=True, text=True, timeout=600)
                    out2 = (rc2.stdout or rc2.stderr or "").strip()
                    if rc2.returncode == 0:
                        print("RECYCLE 已把 %s 合入 %s 的主分支（未推送）" % (src["feature"], src["project"]))
                        note.append("【代码去向】源特性 %s 名下卡片已全部结算 ⇒ 已 feature recycle 合入 %s 的主分支"
                                    "（未自动推送）" % (src["feature"], src["project"]))
                    else:
                        print("RECYCLE 跳过 rc=%d：%s" % (rc2.returncode, out2[:200]))
            except Exception as e:
                print("RECYCLE 跳过：%s" % e)
    def mutate(b):
        cc = _find(b, cid)
        if cc is None:
            return False
        cc["description"] = (cc.get("description") or "").rstrip() + "\n" + "\n".join(note) + "\n"
        if failed:
            cc["status"] = "review"        # 合并失败绝不能停在 done：转待审让人看见
        cc["updatedAt"] = int(time.time() * 1000)
        return True
    print("card-record %s" % mutate_board(board_path, mutate))
    return 1 if failed else 0


# 加 auto 时要一并清掉的"遮挡跑批"的标签（人工显式放行 ⇒ 这些标记不该继续挡路）
STRIP_WHEN_AUTO = ("hold", "decision-needed", "human-review", "needs-direction", "legal", "blocking", "human-decision")


def cmd_bulk(argv):
    """批量改标签（面板批量操作的机械内核）。

    用法：bulk <BOARD> <add|remove> <tag> <id...>
    白名单标签：auto / hold / temp（其余拒绝——避免把看板当通用改字段入口）。
    返回：逐张结果 + 成功/跳过计数；写入仍走 mutate_board（形状护栏 + 指纹重放）。
    """
    if len(argv) < 4:
        print("用法: bulk <BOARD> <add|remove> <tag> <id...>", file=sys.stderr); return 2
    path, op, tag = argv[0], argv[1], argv[2]
    ids = [x for x in argv[3:] if x]
    if op not in ("add", "remove"):
        print("op 必须是 add 或 remove", file=sys.stderr); return 2
    if tag not in ("auto", "hold", "temp"):
        print("标签白名单：auto / hold / temp（收到 %s）" % tag, file=sys.stderr); return 2
    ok = skip = 0
    stripped = []
    for cid in ids:
        def mutate(b, cid=cid):
            c = _find(b, cid)
            if c is None:
                return False
            tags = [x for x in (c.get("tags") or [])]
            low = [x.lower() for x in tags]
            if op == "add" and tag not in low:
                tags.append(tag)
                if tag == "auto":
                    # 人工把卡交给跑批：顺手清掉会遮挡它的标签（含 hold），并在输出里明说
                    keep = [x for x in tags if x.lower() not in STRIP_WHEN_AUTO and not x.lower().startswith("blocked")]
                    removed = [x for x in tags if x not in keep]
                    if removed:
                        stripped.append("%s: -%s" % (cid, ",".join(removed)))
                    tags = keep
            elif op == "remove" and tag in low:
                tags = [x for x in tags if x.lower() != tag]
            else:
                return False
            c["tags"] = tags
            c["updatedAt"] = int(time.time() * 1000)
            return True
        r = mutate_board(path, mutate)
        if r == "ok":
            ok += 1; print("  ok   %s %s %s" % (op, tag, cid))
        else:
            skip += 1; print("  skip %s %s %s（board=%s）" % (op, tag, cid, r))
    print("bulk %s %s：成功 %d，跳过 %d" % (op, tag, ok, skip))
    for s in stripped:
        print("  已清理遮挡标签 %s" % s)
    return 0 if ok or not ids else 1




def cmd_invariants(argv):
    """结构性不变量自检（含安全自愈）。用法: invariants <board> [--heal]"""
    import json as _json, os as _os, shutil as _sh
    path = argv[0] if argv else KANBAN_DEFAULT
    heal = "--heal" in argv
    b = load_board(path)
    ip = {c["id"]: c for c in b.get("cards", []) if c.get("status") == "in_progress"}
    # 修正 2026-11-01：ns.py 就在 nightshift/ 目录下，slots 是同级的 ./slots，不是 ../slots
    slots_dir = _os.path.abspath(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "slots"))
    seen, violations, healed = {}, [], []
    dirs = sorted(_os.listdir(slots_dir)) if _os.path.isdir(slots_dir) else []
    for d in dirs:
        sp = _os.path.join(slots_dir, d)
        if not _os.path.isdir(sp) or not d.isdigit():
            continue
        try:
            pid = int(open(_os.path.join(sp, "pid")).read().strip())
        except Exception:
            pid = 0
        alive = False
        if pid:
            try:
                _os.kill(pid, 0); alive = True
            except Exception:
                alive = False
        if not alive:
            violations.append({"inv": "I3", "slot": d, "why": "僵尸槽 pid=%s" % pid})
            if heal:
                _sh.rmtree(sp, ignore_errors=True); healed.append("释放僵尸槽 %s" % d)
            continue
        # SLOT-BOARD-SCOPE：只处置"属于本看板"的槽位，避免跨板误伤（2026-11-04 故障注入发现）
        try:
            _owner = open(_os.path.join(sp, "board")).read().strip()
        except Exception:
            _owner = ""
        _mykey = _os.path.basename(_os.path.dirname(_os.path.abspath(path))) or ""
        if _owner and _mykey and _owner != _mykey:
            continue
        try:
            card = open(_os.path.join(sp, "card")).read().strip()
        except Exception:
            card = ""
        if card:
            if card in seen:
                violations.append({"inv": "I4", "slot": d, "why": "卡 %s 同占 %s/%s" % (card[:16], seen[card], d)})
                if heal:
                    # 保留先出现的那个槽，释放重复槽（避免同卡被两个 worker 抢着写）
                    import shutil as _sh2
                    _sh2.rmtree(sp, ignore_errors=True)
                    healed.append("释放重复槽 %s（卡 %s 已由槽 %s 占用）" % (d, card[:16], seen[card]))
                    continue
            seen[card] = d
            if card not in ip:
                violations.append({"inv": "I1", "slot": d, "card": card[:16], "why": "槽位占着非 in_progress 卡"})
                if heal:
                    _sh.rmtree(sp, ignore_errors=True); healed.append("释放槽 %s" % d)
    return_viol = list(violations)
    # I5（2026-11-04）：已有人工【确认】且确认时间晚于最后一次【送审】的 review 卡，
    # 说明"批准→回待办"这一步没落地（面板/confirm-all 路径都可能漏）⇒ 自愈推回 todo。
    import re as _re
    _review = [c for c in b.get("cards", []) if c.get("status") == "review"]
    _advanced = []
    for c in _review:
        desc = c.get("description") or ""
        confs = _re.findall(r"【确认 (\d{4}-\d{2}-\d{2} \d{2}:\d{2})", desc)
        subms = _re.findall(r"【夜间跑批送审 (\d{4}-\d{2}-\d{2} \d{2}:\d{2})", desc)
        if not confs:
            continue
        if subms and confs[-1] < subms[-1]:
            continue                      # 批准后又被重新送审 ⇒ 需要人再看，不动
        # P1（2026-11-04）：收窄三处误判 ——
        # ① 正在被 worker 跑（槽位里有它）⇒ 不动；② 有活槽位（一轮在跑）⇒ 不动；
        # ③ 最后一次送审在 30 分钟内 ⇒ 视为"刚送审，可能还在流转"，不动。
        if c["id"] in seen:
            continue
        if len(seen) > 0:
            continue
        try:
            import time as _t
            if subms:
                _last = _t.mktime(_t.strptime(subms[-1], "%Y-%m-%d %H:%M"))
                if _t.time() - _last < 1800:
                    continue
        except Exception:
            pass
        if heal:
            def _mut(bd, _cid=c["id"], _conf=confs[-1]):
                cc = _find(bd, _cid)
                if cc is None or cc.get("status") != "review":
                    return False
                cc["status"] = "todo"
                cc["description"] = (cc.get("description") or "").rstrip() + (
                    "\n【推进自愈 %s】有效确认(%s)但状态仍 review ⇒ 回 todo。\n" % (time.strftime("%Y-%m-%d %H:%M"), _conf))
                cc["updatedAt"] = int(time.time() * 1000)
                return True
            if mutate_board(path, _mut) == "ok":
                _advanced.append(c["id"][:16]); healed.append("批准未推进 ⇒ 回 todo %s" % c["id"][:16])
        else:
            return_viol.append({"inv": "I5", "card": c["id"][:16], "why": "已有效确认但仍是 review（批准→待办未落地）"})
    for cid in list(ip):
        if cid in seen:
            continue
        return_viol.append({"inv": "I2", "card": cid[:16], "why": "孤儿卡：in_progress 无活槽"})
        if not heal:
            continue
        n = int((load_state().get("attempts") or {}).get(cid, 0)) + 1
        set_attempt(cid, n)
        def mutate(bd, _cid=cid, _n=n):
            cc = _find(bd, _cid)
            if cc is None or cc.get("status") != "in_progress":
                return False
            if "【确认" in (cc.get("description") or ""):
                cc["status"] = "todo"; set_attempt(_cid, 0)
            else:
                cc["status"] = "review" if _n >= MAX_ATTEMPTS else "todo"
            cc["description"] = (cc.get("description") or "").rstrip() + (
                "\n\n【不变量自愈 %s】in_progress 无活槽 ⇒ 回 %s。\n" % (time.strftime("%Y-%m-%d %H:%M"), cc["status"]))
            cc["updatedAt"] = int(time.time() * 1000)
            return True
        if mutate_board(path, mutate) == "ok":
            healed.append("回收孤儿卡 %s" % cid[:16])
    print(_json.dumps({"ok": not return_viol, "violations": return_viol, "healed": healed,
                       "inProgress": len(ip), "slots": len(seen)}, ensure_ascii=False))
    return 0


def cmd_recover(argv):
    """把上次被强杀留下的 in_progress 卡拉回待办（留痕 + 计一次尝试）。

    为什么：in_progress 的卡不在 todo 里 ⇒ 跑批**永远不会**再捡起它，卡永久卡住。
    """
    if len(argv) < 2:
        print("用法: recover <BOARD> <cardId>", file=sys.stderr); return 2
    path, cid = argv[0], argv[1]
    st = load_state()
    n = int((st.get("attempts") or {}).get(cid, 0)) + 1
    set_attempt(cid, n)
    st = load_state(); st.pop("currentCardId", None); st.pop("currentSince", None); save_state(st)

    def mutate(b):
        c = _find(b, cid)
        if c is None or c.get("status") != "in_progress":
            return False
        # 已人工确认过的卡：恢复时一律回 todo 并清尝试计数。
        # 否则会出现死循环：批准 -> todo -> 开跑 -> 我重启 dsh-web 杀 worker -> recover 计一次
        # -> 达到 MAX_ATTEMPTS -> 又回 review（2026-10-31 用户遇到的正是这个）。
        if "【确认" in (c.get("description") or ""):
            c["status"] = "todo"
            set_attempt(cid, 0)
        else:
            c["status"] = "review" if n >= MAX_ATTEMPTS else "todo"
            # RECOVER_HOLD_ON_REPEAT：达到上限的卡加 hold，避免"恢复→再跑→再恢复"的循环
            if n >= MAX_ATTEMPTS and "hold" not in (c.get("tags") or []):
                c["tags"] = list(c.get("tags") or []) + ["hold"]
                c["description"] = (c.get("description") or "").rstrip() + (
                    "\n【停止重试 2026-10-31】中断恢复已达上限（%d 次）⇒ 自动加 hold。"
                    "排查后再去掉 hold。\n" % n)
        c["description"] = (c.get("description") or "").rstrip() + (
            "\n\n【跑批中断恢复 %s】上次执行被强杀（无活着的 worker），已自动拉回 %s（第 %d 次尝试）。\n"
            % (time.strftime("%Y-%m-%d %H:%M"), c["status"], n))
        c["updatedAt"] = int(time.time() * 1000)
        return True
    r = mutate_board(path, mutate)
    print("recover %s -> %s (board=%s, attempt=%d)" % (cid, "ok" if r == "ok" else "nochange", r, n))
    return 0


def task_explain_compliance(text):
    """建卡闸门（用户 2026-10-27/28 要求）：**每个跑批任务**生成时就带 explain-plain 说明。

    必须有：① ```text 架构/流程 ASCII 图（≤100 列）
            ② 白话"这张卡在做什么"（含「这张卡」或「做什么」）
            ③ 判据（含「判据」或「验收」）
            ④ 可选路径（含「可选」「路径」「方案」「选项」之一）
            ⑤ 每个路径的「代价」
    为什么：用户看不懂技术细节，只看理念与价值；没有白话解释+图+可选路径，他就无法判断。
    """
    miss = []
    s = text or ""
    blocks, cur = [], None
    for line in s.splitlines():
        if line.strip() == "```text":
            cur = []
        elif line.strip() == "```" and cur is not None:
            blocks.append(cur); cur = None
        elif cur is not None:
            cur.append(line)
    if not blocks:
        miss.append("```text 围栏的 ASCII 图")
    else:
        wide = [len(b) for blk in blocks for b in blk if len(b) > 100]
        if wide:
            miss.append("图宽 >100 列（会被折行）")
    if not ("这张卡" in s or "做什么" in s):
        miss.append("白话说明「这张卡在做什么」")
    if not ("判据" in s or "验收" in s):
        miss.append("判据（跑什么命令算过）")
    if not any(k in s for k in ("可选", "路径", "方案", "选项")):
        miss.append("可选路径（有几种做法）")
    if "代价" not in s:
        miss.append("每条路径的「代价」")
    return (len(miss) == 0), miss


def cmd_card_add(argv):
    """加一张卡（取代看板插件的 board_add；写入仍走 mutate_board 的形状护栏）。

    用法：card-add <BOARD> <标题> [--tags a,b] [--status todo] [--rationale 为什么] [--rejected 放弃了什么] [--description 详情] [--session 会话id]
    sourceSessionId 默认取 DSH_SESSION_ID（在 dsh 会话里执行即可自动盖章；没有就跑批不会捡）。
    """
    if len(argv) < 2:
        print("用法: card-add <BOARD> <标题> [--tags a,b] ...", file=sys.stderr); return 2
    board_path, title = argv[0], argv[1]
    opt = {}
    i = 2
    while i < len(argv):
        if argv[i].startswith("--") and i + 1 < len(argv):
            opt[argv[i][2:]] = argv[i + 1]; i += 2
        else:
            i += 1
    if "--no-explain" not in argv:
        _txt = "\n".join([title, opt.get("description", ""), opt.get("summary", ""), opt.get("rationale", "")])
        _okk, _miss = task_explain_compliance(_txt)
        if not _okk:
            print("✗ 建卡被拒：缺少 explain-plain 说明 —— %s" % "、".join(_miss))
            print("  要求（用户 2026-10-27/28）：每个跑批任务生成时就带 —— 白话「这张卡在做什么」+ ```text 架构/流程图 + 判据 + 可选路径与各自代价。")
            print("  确实不需要（纯记账卡）可加 --no-explain。")
            return 3
    cid = "card-%s" % uuid.uuid4()
    now = int(time.time() * 1000)
    card = {"id": cid, "title": title, "status": opt.get("status", "todo"),
            "tags": [x.strip() for x in (opt.get("tags") or "").split(",") if x.strip()],
            "description": opt.get("description", ""), "summary": opt.get("summary", ""),
            "rationale": opt.get("rationale", ""), "rejected": opt.get("rejected", ""),
            "createdAt": now, "updatedAt": now}
    sid = (opt.get("session") or opt.get("source-session") or os.environ.get("DSH_SESSION_ID") or "").strip()
    if sid:
        card["sourceSessionId"] = sid
    if opt.get("worker-slug"):
        card["workerSlug"] = opt["worker-slug"].strip()
    if opt.get("run-timeout"):
        try:
            n = int(opt["run-timeout"])
        except Exception:
            print("run-timeout 必须是整数秒", file=sys.stderr); return 2
        if not 600 <= n <= 3600:
            print("run-timeout 必须在 600..3600 秒（10..60 分钟）", file=sys.stderr); return 2
        card["runTimeoutSec"] = n

    def mutate(b):
        b.setdefault("cards", []).append(card)
        return True
    r = mutate_board(board_path, mutate)
    print("card-add %s -> %s (board=%s)" % (cid, "ok" if r == "ok" else "FAILED", r))
    return 0 if r == "ok" else 1


def cmd_card_update(argv):
    """改一张卡（取代 board_update）。用法：card-update <BOARD> <id> [--status …] [--summary …] [--rationale …] [--rejected …] [--tags a,b] [--append-description 文本]"""
    if len(argv) < 2:
        print("用法: card-update <BOARD> <id> [--status …] ...", file=sys.stderr); return 2
    board_path, cid = argv[0], argv[1]
    opt = {}
    i = 2
    while i < len(argv):
        if argv[i].startswith("--") and i + 1 < len(argv):
            opt[argv[i][2:]] = argv[i + 1]; i += 2
        else:
            i += 1

    def mutate(b):
        c = _find(b, cid)
        if c is None:
            return False
        for k in ("status", "summary", "rationale", "rejected", "description"):
            if k in opt:
                c[k] = opt[k]
        if "tags" in opt:
            c["tags"] = [x.strip() for x in opt["tags"].split(",") if x.strip()]
        if "worker-slug" in opt:
            c["workerSlug"] = opt["worker-slug"].strip()
        if "run-timeout" in opt:
            try:
                n = int(opt["run-timeout"])
            except Exception:
                print("run-timeout 必须是整数秒", file=sys.stderr); return False
            if not 600 <= n <= 3600:
                print("run-timeout 必须在 600..3600 秒（10..60 分钟）", file=sys.stderr); return False
            c["runTimeoutSec"] = n
        if "append-description" in opt:
            c["description"] = (c.get("description") or "").rstrip() + "\n" + opt["append-description"] + "\n"
        # 闸门（必须在落盘前；2026-10-28 曾误放到 return True 之后 ⇒ 成了死代码 ⇒ 绕过实测才暴露）
        if str(c.get("status")) == "review" and os.environ.get("NIGHTSHIFT_REVIEW_GATE", "1") not in ("0", "false", "no"):
            _txt = (c.get("description") or "") + "\n" + (c.get("summary") or "")
            _okk, _miss = review_compliance(_txt)
            if not _okk:
                print("✗ 送审材料不合规（缺：%s）⇒ 拒绝置 review" % "、".join(_miss))
                return False
        c["updatedAt"] = int(time.time() * 1000)
        return True
    r = mutate_board(board_path, mutate)
    print("card-update %s -> %s (board=%s)" % (cid, "ok" if r == "ok" else "FAILED", r))
    return 0 if r == "ok" else 1


def cmd_card_timeout(argv):
    """打印卡级超时（秒）；没设置或非法则打印空串，让 scan.sh 回落 RUN_TIMEOUT。"""
    if len(argv) < 2:
        print("用法: card-timeout <BOARD> <CARD_ID>", file=sys.stderr); return 2
    card = _find(load_board(argv[0]), argv[1])
    if card is None:
        return 1
    try:
        n = int(card.get("runTimeoutSec"))
    except Exception:
        return 0
    if 600 <= n <= 3600:
        print(n)
    return 0


def cmd_status(argv):
    st = load_state()
    st["now"] = datetime.datetime.now().strftime("%F %T")
    st["offpeak"] = not is_peak()
    st["windowLeftSec"] = window_left()
    st["today"] = today_key()
    st["attempts"] = st.get("attempts") or {}
    print(json.dumps(st, ensure_ascii=False, indent=1))
    return 0


CMDS = {"offpeak": cmd_offpeak, "window-left": cmd_window_left, "idle": cmd_idle,
        "pick": cmd_pick, "mark": cmd_mark, "apply": cmd_apply, "receipt": cmd_receipt,
        "triage": cmd_triage, "status": cmd_status, "repo-state": cmd_repo_state,
        "storm-check": cmd_storm_check, "confirm": cmd_confirm, "day-cost": cmd_day_cost,
        "confirm-recommended": cmd_confirm_recommended,
        "prep-worktree": cmd_prep_worktree, "merge-back": cmd_merge_back, "bulk": cmd_bulk, "card-add": cmd_card_add, "card-update": cmd_card_update, "claim": cmd_claim, "recover": cmd_recover, "source-of": cmd_source_of, "orphan-list": cmd_orphan_list, "dup-check": cmd_dup_check, "dup-record": cmd_dup_record, "cost-report": cmd_cost_report, "feature-finish": cmd_feature_finish, "backfill-worker-sessions": cmd_backfill_worker_sessions, "card-status": cmd_card_status, "card-timeout": cmd_card_timeout, "invariants": cmd_invariants, "repo-path": cmd_repo_path, "repo-diff": cmd_repo_diff, "fp": cmd_fp}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in CMDS:
        print("usage: ns.py <%s> ..." % "|".join(CMDS)); sys.exit(2)
    sys.exit(CMDS[sys.argv[1]](sys.argv[2:]))
