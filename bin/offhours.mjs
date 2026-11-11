#!/usr/bin/env node
/**
 * dsh-offhours CLI —— 给社区用户的唯一入口（不依赖面板也能跑）。
 *
 *   offhours init --repo ~/code/app           写配置 + 建/关联特性 + 生成看板
 *   offhours doctor                           依赖/配置/权限体检（失败退出非 0）
 *   offhours card add "标题" --summary "..."   建卡（自动盖当前会话，跑批才捡得到）
 *   offhours card list                        列卡
 *   offhours run [--once|--dry-run|--force]   手动跑一轮
 *   offhours status                           状态摘要（JSON）
 *   offhours boards                           看板列表
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import {
  defaultConfig, defaultConfigPath, featureBin, loadConfig, nsPy, packageRoot,
  resolveBoard, saveConfig, scanEnv, scanScript, scanEnv as _scanEnv,
} from '../lib/config.js'

const HELP = `dsh-offhours —— 夜间/低谷自动跑批（配一个 git 仓库就能用）

装完插件后不需要全局安装 CLI，用 npx 调用即可：
  npx dsh-offhours init --repo <git仓库路径> [--name 名称] [--board KANBAN.json] [--feature 特性名]
  npx dsh-offhours doctor
  npx dsh-offhours card add "<标题>" --summary "<目标/判据>" [--tags auto] [--board id]
  npx dsh-offhours card list [--board id]
  npx dsh-offhours run [--once] [--dry-run] [--force] [--board id]
  npx dsh-offhours status [--board id]
  npx dsh-offhours boards
  npx dsh-offhours superagent dispatch|sync|status [--board id] [--dry-run] [--force]

如果你已经全局安装了本包，也可以把 npx dsh-offhours 换成 offhours。
全局：--config <path>（默认 ~/.dsh/offhours/config.json）

约束：worker 需要 dsh、python3、bash、git、jq、flock；zstd 可选（成本统计）。
`

function parse(argv) {
  const out = { _: [], flags: {} }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--config') { out.flags.config = argv[++i]; continue }
    if (a.startsWith('--config=')) { out.flags.config = a.slice(9); continue }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) out.flags[a.slice(2, eq)] = a.slice(eq + 1)
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out.flags[a.slice(2)] = argv[++i]
      else out.flags[a.slice(2)] = true
      continue
    }
    out._.push(a)
  }
  return out
}

function die(msg, code = 1) {
  console.error(`dsh-offhours: ${msg}`)
  process.exit(code)
}

function loadOrDie(flags) {
  const { config, path, exists } = loadConfig(flags.config)
  if (!exists) die(`没有配置：${path}\n先运行：npx dsh-offhours init --repo <你的 git 仓库>`)
  if (!config.boards.length) die(`配置里没有看板：${path}\n先运行：npx dsh-offhours init --repo <你的 git 仓库>`)
  return { cfg: config, path }
}

function which(cmd) {
  const r = spawnSync('bash', ['-lc', `command -v ${cmd}`], { encoding: 'utf8' })
  return r.status === 0 ? String(r.stdout || '').trim() : ''
}

function detectBase(repo) {
  const r = spawnSync('git', ['-C', repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { encoding: 'utf8' })
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split('/').pop()
  for (const b of ['main', 'master']) {
    const q = spawnSync('git', ['-C', repo, 'show-ref', '--verify', '--quiet', `refs/heads/${b}`])
    if (q.status === 0) return b
  }
  return 'main'
}

function cmdInit(flags) {
  const repo = resolve(flags.repo || process.cwd())
  if (!existsSync(join(repo, '.git'))) die(`不是 git 仓库：${repo}`)
  const name = String(flags.name || basename(repo)).replace(/[^A-Za-z0-9_-]+/g, '-')
  const boardFile = resolve(String(flags.board || join(repo, 'KANBAN.json')))
  const cfgPath = resolve(flags.config || defaultConfigPath())
  if (existsSync(cfgPath) && !flags.force) die(`配置已存在：${cfgPath}（要重建加 --force）`)
  const base = String(flags['base-branch'] || detectBase(repo))
  const feature = String(flags.feature || 'offhours')
  const cfg = defaultConfig()
  cfg.stateDir = resolve(String(flags['state-dir'] || join(cfg.stateDir)))
  cfg.featuresRoot = resolve(String(flags['features-root'] || join(cfg.featuresRoot)))
  cfg.dshHome = process.env.DSH_HOME || cfg.dshHome
  cfg.repos = { [name]: { path: repo, baseBranch: base, remote: String(flags.remote || '') } }
  cfg.boards = [{
    id: name, label: name, file: boardFile, workdir: repo, repos: [name],
    requireAuto: false, enabled: true, unit: '', envFile: '',
  }]
  if (String(flags.scheduler || 'plugin') === 'systemd') cfg.scheduler = 'systemd'
  if (flags.interval) cfg.schedule.intervalMin = Number(flags.interval)
  if (!existsSync(boardFile)) {
    mkdirSync(join(boardFile, '..'), { recursive: true })
    writeFileSync(boardFile, '{\n  "version": 1,\n  "cards": []\n}\n', 'utf8')
  }
  mkdirSync(cfg.featuresRoot, { recursive: true })
  // 合并已有登记表：init 一个新仓库不能把用户之前登记的仓库冲掉。
  let registry = {}
  try { registry = JSON.parse(readFileSync(join(cfg.featuresRoot, '.repos.json'), 'utf8')) || {} } catch { /* 首次初始化 */ }
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) registry = {}
  registry[name] = { path: repo, baseBranch: base }
  writeFileSync(join(cfg.featuresRoot, '.repos.json'),
    JSON.stringify(registry, null, 2) + '\n', 'utf8')
  saveConfig(cfgPath, cfg)

  const env = {
    ...process.env,
    FEATURE_ROOT: cfg.featuresRoot,
    DSH_SESSION_ID: String(flags.session || process.env.DSH_SESSION_ID || ''),
  }
  const fb = featureBin(cfg)
  const args = ['new', feature, '--repos', name, '--from', base]
  let r = spawnSync(fb, args, { env, encoding: 'utf8' })
  if (r.status !== 0) r = spawnSync(fb, ['ensure', feature, '--repos', name], { env, encoding: 'utf8' })
  const featOut = String((r.stdout || r.stderr || '').trim()).split('\n').slice(-2).join('\n')
  // feature CLI 可能把登记表改写成字符串；补回 baseBranch，且不丢已有仓库。
  try {
    let reg2 = JSON.parse(readFileSync(join(cfg.featuresRoot, '.repos.json'), 'utf8')) || {}
    if (!reg2 || typeof reg2 !== 'object' || Array.isArray(reg2)) reg2 = {}
    reg2[name] = { path: repo, baseBranch: base }
    writeFileSync(join(cfg.featuresRoot, '.repos.json'), JSON.stringify(reg2, null, 2) + '\n', 'utf8')
  } catch { /* 保留 feature 的写法 */ }

  console.log(`✓ 配置：${cfgPath}`)
  console.log(`✓ 仓库：${name} → ${repo}（基准分支 ${base}）`)
  console.log(`✓ 看板：${boardFile}`)
  console.log(`✓ 特性：${feature}（${r.status === 0 ? '已建立/已关联' : '建立失败，可稍后 feature attach'}）`)
  if (featOut) console.log(featOut)
  console.log('')
  console.log('下一步：')
  console.log('  npx dsh-offhours doctor')
  console.log('  npx dsh-offhours card add "第一张卡" --summary "目标/判据/不做什么"')
  console.log('  npx dsh-offhours run --once')
}

