#!/usr/bin/env python3
"""nightshift 零 token 自测：状态机四条路径 + 证据门槛 + 失败计次 + 回执 + 防丢更新。

跑法：  python3 /root/ops/nightshift/selftest.py
全部在临时看板文件上做，不动 /root/ops/KANBAN.json。
"""
import importlib.util
import json
import os
import sys
import tempfile
import time
import subprocess
import io
import contextlib

HERE = os.path.dirname(os.path.abspath(__file__))
TMP = tempfile.mkdtemp(prefix="nightshift-selftest-")
BOARD = os.path.join(TMP, "KANBAN.json")
os.environ["NIGHTSHIFT_STATE"] = os.path.join(TMP, "state.json")
os.environ["NIGHTSHIFT_REVIEW_GATE"] = "0"  # 单测只验状态机，不验审批单格式

spec = importlib.util.spec_from_file_location("ns", os.path.join(HERE, "ns.py"))
ns = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ns)

fails = []


def check(name, cond, extra=""):
    print(("  OK   " if cond else "  FAIL ") + name + (("  <- " + str(extra)) if extra and not cond else ""))
    if not cond:
        fails.append(name)


def new_board(cards):
    with open(BOARD, "w", encoding="utf-8") as fh:
        json.dump({"version": 1, "cards": cards}, fh, ensure_ascii=False, indent=2)


def card(cid, title="测试卡", tags=None, desc="说明", status="todo"):
    # sourceSessionId 是 eligible() 的硬门槛（2026-11-01 起：没有来源会话 ⇒ 一定 E_NO_SOURCE，
    # 选卡阶段就排除）。夹具必须带上，否则 pick 恒为 None、整个用例集失去意义。
    return {"id": cid, "title": title, "status": status, "tags": tags or [],
            "description": desc, "createdAt": 1, "updatedAt": 1,
            "sourceSessionId": "session-selftest"}


def read_card(cid):
    return next(c for c in json.load(open(BOARD, encoding="utf-8"))["cards"] if c["id"] == cid)


def result_file(text):
    p = os.path.join(TMP, "res-%d.txt" % time.time_ns())
    open(p, "w", encoding="utf-8").write(text)
    return p


print("== 1) 选卡：hold 禁跑 / auto 优先 / 决策卡剔除 ==")
new_board([
    card("c1", "普通卡", ["x"]),
    card("c2", "标了 auto 的卡", ["auto"], status="todo"),
    card("c3", "拍板 D1–D6：…”", ["decision-needed", "blocking"]),
    card("c4", "被禁的卡", ["hold"]),
    card("c5", "阻塞卡", ["blocked-on-D9"]),
])
pick = json.loads(_out := os.popen("python3 %s/ns.py pick %s" % (HERE, BOARD)).read())
check("auto 优先于未标记者", pick["picked"]["id"] == "c2", pick["picked"])
check("todo 总数=5", pick["todoCount"] == 5, pick["todoCount"])
check("hold 卡被计入 held", pick["heldCount"] == 1, pick["heldCount"])
check("决策卡被剔除（拍板/阻塞）", len(pick["decisionCards"]) == 2, pick["decisionCards"])

print("\n== 2) done 必须有证据 ==")
new_board([card("d1")])
ns.cmd_apply([BOARD, "d1", result_file("KANBAN-RESULT: done\nKANBAN-SUMMARY: 做完了\n")])
check("无证据 → review", read_card("d1")["status"] == "review", read_card("d1")["status"])
check("并写明原因", "缺验证证据" in read_card("d1")["description"])
ns.cmd_mark([BOARD, "d1", "todo"])
ns.cmd_apply([BOARD, "d1", result_file(
    "KANBAN-RESULT: done\nKANBAN-SUMMARY: 加了用例\nKANBAN-EVIDENCE: go test ./x → ok 12/12\n")])
c = read_card("d1")
check("有证据 → done", c["status"] == "done", c["status"])
check("证据写进 summary", "go test ./x → ok 12/12" in (c.get("summary") or ""))
check("done 自动补 rationale/rejected", bool(c.get("rationale")) and bool(c.get("rejected")))

