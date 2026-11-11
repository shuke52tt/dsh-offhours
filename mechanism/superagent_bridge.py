#!/usr/bin/env python3
"""dsh-offhours × dsh-superagent 的 Issue 桥接（方案 A）。

夜间跑批只负责：低谷/预算闸门 + 把 KANBAN 卡变成 Gitea `agent:ready`/@agent issue。
superagent 负责：Source → Eval → Ticket → 独立 Session/worktree → PR/评审/attention。
本桥接不执行代码、不合并 PR、不修改 superagent 的 policy。

用法：
  superagent_bridge.py dispatch <BOARD> --config <config.json> [--limit N] [--dry-run]
  superagent_bridge.py sync     <BOARD> --config <config.json>
  superagent_bridge.py status   <BOARD> --config <config.json>

卡片上写入的字段（ns.py/面板会忽略未知字段）：
  superagentIssue: {number, url, at}
  superagentPr:    {number, url, state}
  superagentState: issue-open | pr-open | merged | reviewed | failed
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def log(msg: str) -> None:
    print(f"[superagent-bridge] {msg}", file=sys.stderr)


def load_json(path: str):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def atomic_write(path: str, data) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=p.name + ".", dir=str(p.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        os.replace(tmp, path)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


def with_board_lock(board_path: str):
    """Sidecar lock; ns.py/panel writes are short, this serialises bridge RMW only."""
    class _Lock:
        def __enter__(self):
            self.fh = open(board_path + ".superagent.lock", "a+")
            fcntl.flock(self.fh, fcntl.LOCK_EX)
            return self
        def __exit__(self, *exc):
            fcntl.flock(self.fh, fcntl.LOCK_UN)
            self.fh.close()
    return _Lock()


def board_config(config: dict, board_path: str) -> dict | None:
    target = os.path.realpath(board_path)
    for b in config.get("boards", []):
        if os.path.realpath(str(b.get("file") or "")) == target:
            return b
    return None


def superagent_config(config: dict, board: dict) -> dict:
    sa = config.get("superagent") or {}
    if board.get("executor", config.get("executor", "local")) != "superagent":
        raise SystemExit("board.executor 不是 superagent")
    missing = [k for k in ("cli", "tokenFile", "repo") if not sa.get(k)]
    if missing:
        raise SystemExit("superagent 配置缺少：" + ",".join(missing))
    if not os.path.exists(sa["tokenFile"]):
        raise SystemExit(f"superagent tokenFile 不存在：{sa['tokenFile']}")
    if not os.access(sa["cli"], os.X_OK):
        raise SystemExit(f"superagent cli 不可执行：{sa['cli']}")
    return {
        "cli": sa["cli"],
        "tokenFile": sa["tokenFile"],
        "repo": sa["repo"],
        "mention": str(sa.get("mention") or "@dsh-agent"),
        "issueLabel": str(sa.get("issueLabel") or "agent:ready"),
        "baseUrl": str(sa.get("baseUrl") or "").rstrip("/"),
        "orchestratorUrl": str(sa.get("orchestratorUrl") or "http://127.0.0.1:3082").rstrip("/"),
        "stallMinutes": int(sa.get("stallMinutes") or 30),
    }


def api(sa: dict, method: str, path: str, fields: dict | None = None):
    env = dict(os.environ)
    env["GITEA_TOKEN_FILE"] = sa["tokenFile"]
    args = [sa["cli"], "api", path]
    if method != "GET":
        args += ["--method", method]
    for k, v in (fields or {}).items():
        args += ["-f", f"{k}={v}"]
    p = subprocess.run(args, capture_output=True, text=True, env=env, timeout=60)
    if p.returncode != 0:
        raise RuntimeError(f"gitea api {method} {path} 失败（rc={p.returncode}）：{(p.stderr or p.stdout)[:500]}")
    try:
        return json.loads(p.stdout or "null")
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"gitea api 返回非 JSON（{path}）：{p.stdout[:300]}") from exc


def marker(board: dict, cid: str) -> str:
    return f"<!-- offhours:card={cid} board={board.get('id','')} -->"


def issue_body(board: dict, card: dict, sa: dict) -> str:
    cid = str(card.get("id") or "")
    summary = str(card.get("summary") or card.get("description") or "").strip()
    desc = str(card.get("description") or "").strip()
    title = str(card.get("title") or cid)
    parts = [
        f"来自夜间跑批看板 `{board.get('id','')}` 的卡：**{title}**",
        "",
        summary or "（无摘要；请按 issue 标题执行，并在完成前给出可复核证据。）",
        "",
        *(["", "卡片补充/人工确认：", desc] if desc and desc != summary else []),
        f"{sa['mention']} 请按本 issue 执行；这是夜间跑批准入的任务，不是讨论请求。",
        "",
        "结束纪律：前台等命令结束（job_output wait=true），不要用“等后台 gate”结束回合；完成后必须给出 report，无法完成时报告 blocked/attention，不要静默结束。",
        "",
        marker(board, cid),
    ]
    return "\n".join(parts)


def find_card(board_data: dict, cid: str):
    return next((c for c in board_data.get("cards", []) if c.get("id") == cid), None)


def eligible(card: dict) -> bool:
    if card.get("status") != "todo":
        return False
    tags = [str(t).lower() for t in (card.get("tags") or [])]
    if "hold" in tags or "blocked" in tags or "decision-needed" in tags:
        return False
    if "auto" not in tags and "superagent" not in tags:
        return False
    return True


def cmd_dispatch(board_path: str, config_path: str, limit: int, dry: bool, force: bool = False) -> int:
    config = load_json(config_path)
    board = board_config(config, board_path)
    if not board:
        raise SystemExit(f"配置里找不到看板：{board_path}")
    sa = superagent_config(config, board)
    if not dry and not force:
        # offpeak 是硬闸门；superagent 自己也会 peak-pause，但不在峰段创建新 issue。
        p = subprocess.run([sys.executable, str(Path(__file__).with_name("ns.py")), "offpeak"],
                           capture_output=True, text=True, timeout=10)
        if p.returncode != 0:
            log("当前不是低谷，跳过 dispatch")
            return 0
    with with_board_lock(board_path):
        data = load_json(board_path)
        candidates = [c for c in data.get("cards", []) if eligible(c) and not c.get("superagentIssue")]
        if not candidates:
            log("没有可 dispatch 的 todo(auto, 非 hold)")
            return 0
        if dry:
            c = candidates[0]
            print(json.dumps({
                "wouldCreate": {
                    "repository": sa["repo"],
                    "title": f"[offhours] {c.get('title') or c.get('id')}",
                    "body": issue_body(board, c, sa),
                }
            }, ensure_ascii=False, indent=2))
            return 0
        created = 0
        for card in candidates[:max(1, limit)]:
            cid = str(card.get("id") or "")
            title = f"[offhours] {str(card.get('title') or cid)[:120]}"
            issue = api(sa, "POST", f"repos/{sa['repo']}/issues", {
                "title": title,
                "body": issue_body(board, card, sa),
            })
            number = issue.get("number")
            url = issue.get("html_url") or (f"{sa['baseUrl']}/lengr/hemou/issues/{number}" if sa["baseUrl"] else "")
            card["status"] = "in_progress"
            card["superagentIssue"] = {"number": number, "url": url, "at": now_iso()}
            card["superagentState"] = "issue-open"
            card["updatedAt"] = now_iso()
            created += 1
            log(f"created issue #{number} for card {cid}")
        atomic_write(board_path, data)
    print(json.dumps({"created": created}, ensure_ascii=False))
    return 0


PR_RE = re.compile(r"https?://[^\s)>\]]+/pulls/(\d+)")

def local_api(sa: dict, path: str):
    """superagent 管理 API（仅本机回环，无需额外鉴权头之外的秘密）。"""
    url = sa.get("orchestratorUrl") or "http://127.0.0.1:3082"
    req = Request(url + path, headers={"x-orchestrator-request": "1"})
    with urlopen(req, timeout=8) as r:
        return json.loads(r.read().decode("utf-8"))


def local_post(sa: dict, path: str, payload: dict):
    url = (sa.get("orchestratorUrl") or "http://127.0.0.1:3082") + path
    req = Request(url, data=json.dumps(payload).encode("utf-8"),
                  headers={"x-orchestrator-request": "1", "content-type": "application/json"}, method="POST")
    with urlopen(req, timeout=8) as r:
        return json.loads(r.read().decode("utf-8"))


def cancel_ticket(sa: dict, ticket: dict | None) -> None:
    if not ticket or ticket.get("state") != "open":
        return
    try:
        local_post(sa, f"/orchestrator/api/tickets/{ticket['id']}/stop",
                   {"reason": "human confirmed the offhours card; take over"})
    except Exception:
        pass


def close_issue(sa: dict, number: int) -> None:
    try:
        api(sa, "PATCH", f"repos/{sa['repo']}/issues/{number}", {"state": "closed"})
    except Exception:
        pass


def find_ticket(sa: dict, issue_number: int, card_title: str):
    """找到这张 issue 对应的 superagent ticket；找不到返回 None。

    用 Thread key `github:<issue>` 做身份，而不是标题猜测；标题只用于先筛列表。
    """
    try:
        data = local_api(sa, "/orchestrator/api/tickets?state=all&limit=100")
    except Exception:
        return None
    items = data.get("items", []) or []
    want = card_title.strip()
    def matches(item):
        try:
            full = local_api(sa, f"/orchestrator/api/tickets/{item['id']}")
        except Exception:
            return None
        for th in full.get("threads", []) or []:
            if th.get("key") == f"github:{issue_number}":
                return full
        return None

    # 先按标题缩小范围（大多数卡标题与 issue 标题一致）；
    for item in items:
        title = str(item.get("title") or "").strip()
        if want and want not in title and f"[offhours] {want}" not in title:
            continue
        got = matches(item)
        if got:
            return got
    # 标题被人工改过/工单标题被 superagent 重写时，按 Thread key 全量兜底。
    for item in items:
        title = str(item.get("title") or "").strip()
        if want and (want in title or f"[offhours] {want}" in title):
            continue
        got = matches(item)
        if got:
            return got
    return None


def ticket_status(ticket: dict | None):
    if not ticket:
        return None
    if ticket.get("attention"):
        return "review", "attention"
    ended = ticket.get("ended") or {}
    if ticket.get("state") == "ended":
        outcome = str(ended.get("outcome") or "")
        return ("done" if outcome in ("merged", "completed") else "review", "ticket-ended")
    if ticket.get("stage") == "working":
        return "in_progress", "working"
    return "review", "person"


def _pr_from_comments(comments) -> int | None:
    for c in comments or []:
        m = PR_RE.search(str(c.get("body") or ""))
        if m:
            return int(m.group(1))
    return None


def cmd_sync(board_path: str, config_path: str) -> int:
    config = load_json(config_path)
    board = board_config(config, board_path)
    if not board:
        raise SystemExit(f"配置里找不到看板：{board_path}")
    sa = superagent_config(config, board)
    with with_board_lock(board_path):
        data = load_json(board_path)
        changed = 0
        for card in data.get("cards", []):
            issue = card.get("superagentIssue")
            if not issue or not issue.get("number"):
                continue
            n = int(issue["number"])
            # 人工确认后 ns.py 把卡改回 todo 并写【确认】块；此时旧 ticket/issue 不能再把卡拉回 review。
            # 先停止旧 ticket、关闭旧 issue、清掉 superagent 关联，让下一轮 dispatch 按新确认重新派发。
            if card.get("status") == "todo" and "【确认 " in str(card.get("description") or ""):
                t = find_ticket(sa, n, str(card.get("title") or ""))
                cancel_ticket(sa, t)
                close_issue(sa, n)
                for k in ("superagentIssue", "superagentPr", "superagentTicket"):
                    card.pop(k, None)
                card["superagentState"] = "human-confirmed"
                card["updatedAt"] = now_iso()
                changed += 1
                continue
            issue_obj = api(sa, "GET", f"repos/{sa['repo']}/issues/{n}")
            state = str(issue_obj.get("state") or "open")
            comments = api(sa, "GET", f"repos/{sa['repo']}/issues/{n}/comments")
            pr_num = _pr_from_comments(comments)
            pr = api(sa, "GET", f"repos/{sa['repo']}/pulls/{pr_num}") if pr_num else None
            old = (card.get("status"), card.get("superagentState"), (card.get("superagentPr") or {}).get("state"))
            if pr:
                pr_state = "merged" if pr.get("merged") or pr.get("merged_at") else ("closed" if str(pr.get("state")) == "closed" else "open")
                card["superagentPr"] = {"number": pr_num, "url": pr.get("html_url") or "", "state": pr_state}
                if pr_state == "merged" or (state == "closed" and pr_state != "open"):
                    card["status"] = "done"
                    card["superagentState"] = "merged"
                elif pr_state == "closed":
                    card["status"] = "review"
                    card["superagentState"] = "reviewed"
                else:
                    card["status"] = "review"
                    card["superagentState"] = "pr-open"
            elif state == "closed":
                card["status"] = "review"
                card["superagentState"] = "reviewed"
            else:
                card["status"] = "in_progress"
                card["superagentState"] = "issue-open"
            ticket = find_ticket(sa, n, str(card.get("title") or ""))
            if ticket:
                card["superagentTicket"] = {"id": ticket.get("id"), "title": ticket.get("title")}
                ts = ticket_status(ticket)
                if ts:
                    tstatus, tstate = ts
                    # PR merged / ticket merged 都算 done；attention/working 以 ticket 实时状态为准。
                    if card.get("superagentState") == "merged" or tstatus == "done":
                        card["status"] = "done"; card["superagentState"] = "merged"
                    elif tstatus == "review":
                        card["status"] = "review"; card["superagentState"] = tstate
                    elif card.get("status") != "review":
                        card["status"] = "in_progress"; card["superagentState"] = tstate
                # 防静默卡死：worker 可能结束回合却不再 report（等后台 gate 的已知失败模式）。
                # 超过 stallMinutes 仍是 working 且无 report/attention ⇒ 卡转 review，让人看见。
                if tstate == "working" and card.get("status") == "in_progress":
                    at = str((card.get("superagentIssue") or {}).get("at") or "")
                    try:
                        started = datetime.fromisoformat(at).timestamp()
                    except Exception:
                        started = 0
                    if started and time.time() - started > max(1, sa["stallMinutes"]) * 60:
                        card["status"] = "review"; card["superagentState"] = "stalled"
            if (card.get("status"), card.get("superagentState"), (card.get("superagentPr") or {}).get("state")) != old:
                card["updatedAt"] = now_iso()
                changed += 1
        atomic_write(board_path, data)
    print(json.dumps({"changed": changed}, ensure_ascii=False))
    return 0


def cmd_status(board_path: str, config_path: str) -> int:
    config = load_json(config_path)
    board = board_config(config, board_path)
    if not board:
        raise SystemExit(f"配置里找不到看板：{board_path}")
    sa = superagent_config(config, board)
    data = load_json(board_path)
    rows = [{"id": c.get("id"), "title": c.get("title"), "status": c.get("status"),
             "issue": c.get("superagentIssue"), "pr": c.get("superagentPr"),
             "state": c.get("superagentState")}
            for c in data.get("cards", []) if c.get("superagentIssue")]
    print(json.dumps({"executor": "superagent", "repo": sa["repo"], "cards": rows}, ensure_ascii=False, indent=2))
    return 0


def main(argv) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["dispatch", "sync", "status"])
    ap.add_argument("board")
    ap.add_argument("--config", default=os.environ.get("OFFHOURS_CONFIG") or os.environ.get("NIGHTSHIFT_SUPERAGENT_CONFIG"))
    ap.add_argument("--limit", type=int, default=1)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true")
    ns = ap.parse_args(argv)
    if not ns.config:
        raise SystemExit("需要 --config 或 OFFHOURS_CONFIG")
    if ns.command == "dispatch":
        return cmd_dispatch(ns.board, ns.config, ns.limit, ns.dry_run, ns.force)
    if ns.command == "sync":
        return cmd_sync(ns.board, ns.config)
    return cmd_status(ns.board, ns.config)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