function cmdDoctor(flags) {
  const { config: cfg, path, exists } = loadConfig(flags.config)
  if (!exists) {
    console.log(`未配置：${path}`)
    console.log('先运行：npx dsh-offhours init --repo <你的 git 仓库>')
  }
  const rows = []
  const fail = []
  const hard = (name, ok, detail = '') => {
    rows.push([name, ok ? 'ok' : 'FAIL', detail])
    if (!ok) fail.push(name)
  }
  hard('配置文件', existsSync(path), path)
  hard('看板数量', cfg.boards.length > 0, `${cfg.boards.length} 个`)
  for (const b of cfg.boards) {
    hard(`看板 ${b.id}`, existsSync(b.file), b.file)
    hard(`仓库 ${b.repos[0] || '?'}`, !!cfg.repos[b.repos[0]] && existsSync(cfg.repos[b.repos[0]].path),
      (cfg.repos[b.repos[0]] || {}).path || '(未登记)')
  }
  if (cfg.boards.some((b) => b.executor === 'superagent')) {
    const sa = cfg.superagent || {}
    hard('superagent cli', !!sa.cli && existsSync(sa.cli), sa.cli || '未配置')
    hard('superagent token', !!sa.tokenFile && existsSync(sa.tokenFile), sa.tokenFile || '未配置')
    hard('superagent repo', !!sa.repo, sa.repo || '未配置')
  }
  for (const [name, bin] of [['python3', 'python3'], ['bash', 'bash'], ['git', 'git'], ['jq', 'jq'], ['flock', 'flock'], ['dsh', cfg.dshBin]]) {
    const p = which(bin)
    hard(name, !!p, p || '未找到')
  }
  if (!which('zstd')) rows.push(['zstd', 'warn', '未安装：成本统计会降级，其余功能可用'])
  hard('scan.sh', existsSync(scanScript(cfg)), scanScript(cfg))
  hard('ns.py', existsSync(nsPy(cfg)), nsPy(cfg))
  hard('feature CLI', existsSync(featureBin(cfg)), featureBin(cfg))
  if (process.platform !== 'linux') rows.push(['平台', 'warn', `${process.platform}：v1 只承诺 Linux（WSL 可用）`])
  rows.push(['worker 权限', 'info', cfg.worker.permissionMode])
  const width = Math.max(...rows.map((r) => r[0].length))
  for (const [k, st, d] of rows) console.log(`  ${k.padEnd(width)}  ${String(st).padEnd(5)} ${d}`)
  if (fail.length) die(`体检未通过：${fail.join('、')}`)
  console.log('\n体检通过。')
}

