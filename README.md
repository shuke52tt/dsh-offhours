# dsh-offhours

DeepSeek Harness 社区插件：把看板里的待办，在**低谷/夜间**自动做掉。

- 只做一件事：`todo` 卡 → 每卡一个独立 git worktree → headless worker 干活并自证 → 证据写回卡 → 合并回收。
- 不需要 cron/systemd：插件进程内按 interval 自己扫；也可以手动 `npx dsh-offhours run --once`。
- 你的数据只在本地：看板是 `KANBAN.json`，状态/日志在 `stateDir`，不上传。

## 安装

```bash
dsh plugin --profile web add dsh-offhours
```

装完重启一次 `dsh web`（或让 HMR 生效），左侧出现「夜间跑批」面板。

> 为什么下面的命令写 `npx dsh-offhours`：安装插件不会把 CLI 加进全局 PATH；`npx` 会直接运行刚装好的同一个入口（首次会从 npm 取包）。如果你已经全局安装，可以简写成 `offhours`。

## 三步开始

```bash
# 1) 在你要跑批的 git 仓库里初始化（写配置 + 建/关联特性 + 生成看板）
cd ~/code/myapp
npx dsh-offhours init --repo . --name myapp

# 2) 体检（依赖、路径、worker 权限）
npx dsh-offhours doctor

# 3) 建一张卡（必须在 dsh 会话里，或显式传当前会话 id）
#    最省事：在 dsh 里对 agent 说「用 offhours 技能建一张卡：给登录页补错误提示」。
#    终端命令需要带 --session；没有 sourceSessionId 的卡跑批永远不会捡。
npx dsh-offhours card add "给登录页补错误提示" \
  --summary "目标：登录失败有提示。判据：npm test 通过。不做什么：不改后端。" \
  --session <当前 dsh 会话 id>
```

之后低谷时段自动跑；也可以用面板「立即跑」或 `npx dsh-offhours run --once`。

如果打开面板看到「先完成一次性初始化」，说明配置还没生成：在项目仓库执行上面的 `init`，刷新面板即可；不需要重装插件。

装完/升级插件后记得重启一次 `dsh web`，面板才会加载新代码。

## 可选：把卡交给 dsh-superagent 执行（Issue 桥接）

默认 `executor=local`：夜间跑批自己起 headless worker。  
也可以让指定的看板走 **superagent 执行器**：夜间跑批只在低谷把 `todo(auto)` 卡变成 Gitea issue，superagent 的 Source → Eval → Ticket → Executor 负责独立 worktree、PR、评审和 attention；夜间跑批只回写卡状态。

```json
{
  "executor": "superagent",
  "superagent": {
    "cli": "/path/to/gh-gitea",
    "tokenFile": "~/.config/dsh-superagent/gitea-operator-token",
    "repo": "<owner>/<repo>",
    "baseUrl": "https://gitea.example.com",
    "mention": "@dsh-agent"
  },
  "boards": [
    { "id": "myapp", "file": "~/code/myapp/KANBAN.json", "executor": "superagent" }
  ]
}
```

- `tokenFile` 必须是**有权创建 issue 的操作者** token（不是 agent 自己的 token）；agent token 创建的 issue 会被 superagent Source 当作自己的消息过滤掉。
- 只有 `todo` + `auto` + 非 `hold` 的卡会被派发；卡片状态会写 `superagentIssue` / `superagentPr` / `superagentState`。
- `stallMinutes`（默认 30）：ticket 长时间 `working` 但无 report/attention 时，卡自动转 `review`（防 worker 等后台 gate 静默卡死）；issue 正文也会要求“前台等命令、必须 report”。
- `dispatch` 只在低谷执行；峰段由 superagent 的 peak-pause 再兜底。
- **不自动合并代码 PR**：PR 打开 → 卡 `review`；PR 合并 → 卡 `done`；issue 被关但未合并 → 卡 `review`。
- superagent 与夜间跑批共用同一个仓库，superagent 的 `maxWorkers` 建议保持 1，避免同仓库并发写。

手动命令：

```bash
npx dsh-offhours superagent status  --board myapp
npx dsh-offhours superagent dispatch --board myapp --dry-run
npx dsh-offhours superagent sync     --board myapp
```

## 配置

`~/.dsh/offhours/config.json`（`npx dsh-offhours init` 生成）：

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
| `npx dsh-offhours init --repo .` | 初始化配置/看板/特性 |
| `npx dsh-offhours doctor` | 依赖与权限体检（失败退出非 0） |
| `npx dsh-offhours card add "<标题>" --summary "<目标/判据/边界>" [--session <id>]` | 建卡并盖章会话（无 session 不会跑） |
| `npx dsh-offhours card list` | 列卡 |
| `npx dsh-offhours run --once` / `--dry-run` | 手动跑一轮 / 只看会挑哪张 |
| `npx dsh-offhours status` | 看板计数、心跳、最近状态（JSON） |
| `npx dsh-offhours boards` | 看板列表 |

> 不想走 npx：装完后 CLI 也在 profile 的 `node_modules/.bin/offhours`（例如 `~/.dsh/profiles/web/node_modules/.bin/offhours`），可以直接用绝对路径调用。

## 依赖

Linux（WSL 可用）：`bash`、`python3`、`git`、`jq`、`flock`、`dsh`；`zstd` 可选（成本统计）。
macOS 暂不支持（引擎用到 `flock`、`/proc`、GNU `readlink -f` 等）；Windows 走 WSL。

## 安全与边界

- worker 在独立 worktree 里工作，主检出由引擎的跑批前后侦测兜底；建议同时启用 `feature-guard` 钩子。
- 送审只留 5 类：选型不确定 / 影响演进 / 实施成本 / 条件做不成 / 政策风险。
- 卡里必须有可机械核对的判据（命令），否则 worker 不得报 done。

## 社区 / Community

- **源码**：https://github.com/shuke52tt/dsh-offhours
- **npm**：https://www.npmjs.com/package/dsh-offhours（`npx dsh-offhours ...`）
- **dshmarket 索引 PR**：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/13017
- **官方 Show Your Plugins**：https://github.com/deepseek-ai/deepseek-harness/discussions/12568

欢迎在官方帖或 issue 里反馈；插件按 MIT 发布。

## 开发

```bash
node scripts/gen-client.mjs     # 生成 lib/client.js（只替换注册 id）
node --test tests/node/*.test.mjs
bash tests/run-all.sh
npm pack
```

MIT License。

## 自动采集数据（dsh-rsi）

RSI 自动采集的资产/经验**不放在 main**：完整历史（211 个提交、9990 个文件）在分支 **`data/dsh-rsi`**，
该子树已被 `.gitignore` 挡住，不会随日常提交回到主干。要用它：

```bash
git fetch gitea data/dsh-rsi && git worktree add /tmp/rsi gitea/data/dsh-rsi
```

要把它变成**独立仓库**（推荐，需一次人工登录态）：

```bash
glops token --create --name glops      # 生成并保存令牌（仅一次）
glops create dsh-rsi-data --desc "dsh-rsi 采集数据"
git -C <你的 dsh-nightshift 检出> push "$(glops url <owner>/dsh-rsi-data | awk '/SSH/{print $NF}')" data/dsh-rsi:main
```