print("\n== 3) review 路径：把要确认的写进 description ==")
new_board([card("r1")])
ns.cmd_apply([BOARD, "r1", result_file(
    "KANBAN-RESULT: review\nKANBAN-SUMMARY: 需要你确认命名\nKANBAN-NOTE: 不确定点=X；建议=Y；备选=Z\n")])
c = read_card("r1")
check("→ review", c["status"] == "review", c["status"])
check("问题了 description", "建议=Y" in (c.get("description") or ""))

print("\n== 4) 失败计次 + 超限转待审 ==")
new_board([card("f1")])
ns.set_attempt("f1", 0)
ns.cmd_apply([BOARD, "f1", result_file("KANBAN-RESULT: failed\nKANBAN-SUMMARY: 第一次炸了\n")])
check("第 1 次失败 → 回 todo", read_card("f1")["status"] == "todo", read_card("f1")["status"])
check("attempts=1", ns.attempt_count("f1") == 1, ns.attempt_count("f1"))
ns.cmd_apply([BOARD, "f1", result_file("KANBAN-RESULT: failed\nKANBAN-SUMMARY: 第二次又炸了\n")])
check("第 2 次（=MAX_ATTEMPTS）→ review", read_card("f1")["status"] == "review", read_card("f1")["status"])
check("写明连续次数", "连续 2 次未完成" in read_card("f1")["description"])

print("\n== 5) 成功清空 attempts ==")
ns.set_attempt("f1", 5)
ns.cmd_mark([BOARD, "f1", "todo"])
ns.cmd_apply([BOARD, "f1", result_file("KANBAN-RESULT: done\nKANBAN-SUMMARY: 这次成了\nKANBAN-EVIDENCE: ok\n")])
check("attempts 归零", ns.attempt_count("f1") == 0, ns.attempt_count("f1"))

print("\n== 6) 回执卡：summary 一行 + 最近若干轮 ==")
new_board([card("q1")])
for i in range(3):
    ns.cmd_mark([BOARD, "q1", "todo"])
    ns.cmd_apply([BOARD, "q1", result_file("KANBAN-RESULT: done\nKANBAN-SUMMARY: 第%d轮\nKANBAN-EVIDENCE: ok\n" % i)])
    ns.cmd_receipt([BOARD, "q1", result_file("KANBAN-RESULT: done\nKANBAN-SUMMARY: 第%d轮\n" % i), "rc=0"])
rec = next(c for c in json.load(open(BOARD, encoding="utf-8"))["cards"] if c["title"] == ns.RECEIPT_TITLE)
check("回执卡已建且 done+nightly", rec["status"] == "done" and "nightly" in rec["tags"], rec)
# 2026-11-04 口径变更：回执卡已改为默认 auto（可跑），不再默认 hold ——
# 见 ns.py 创建回执卡处的注释「默认要能跑；不想跑的人显式加 hold」。
check("summary 是最近一轮", "第2轮" in rec["summary"], rec["summary"])
check("description 累积历史行", rec["description"].count("- ") == 3, rec["description"])

print("\n== 7) 防丢更新：写前被别人改过 → 重放我们的增量，不覆盖别人 ==")
new_board([card("m1", "我要改的卡")])
hostile_done = {"n": 0}
def hostile_mutate(board):
    # 模拟「mutate 期间别人（你在 GUI / 别的会话）改了一次看板」——只发生一次（真实情形）
    if hostile_done["n"] == 0:
        hostile_done["n"] = 1
        b = json.load(open(BOARD, encoding="utf-8"))
        b["cards"][0]["title"] = "别人改过的标题"
        b["cards"].append(card("other", "别人加的卡"))
        with open(BOARD, "w", encoding="utf-8") as fh:
            json.dump(b, fh, ensure_ascii=False, indent=2)
    target = next(c for c in board["cards"] if c["id"] == "m1")
    target["tags"] = ["mine"]
    return True
r = ns.mutate_board(BOARD, hostile_mutate)
after = json.load(open(BOARD, encoding="utf-8"))
check("结果 ok（重放成功）", r == "ok", r)
m1 = next(c for c in after["cards"] if c["id"] == "m1")
check("别人的标题保住了", m1["title"] == "别人改过的标题", m1["title"])
check("别人加的卡保住了", any(c["id"] == "other" for c in after["cards"]))
check("我们的增量也写进去了", m1["tags"] == ["mine"], m1.get("tags"))

