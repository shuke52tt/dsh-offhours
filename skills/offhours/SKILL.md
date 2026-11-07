---
name: offhours
description: "夜间/低谷自动跑批（dsh-offhours）：把看板待办在非高峰时段自动执行并回收。需要建卡、查状态、手动触发或排查跑批时使用。"
---

# offhours —— 夜间/低谷自动跑批

这个插件把看板（KANBAN.json）里 **带 sourceSessionId 的 todo 卡**在低谷时段自动做掉：
挑卡 → 每卡独占一个 git worktree → headless worker 干活并自证 → 证据写回卡 → 合并回源 worktree。

## 什么时候用它

- 用户说「把这件事放到晚上跑 / 低谷再跑 / 自动做掉」；
- 要查「昨晚跑了什么、现在卡在哪、为什么没跑」；
- 要把一批已确认的任务交给无人值守执行。

## 建卡（唯一正确入口）

```bash
offhours card add "<标题>" --summary "<目标 + 判据(命令) + 涉及面 + 不做什么>"
```

- 必须在 dsh 会话里执行：它会用 `DSH_SESSION_ID` 盖章 `sourceSessionId`；
  **没有 sourceSessionId 的卡跑批永远不会捡**（不是 bug，是隔离要求）。
- 用 dsh-kanban 的 `board_add` 建的卡不带 session，只适合人工看板，不适合跑批。
- 判据必须是命令，不是形容词；一张卡 = 一个可独立合并的成果。

## 查状态 / 手动跑

```bash
offhours doctor          # 依赖、配置、权限体检（先跑这个）
offhours status          # 看板计数 + 心跳 + 最近状态（JSON）
offhours run --once      # 手动跑一轮（生产调度器之外）
offhours run --dry-run   # 只看会挑哪张，不启动 worker
```

面板：dsh Web 左侧「夜间跑批」；`/offhours` 命令也可查状态。

## 硬规则

- 代码改动只能在卡片给出的 worktree 里做；主检出不许写、不许提交。
- 一张卡只做一件事，做完即停；不要新建卡、不要扇出子代理。
- 有证据才能报 done：把实际跑过的验证命令与输出写进 `KANBAN-EVIDENCE`。
- 不可逆操作、缺凭据、需要人拍板：停手，按卡片要求写审批单。
