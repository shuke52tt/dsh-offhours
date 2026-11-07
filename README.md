# dsh-offhours

DeepSeek Harness 社区插件：把看板里的待办，在**低谷/夜间**自动做掉。

- 只做一件事：`todo` 卡 → 每卡一个独立 git worktree → headless worker 干活并自证 → 证据写回卡 → 合并回收。
- 不需要 cron/systemd：插件进程内按 interval 自己扫；也可以手动 `offhours run --once`。
- 你的数据只在本地：看板是 `KANBAN.json`，状态/日志在 `stateDir`，不上传。

## 安装

```bash
dsh plugin --profile web add dsh-offhours
```

装完重启一次 `dsh web`（或让 HMR 生效），左侧出现「夜间跑批」面板。

## 三步开始

```bash
# 1) 在你要跑批的 git 仓库里初始化（写配置 + 建/关联特性 + 生成看板）
cd ~/code/myapp
offhours init --repo . --name myapp

# 2) 体检（依赖、路径、worker 权限）
offhours doctor

# 3) 建一张卡（自动盖当前会话；没有 session 的卡跑批不会捡）
offhours card add "给登录页补错误提示" \
  --summary "目标：登录失败有提示。判据：npm test 通过。不做什么：不改后端。"
```

之后低谷时段自动跑；也可以用面板「立即跑」或 `offhours run --once`。

## 配置

`~/.dsh/offhours/config.json`（`offhours init` 生成）：

```json
{
  "stateDir": "~/.dsh/offhours/state",
  "featuresRoot": "~/.dsh/offhours/features",
  "dshBin": "dsh",
  "dshProfile": "headless",
  "scheduler": "plugin",
  "repos": {
    "myapp": { "path": "~/code/myapp", "baseBranch": "main" }
  },
  "boards": [
    { "id": "myapp", "file": "~/code/myapp/KANBAN.json", "workdir": "~/code/myapp", "repos": ["myapp"] }
  ],
  "gates": { "maxCardsPerRun": 3, "maxCardsPerDay": 8, "maxCnyPerDay": 20 },
  "schedule": { "enabled": true, "intervalMin": 5 },
  "worker": { "permissionMode": "danger-full-access" }
}
```

- `baseBranch` 支持 `main`/`master`/任意分支；不写则按 `origin/HEAD`、main、master 依次探测。
- `worker.permissionMode` 默认 `danger-full-access`：worker 要写 `<repo>/.git/worktrees` 才能提交。
  这是无人值守的结构性要求；不信任仓库内容时不要装这个插件。

## 命令

| 命令 | 作用 |
|---|---|
| `offhours init --repo .` | 初始化配置/看板/特性 |
| `offhours doctor` | 依赖与权限体检（失败退出非 0） |
| `offhours card add "<标题>" --summary "<目标/判据/边界>"` | 建卡并盖章当前会话 |
| `offhours card list` | 列卡 |
| `offhours run --once` / `--dry-run` | 手动跑一轮 / 只看会挑哪张 |
| `offhours status` | 看板计数、心跳、最近状态（JSON） |
| `offhours boards` | 看板列表 |

## 依赖

Linux（WSL 可用）：`bash`、`python3`、`git`、`jq`、`flock`、`dsh`；`zstd` 可选（成本统计）。
macOS 暂不支持（引擎用到 `flock`、`/proc`、GNU `readlink -f` 等）；Windows 走 WSL。

## 安全与边界

- worker 在独立 worktree 里工作，主检出由引擎的跑批前后侦测兜底；建议同时启用 `feature-guard` 钩子。
- 送审只留 5 类：选型不确定 / 影响演进 / 实施成本 / 条件做不成 / 政策风险。
- 卡里必须有可机械核对的判据（命令），否则 worker 不得报 done。

## 开发

```bash
node scripts/gen-client.mjs     # 生成 lib/client.js（只替换注册 id）
node --test tests/node/*.test.mjs
bash tests/run-all.sh
npm pack
```

MIT License。