print("\n== 8) 格式与插件一致（indent=2 + 末尾换行）==")
ns.cmd_mark([BOARD, "m1", "in_progress"])          # 由 ns.py 自己写一次，再验格式
raw = open(BOARD, encoding="utf-8").read()
check("2 空格缩进", '\n  "version"' in raw or '\n  "cards"' in raw)
check("末尾有换行", raw.endswith("\n"))

print("\n== 9) 缺卡/损坏看板不崩 ==")
r = ns.mutate_board(BOARD, lambda b: False)
check("无改动 → nochange", r == "nochange", r)
open(BOARD, "w").write("{ not json")
try:
    os.popen("python3 %s/ns.py pick %s 2>/dev/null" % (HERE, BOARD)).read()
    crashed = False
except Exception:
    crashed = True
check("看板损坏时 pick 不会破坏文件", open(BOARD).read().startswith("{ not json"))


print("\n== 10) P1 加固：守卫仓库 / 特性幂等 / 超时 / 系统 review ==")
FEATS = os.path.join(TMP, "features")
os.makedirs(os.path.join(FEATS, ".sessions"), exist_ok=True)
ns.FEATURES_ROOT = FEATS
REPO = os.path.join(TMP, "repo")
os.makedirs(REPO, exist_ok=True)
subprocess.run(["git", "init", "-q", REPO], check=True)
subprocess.run(["git", "-C", REPO, "config", "user.email", "t@t"], check=True)
subprocess.run(["git", "-C", REPO, "config", "user.name", "t"], check=True)
open(os.path.join(REPO, "a"), "w").write("a")
subprocess.run(["git", "-C", REPO, "add", "."], check=True)
subprocess.run(["git", "-C", REPO, "commit", "-qm", "init"], check=True)
REPOS = os.path.join(FEATS, ".repos.json")
json.dump({"demo": REPO}, open(REPOS, "w"), ensure_ascii=False)
os.environ["NIGHTSHIFT_REPOS_FILE"] = REPOS
check("repo-path 解析项目名", ns.cmd_repo_path(["demo"]) == 0, "rc")
check("repo-state --strict 正常仓库返回 0", ns.cmd_repo_state(["--strict", "demo"]) == 0, "rc")
check("repo-state --strict 未知仓库返回 2", ns.cmd_repo_state(["--strict", "nope"]) == 2, "rc")
with contextlib.redirect_stdout(io.StringIO()) as out:
    ns.cmd_repo_diff([json.dumps({REPO: {"head": "a", "paths": []}}),
                      json.dumps({REPO: {"head": "a", "paths": [" M x"]}})])
check("repo-diff 只变 dirty 路径", '"head_changed": []' in out.getvalue() and 'paths_added' in out.getvalue(), out.getvalue())

# 卡级超时字段
new_board([card("t1")])
check("card-add 接受 run-timeout=1800",
      ns.cmd_card_add([BOARD, "卡级超时", "--run-timeout", "1800", "--no-explain"]) == 0, "rc")
tid = next(c["id"] for c in json.load(open(BOARD, encoding="utf-8"))["cards"] if c["title"] == "卡级超时")
with contextlib.redirect_stdout(io.StringIO()) as out:
    ns.cmd_card_timeout([BOARD, tid])
check("card-timeout 输出 1800", out.getvalue().strip() == "1800", out.getvalue())
check("card-add 拒绝 60s", ns.cmd_card_add([BOARD, "太短", "--run-timeout", "60", "--no-explain"]) == 2, "rc")

# 特性名选择：active 复用 / recycled 换名 / 墓碑可清理
def mkfeat(slug, status, wt=None, project="demo"):
    d = os.path.join(FEATS, slug)
    os.makedirs(d, exist_ok=True)
    repos = {project: {"path": wt or os.path.join(d, project)}}
    os.makedirs(wt or os.path.join(d, project), exist_ok=True)
    json.dump({"slug": slug, "status": status, "repos": repos}, open(os.path.join(d, "feature.json"), "w"))
    return d