function boardOf(cfg, flags) {
  const b = resolveBoard(cfg, flags.board)
  if (!b) die('没有可用看板')
  return b
}

function cmdCard(args, flags) {
  const { cfg } = loadOrDie(flags)
  const board = boardOf(cfg, flags)
  const sub = args[0] || 'list'
  if (sub === 'list') {
    const d = JSON.parse(readFileSync(board.file, 'utf8'))
    const rows = (d.cards || []).map((c) => [c.id, c.status, (c.tags || []).join(','), c.title])
    for (const r of rows) console.log(r.join('\t'))
    return
  }
  if (sub !== 'add') die('用法：offhours card add "<标题>" --summary "..."')
  const title = args.slice(1).join(' ').trim()
  if (!title) die('card add 需要一个标题')
  const sessionId = String(flags.session || process.env.DSH_SESSION_ID || '')
  if (!sessionId && !flags['allow-no-session']) {
    die('缺少会话 id：在 dsh 会话里运行，或显式加 --session <sessionId>。\n' +
      '没有 sourceSessionId 的卡不会被跑批捡起；确需建无主卡（只人工看）时加 --allow-no-session。')
  }
  const pyArgs = [nsPy(cfg), 'card-add', board.file, title, '--session', sessionId]
  for (const k of ['summary', 'description', 'rationale', 'rejected', 'tags', 'status', 'run-timeout']) {
    if (flags[k] !== undefined) pyArgs.push(`--${k}`, String(flags[k]))
  }
  if (flags['no-explain']) pyArgs.push('--no-explain')
  const env = { ...process.env, DSH_SESSION_ID: sessionId }
  const r = spawnSync('python3', pyArgs, { env, encoding: 'utf8' })
  process.stdout.write(r.stdout || '')
  process.stderr.write(r.stderr || '')
  if (r.status !== 0) process.exit(r.status || 1)
}

function cmdRun(args, flags) {
  const { cfg } = loadOrDie(flags)
  const board = boardOf(cfg, flags)
  const scanArgs = []
  if (flags.dry || flags['dry-run']) scanArgs.push('--dry-run')
  else if (flags.force) scanArgs.push('--force')
  if (flags.max) scanArgs.push(`--max-cards=${flags.max}`)
  if (flags.only) scanArgs.push(`--only=${flags.only}`)
  const env = scanEnv(cfg, board)
  const child = spawn('bash', [scanScript(cfg), ...scanArgs], { env, stdio: 'inherit' })
  child.on('exit', (code) => process.exit(code || 0))
}

function cmdStatus(flags) {
  const { cfg } = loadOrDie(flags)
  const board = boardOf(cfg, flags)
  const read = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
  const boardData = read(board.file) || { cards: [] }
  const cards = Array.isArray(boardData.cards) ? boardData.cards : []
  const hb = read(join(cfg.stateDir, 'heartbeat.json'))
  const st = read(join(cfg.stateDir, `state-${board.id}.json`)) || {}
  const out = {
    ok: true,
    board: { id: board.id, file: board.file, workdir: board.workdir },
    counts: {
      todo: cards.filter((c) => c.status === 'todo').length,
      inProgress: cards.filter((c) => c.status === 'in_progress').length,
      review: cards.filter((c) => c.status === 'review').length,
      done: cards.filter((c) => c.status === 'done').length,
    },
    schedule: cfg.schedule,
    heartbeat: hb,
    state: st,
    problems: cfg.problems || [],
  }
  console.log(JSON.stringify(out, null, 2))
}

function main() {
  const { _, flags } = parse(process.argv.slice(2))
  const cmd = _[0]
  if (!cmd || flags.help || cmd === 'help') { console.log(HELP); return }
  if (cmd === 'init') return cmdInit(flags)
  if (cmd === 'doctor') return cmdDoctor(flags)
  if (cmd === 'card') return cmdCard(_.slice(1), flags)
  if (cmd === 'run') return cmdRun(_.slice(1), flags)
  if (cmd === 'status') return cmdStatus(flags)
  if (cmd === 'boards') {
    const { cfg } = loadOrDie(flags)
    for (const b of cfg.boards) console.log(`${b.id}\t${b.file}`)
    return
  }
  if (cmd === 'superagent') {
    const { cfg, path } = loadOrDie(flags)
    const board = boardOf(cfg, flags)
    const sub = _[1] || 'status'
    if (!['dispatch', 'sync', 'status'].includes(sub)) die('用法：superagent dispatch|sync|status')
    const py = join(packageRoot(), 'mechanism', 'superagent_bridge.py')
    const args = [py, sub, board.file, '--config', path]
    if (flags.limit) args.push('--limit', String(flags.limit))
    if (flags['dry-run']) args.push('--dry-run')
    if (flags.force) args.push('--force')
    const r = spawnSync('python3', args, { encoding: 'utf8', env: process.env })
    process.stdout.write(r.stdout || '')
    process.stderr.write(r.stderr || '')
    process.exit(r.status || 0)
  }
  die(`未知命令：${cmd}\n\n${HELP}`)
}

main()