mkfeat("ns-auto-abcdef12", "active", project="demo")
check("auto slug active 复用", ns._choose_auto_slug("session-abcdef12", "demo")[0] == "ns-auto-abcdef12")
mkfeat("ns-auto-11112222", "recycled", project="demo")
check("auto slug recycled 换 -2", ns._choose_auto_slug("session-11112222", "demo")[0] == "ns-auto-11112222-2")
os.makedirs(os.path.join(FEATS, "ns-auto-33334444"), exist_ok=True)
check("auto slug 墓碑可识别", ns._choose_auto_slug("session-33334444", "demo")[1] == "tombstone")
mkfeat("ns-abcdef123456", "recycled", project="demo")
check("worker slug recycled 换 -2", ns._worker_slug_for_card({"id": "card-abcdef123456"}, "demo")[0] == "ns-abcdef123456-2")

# 源会话无关联：AUTO_FEATURE 关 → 明确错误；开 + dry-run → 零副作用
os.environ["NIGHTSHIFT_AUTO_FEATURE"] = "0"
src, why = ns._source_worktree({"sourceSessionId": "session-none"}, allow_create=False)
check("无关联且 AUTO_FEATURE=0 → E_NO_FEATURE", src is None and why.startswith("E_NO_FEATURE"), why)
os.environ["NIGHTSHIFT_AUTO_FEATURE"] = "1"
os.environ["NIGHTSHIFT_AUTO_PROJECT"] = "demo"
src, why = ns._source_worktree({"sourceSessionId": "session-none"}, allow_create=False)
check("dry-run 不建特性 → E_DRY_RUN", src is None and why.startswith("E_DRY_RUN"), why)

# 系统 review 不被 worker 审批单格式闸门误杀；非法状态绝不写坏看板
os.environ["NIGHTSHIFT_REVIEW_GATE"] = "1"
os.environ["NIGHTSHIFT_STATE"] = os.path.join(TMP, "state-p1.json")
os.environ["MAX_ATTEMPTS"] = "2"
new_board([card("s1")])
p = result_file("KANBAN-RESULT: review\nKANBAN-SYSTEM: guard\nKANBAN-SUMMARY: E_MAIN_DIRTY 主检出变化\n")
ns.cmd_apply([BOARD, "s1", p])
c = read_card("s1")
check("系统 review 绕过审批单闸门 → review", c["status"] == "review", c["status"])
check("系统 review 看板形状合法", ns.board_shape_errors(json.load(open(BOARD, encoding="utf-8"))) == [], "shape")
new_board([card("w1")])
ns.cmd_apply([BOARD, "w1", result_file("KANBAN-RESULT: review\nKANBAN-SUMMARY: 缺上下文\n")])
check("非合规 worker review 第 1 次 → todo", read_card("w1")["status"] == "todo", read_card("w1")["status"])
ns.cmd_apply([BOARD, "w1", result_file("KANBAN-RESULT: review\nKANBAN-SUMMARY: 缺上下文\n")])
check("非合规 worker review 第 2 次 → review", read_card("w1")["status"] == "review", read_card("w1")["status"])
check("非合规 review 后看板形状合法", ns.board_shape_errors(json.load(open(BOARD, encoding="utf-8"))) == [], "shape")

print("\n== N) 原子认领（pick→mark 竞态守卫）==")
new_board([card("k1"), card("k2")])
_rc1 = os.system("python3 %s/ns.py claim %s k1 >/dev/null" % (HERE, BOARD)) == 0
_rc2 = os.system("python3 %s/ns.py claim %s k1 >/dev/null" % (HERE, BOARD)) == 0
check("首次 claim 成功", _rc1, _rc1)
check("重复 claim 必须失败（已被认领）", not _rc2, _rc2)
check("claim 后状态是 in_progress", read_card("k1")["status"] == "in_progress", read_card("k1")["status"])
check("另一张卡不受影响", read_card("k2")["status"] == "todo", read_card("k2")["status"])
check("claim 后看板形状合法", ns.board_shape_errors(json.load(open(BOARD, encoding="utf-8"))) == [], "shape")

print("\n=== 结果：%s ===" % ("全部通过" if not fails else "失败 %d 项：%s" % (len(fails), fails)))
sys.exit(1 if fails else 0)
