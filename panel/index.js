/**
 * nightshift 面板 · 宿主半
 *
 * 只做两件事：读本地状态（零 token），以及两个操作（暂停/恢复、立即扫描一次）。
 * 路由：GET /nightshift/api/status、POST /nightshift/api/action
 * 所有读文件 / systemctl / spawn 都在 try/catch 里，失败返回人能看懂的一句话，绝不抛到 HTTP 层。
 */
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import {
  loadConfig, saveConfig, resolveBoard as resolveBoardCfg, scanEnv, nsPy as nsPyOf,
  scanScript as scanScriptOf, featureBin as featureBinOf,
} from '../lib/config.js'
import { launchScan, startScheduler, readHeartbeat, unitActive, listNightshiftTimers } from '../lib/runtime.js'

// 插件不强依赖任何服务：有 webServer 就挂面板；headless 里也能只跑调度器/CLI。
export const inject = []

// 模块级配置：apply() 时从 ~/.dsh/offhours/config.json 装载，之后所有读写都跟随它。
let CFG = null
let NS_DIR = ''
let LOG = ''
let RUNS = ''
let DISABLED = ''
let SCAN = ''
let BOARDS = []
let FEATURES_ROOT = ''
let DSH_HOME = ''

function applyConfig(cfg, path) {
  CFG = cfg
  CFG._path = path || ''
  NS_DIR = cfg.stateDir
  LOG = join(NS_DIR, 'nightshift.log')
  RUNS = join(NS_DIR, 'runs')
  DISABLED = join(NS_DIR, 'DISABLED')
  SCAN = scanScriptOf(cfg)
  BOARDS = cfg.boards
  FEATURES_ROOT = cfg.featuresRoot
  DSH_HOME = cfg.dshHome
}

function resolveBoard(requested) {
  return resolveBoardCfg(CFG, requested) || {
    key: 'unconfigured', label: 'unconfigured', path: '', workdir: '', timer: '', requireAuto: false, enabled: false,
  }
}
/** 可在面板里改的预算/阈值（白名单；键、默认值、范围、是否布尔）。
 *  写进 `env-<board>`，由单元的 EnvironmentFile 在**每次服务启动**时读取 ⇒ 无需 daemon-reload。 */
const BUDGET_KEYS = {
  MAX_CARDS_PER_DAY: { def: 8, min: 0, max: 64 },
  MAX_MINUTES_PER_DAY: { def: 120, min: 0, max: 1440 },
  MAX_CNY_PER_DAY: { def: 20, min: 0, max: 1000, float: true },
  IDLE_MIN: { def: 5, min: 0, max: 240, float: true },
  COOLDOWN_MIN: { def: 10, min: 0, max: 240 },
  MAX_CARDS_PER_RUN: { def: 3, min: 1, max: 16 },
  RUN_TIMEOUT: { def: 1200, min: 60, max: 7200 },
  STORM_MAX: { def: 10, min: 0, max: 200 },
  MAX_PARALLEL_PER_BOARD: { def: 2, min: 1, max: 8 },
  NIGHTSHIFT_MAX_WORKERS: { def: 3, min: 1, max: 16 },
  NIGHTSHIFT_ISOLATED_WORKTREE: { def: 0, min: 0, max: 1, bool: true },
}
const envFileOf = (b) => join(NS_DIR, b.envFile || `env-${b.key}`)

/** 源会话 → 它关联的特性/工程（面板分组用；文件不存在返回 ''）。 */
/** 面板只读摘要：人读字段一律截断（看板 JSON 仍是唯一真源）。
 *  2026-10-28：/status 实测 77.5 KB，其中 reviews 的 detail 单条就 9.8 KB、占总量的 89%——
 *  而客户端每 30s 无条件拉一次。截断后只保留列表要用的摘要，全文去卡片/看板看。 */
function clip(text, max) {
  const s = String(text || '')
  return s.length > max ? `${s.slice(0, max)}…（已截断，全文见看板 JSON）` : s
}

function sessionLabel(sid) {
  if (!sid) return ''
  try {
    const a = JSON.parse(readFileSync(join(FEATURES_ROOT, '.sessions', `${sid}.json`), 'utf8'))
    return [a.feature, a.project].filter(Boolean).join('/')
  } catch { return '' }
}

/** 读 env-<board>，返回 {overrides, effective, file}。文件缺失 ⇒ 全默认。 */
function readBudget(b) {
  const file = envFileOf(b)
  const overrides = {}
  if (CFG.scheduler !== 'systemd') {
    const map = {
      MAX_CARDS_PER_DAY: 'maxCardsPerDay', MAX_MINUTES_PER_DAY: null, MAX_CNY_PER_DAY: 'maxCnyPerDay',
      IDLE_MIN: 'idleMin', COOLDOWN_MIN: 'cooldownMin', MAX_CARDS_PER_RUN: 'maxCardsPerRun',
      RUN_TIMEOUT: 'runTimeout', STORM_MAX: 'stormMax', MAX_PARALLEL_PER_BOARD: 'maxParallel',
      NIGHTSHIFT_MAX_WORKERS: null, NIGHTSHIFT_ISOLATED_WORKTREE: null,
    }
    const effective = {}
    for (const k of Object.keys(BUDGET_KEYS)) {
      const ck = map[k]
      effective[k] = ck && CFG.gates[ck] !== undefined ? String(CFG.gates[ck]) : String(BUDGET_KEYS[k].def)
    }
    return { overrides: {}, effective, file: CFG._path || '' }
  }
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line)
      if (m && BUDGET_KEYS[m[1]] !== undefined) overrides[m[1]] = m[2]
    }
  } catch { /* 文件不存在 = 全默认 */ }
  const effective = {}
  for (const k of Object.keys(BUDGET_KEYS)) {
    effective[k] = overrides[k] !== undefined ? overrides[k] : String(BUDGET_KEYS[k].def)
  }
  return { overrides, effective, file }
}



/** 某张卡最近一轮的输出文件（runs/<时间>-<卡id>.out）。 */
function lastOutFor(cardId) {
  try {
    const files = readdirSync(join(NS_DIR, 'runs')).filter((f) => f.endsWith('.out') && (!cardId || f.includes(cardId)))
    if (!files.length) return ''
    files.sort()
    return join(NS_DIR, 'runs', files[files.length - 1])
  } catch { return '' }
}

/** 卡片描述里的处理会话 id（nightshift 机器块）。 */
function workerSessionOf(card) {
  const m = /<!--\s*nightshift:\s*worker=([^\s]+)/.exec(String((card && card.description) || ''))
  return m ? m[1] : ''
}

const boardState = (b) => join(NS_DIR, `state-${b.key}.json`)
const boardDay = (b) => join(NS_DIR, `day-${b.key}.json`)

/** 常驻 daemon 心跳年龄（秒）；没有心跳文件返回 null。scan.sh --daemon 每 10s 写一次。 */
function daemonHeartbeatAgeSec() {
  try {
    const ts = Number((readFileSync(join(NS_DIR, 'DAEMON.heartbeat'), 'utf8') || '0').trim())
    if (!ts) return null
    return Math.floor(Date.now() / 1000 - ts)
  } catch { return null }
}
const DAEMON_HB_STALE_SEC = 120
/** 'active' / 'stale(<n>s)' / 'unknown'：与 scan.sh 的 10s 心跳节拍对齐。 */
function daemonHeartbeatState() {
  const age = daemonHeartbeatAgeSec()
  if (age === null) return 'unknown'
  return age <= DAEMON_HB_STALE_SEC ? 'active' : `stale(${age}s)`
}

// 冷却时长与跑批保持同一来源：systemd 形态读 env-<board>；插件形态读 config.gates。
function cooldownFromEnvFile(key) {
  try {
    const txt = readFileSync(join(NS_DIR, 'env-' + key), 'utf8')
    const mm = txt.match(/^COOLDOWN_MIN=(\d+)/m)
    if (mm) return Number(mm[1])
  } catch { /* 忽略 */ }
  return 0
}
function cooldownMinFor(bd) { return cooldownFromEnvFile(bd && bd.key ? bd.key : "ops") }
const MAX_CARDS_PER_DAY = 8
const MAX_MINUTES_PER_DAY = 120
const RECEIPT_TITLE = '夜间跑批回执（自动维护）'
const DECISION_TAGS = ['decision-needed', 'human-review', 'blocking', 'legal', 'needs-direction']
const DECISION_TITLE_PREFIX = ['拍板', '人审', '要不要', '请裁决', 'need decision']
const LOG_TAIL = 30
const RUNS_SHOWN = 6

// ----------------------------------------------------------------- 小工具
function readText(p) {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}
function readJson(p) {
  const t = readText(p)
  if (t === null) return null
  try {
    return JSON.parse(t)
  } catch {
    return null
  }
}
function tailLines(text, n) {
  if (!text) return []
  return text.split('\n').filter((l) => l.trim() !== '').slice(-n)
}
function run(cmd, args, timeout = 4000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, maxBuffer: 256 * 1024 }, (err, stdout) => {
        resolve(err ? null : String(stdout || ''))
      })
    } catch {
      resolve(null)
    }
  })
}

/** 待审卡给窗口看的内容：**优先给 explain-plain 审批单**（窗口要按它渲染选项），
 *  没有审批单时退回原来的"送审说明"截断。 */
function approvalOrNote(description) {
  const text = String(description || '')
  const i = text.indexOf('【审批单 · explain-plain】')
  if (i >= 0) {
    const rest = text.slice(i)
    const j = rest.indexOf('\n【', 1)
    return (j > 0 ? rest.slice(0, j) : rest).trim()
  }
  return reviewNote(text)
}

/** 运行命令并**保留输出**（即使退出码非 0）——ns.py 用"非零退出 + 说明"表达正常拒绝，
 *  旧 run() 在非零时把 stdout 丢掉，于是"卡不存在"被显示成"执行失败"（2026-10-16 修）。 */
function nsEnv() {
  return {
    ...process.env,
    NIGHTSHIFT_RUNTIME_DIR: NS_DIR,
    NIGHTSHIFT_BOARD: (BOARDS[0] && BOARDS[0].file) || '',
    FEATURE_ROOT: FEATURES_ROOT,
    DSH_HOME,
  }
}

function runCapture(cmd, args, timeout = 15000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, maxBuffer: 256 * 1024, env: nsEnv() }, (err, stdout, stderr) => {
        resolve({
          code: err ? (err.code || 1) : 0,
          out: String(stdout || '').trim(),
          err: String(stderr || '').trim(),
        })
      })
    } catch (e) {
      resolve({ code: 1, out: '', err: String((e && e.message) || e) })
    }
  })
}

/** 北京时间（UTC+8）低谷判定：工作日 09–12 / 14–18 外为空闲。与 ns.py 的口径一致（法定节假日按高峰处理）。 */
function isPeak(date = new Date()) {
  const bj = new Date(date.getTime() + 8 * 3600 * 1000)
  const day = bj.getUTCDay()
  const hour = bj.getUTCHours()
  if (day === 0 || day === 6) return false
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

function fmtLocal(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
}

function tagsOf(card) {
  return (Array.isArray(card && card.tags) ? card.tags : []).map((t) => String(t).toLowerCase())
}

function classify(card) {
  const tags = tagsOf(card)
  const title = String((card && card.title) || '')
  const decision =
    tags.some((t) => DECISION_TAGS.includes(t)) ||
    tags.some((t) => t.startsWith('blocked')) ||
    DECISION_TITLE_PREFIX.some((k) => title.startsWith(k) || title.slice(0, 12).includes(k))
  return { auto: tags.includes('auto'), hold: tags.includes('hold'), decision, tags }
}

/** 从 description 里取最近一段「【夜间跑批送审 …】」的内容（这是要用户确认的东西）；
 *  没有该标记时退回 description 开头——那是人工/其它会话放进待审的卡，也不能只显示标题。 */
function reviewNote(desc) {
  const text = String(desc || '').trim()
  if (!text) return ''
  const send = text.lastIndexOf('【夜间跑批送审')
  if (send >= 0) return text.slice(send).trim()
  const any = text.lastIndexOf('【夜间跑批')
  if (any >= 0) return text.slice(any).trim()
  return text.length > 400 ? `${text.slice(0, 400)}…` : text
}

// ----------------------------------------------------------------- 状态汇总
// 模块级保存 cordis ctx：action 处理函数在模块作用域，拿不到 apply(ctx) 的 ctx
let NS_CTX = null

async function timerState(unit = 'nightshift.timer') {
  const active = ((await run('systemctl', ['is-active', unit])) || 'unknown').trim()
  let next = null
  let raw = null
  const list = await run('systemctl', ['list-timers', unit, '--no-pager'])
  if (list) {
    raw = list.trim()
    const line = list.split('\n').find((l) => l.includes(unit))
    if (line) {
      const m = line.match(/^(\S+)\s+(.+?)\s+(CST|UTC|[A-Z]{2,4})\s/)
      if (m) next = `${m[2]} ${m[3]}`
      else if (/^\s*-\s/.test(line)) next = null
    }
  }
  return { active, next, raw }
}

async function buildStatus(boardArg) {
  const board = resolveBoard(boardArg)
  const now = new Date()
  // 定时源（只读）：systemd 跑批 timer + cron 插件任务（不返回完整 prompt）
  let timers = null
  try {
    // list-timers 在部分 systemd 版本不支持 --output=json ⇒ 用文本表格解析（list-timers-text）
    const units = CFG.boards.map((b) => b.timer).filter(Boolean)
    const r = units.length ? spawnSync('systemctl', ['list-timers', '--all', '--no-pager', '--no-legend', ...units], { encoding: 'utf8', timeout: 5000 }) : null
    if (r && r.status === 0 && r.stdout) {
      timers = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const i = l.search(/nightshift[a-z-]*\.timer/)
        if (i < 0) return null
        const unit = l.slice(i).split(/\s+/)[0]
        return { unit, next: l.slice(0, i).trim(), last: '', activates: l.slice(i + unit.length).trim() }
      }).filter(Boolean)
    }
  } catch { /* 降级：不显示 */ }
  let cronJobs = []
  try {
    const cj = JSON.parse(readFileSync(join(DSH_HOME, 'cron-jobs.json'), 'utf8'))
    cronJobs = (cj.jobs || cj || []).map((j) => ({
      id: j.id, name: j.name, schedule: j.schedule, enabled: !!j.enabled,
      lastRunStatus: j.lastRunStatus || null, lastRunAt: j.lastRunAt || null, nextRunAt: j.nextRunAt || null,
      promptPreview: String(j.prompt || '').replace(/\s+/g, ' ').slice(0, 80),
      looksLikeNightshift: /跑批|nightshift/i.test(String(j.name || '')),
    }))
  } catch { /* 无 cron 任务 */ }
  const peak = isPeak(now)
  // 距下一个峰段开始的秒数：直接问 ns.py（口径唯一，避免 JS 再实现一份峰谷规则）
  let windowLeft = null
  try {
    const r = spawnSync('python3', [nsPyOf(CFG), 'window-left'], { encoding: 'utf8', timeout: 5000, env: nsEnv() })
    const n = Number((r.stdout || '').trim())
    if (Number.isFinite(n)) windowLeft = n
  } catch { /* 忽略：面板降级为不显示余量 */ }
  const COOLDOWN_MIN = cooldownMinFor(board)
  const configured = !!(CFG._path && existsSync(CFG._path) && Array.isArray(CFG.boards) && CFG.boards.length > 0)
  const out = {
    ok: true,
    now: fmtLocal(now),
    board: { key: board.key, label: board.label, path: board.path, workdir: board.workdir, timer: board.timer, requireAuto: board.requireAuto, executor: board.executor || CFG.executor || 'local' },
    executor: board.executor || CFG.executor || 'local',
    boards: BOARDS.map((b) => ({ key: b.key, label: b.label, path: b.path })),
    peak,
    timers,
    cron: cronJobs,
    windowLeft,
    paused: false,
    timer: { active: 'unknown', next: null, raw: null },
    cooldown: { lastRunAt: null, minutesLeft: 0, minutes: COOLDOWN_MIN },
    runningNow: { count: 0, cardId: '', since: null },
    budget: { dayKey: null, cards: 0, minutes: 0, maxCards: MAX_CARDS_PER_DAY, maxMinutes: MAX_MINUTES_PER_DAY },
    todos: [],
    reviews: [],
    running: [],
    recent: { log: [], receipt: null, runs: [] },
    problems: [],
    setup: {
      configured,
      configPath: CFG._path || '',
      initCommand: 'npx dsh-offhours init --repo .',
      doctorCommand: 'npx dsh-offhours doctor',
      restartHint: '安装或更新插件后重启 dsh，面板才会加载新代码。',
    },
  }

  // SCHEDULER-REPORT：按配置的调度方式如实报告（systemd / 插件内 interval）。
  // DAEMON-HEARTBEAT（分支 2026-11-04）：scan.sh --daemon 每 10s 写 DAEMON.heartbeat；
  // 沙箱/非 systemd 环境里 is-active 常是 unknown，心跳是唯一可判活的证据，故作为兜底。
  try {
    const hb = readHeartbeat(CFG)
    const hbActive = !!(hb && hb.ageSec <= 180)
    let daemon = 'n/a'
    if (CFG.scheduler === 'systemd' && CFG.daemonUnit) daemon = await unitActive(CFG.daemonUnit)
    const daemonHb = daemonHeartbeatState()
    out.timer = {
      active: CFG.scheduler === 'plugin'
        ? (hbActive ? 'active' : (hb ? `stale(${hb.ageSec}s)` : daemonHb))
        : (daemon === 'active' || hbActive || daemonHb === 'active'
            ? 'active'
            : (daemon !== 'n/a' && daemon !== 'unknown' ? daemon : daemonHb)),
      next: null,
      raw: CFG.scheduler === 'plugin'
        ? `plugin interval=${CFG.schedule.intervalMin}min heartbeat=${hb ? hb.ageSec + 's' : 'none'} daemon-hb=${daemonHb}`
        : `daemon=${daemon} daemon-hb=${daemonHb} timer=${board.timer || 'n/a'}`,
      scheduler: CFG.scheduler === 'plugin' ? 'in-process' : (CFG.daemonUnit || board.timer || 'systemd'),
      heartbeat: hb,
      daemonHeartbeat: daemonHb,
    }
  } catch { /* 忽略 */ }
  // 暂停标记
  try {
    out.paused = existsSync(DISABLED)
  } catch {
    out.problems.push('读不到 DISABLED 标记')
  }

  // 定时器细节（仅 systemd 且配置了 unit 时查询）
  if (CFG.scheduler === 'systemd' && board.timer) {
    try {
      const ts = await timerState(board.timer)
      out.timer.next = ts.next
      out.timer.raw += ` /timer=${ts.active}`
    } catch { out.problems.push('systemctl 查询失败（定时器状态未知）') }
  }
  // DAEMON-ALIVE：常驻 daemon 形态下旧 timer 停用属正常 —— 只有「timer 不活且 daemon 心跳也过期」才算问题。
  if (CFG.scheduler === 'systemd' && out.timer.active !== 'active') {
    const age = daemonHeartbeatAgeSec()
    out.problems.push(`调度器未运行（daemon 心跳=${age === null ? '无' : age + 's'}，/${board.timer || 'n/a'}=${out.timer.active}）`)
  }
  if (CFG.scheduler === 'plugin' && !CFG.schedule.enabled) {
    out.timer.active = 'disabled'
    out.timer.raw = 'plugin schedule disabled'
  }
  if (configured && CFG.scheduler === 'plugin' && CFG.schedule.enabled && out.timer.active === 'unknown') {
    out.problems.push('插件内调度器没有心跳（确认 dsh 进程在跑，或 schedule.enabled=false）')
  }

  // 冷却
  try {
    const st = readJson(boardState(board)) || {}
    out.cooldown.lastRunAt = st.lastRunAt || null
    if (st.lastRunAt) {
      const elapsedMin = (Date.now() - st.lastRunAt) / 60000
      out.cooldown.minutesLeft = Math.max(0, Math.ceil(COOLDOWN_MIN - elapsedMin))
    }
  } catch {
    out.problems.push(`读不到 ${boardState(board)}（冷却未知）`)
  }

  // 今日预算
  try {
    const day = readJson(boardDay(board))
    if (day && day.dayKey) {
      out.budget.dayKey = day.dayKey
      out.budget.cards = Number(day.cards || 0)
      out.budget.minutes = Number(day.minutes || 0)
      const effBud = readBudget(board).effective
      out.budget.maxCards = Number(effBud.MAX_CARDS_PER_DAY ?? CFG.gates.maxCardsPerDay)
      out.budget.maxMinutes = Number(effBud.MAX_MINUTES_PER_DAY ?? 120)
      out.budget.maxCny = Number(effBud.MAX_CNY_PER_DAY)
      const bud = readBudget(board)
  // 「正在跑」：worker 槽位被占用 > 0 时，用 state-<board>.json 的 lastCardId/lastRunAt 标出那一张

  try {
    let busySlots = 0   // 必须先声明：ESM 严格模式下未声明赋值会抛 ReferenceError（曾导致"正在跑 0"永不正确）
    busySlots = (() => {
      // 只认"槽位里有活进程"的（僵尸槽位不算在跑）；没有 pid 文件的旧格式一律按未在跑
      try {
        let n = 0
        for (const d of readdirSync(join(NS_DIR, 'slots'))) {
          if (!/^\d+$/.test(d)) continue
          const pid = Number((readFileSync(join(NS_DIR, 'slots', d, 'pid'), 'utf8') || '').trim())
          if (!pid) continue
          try { process.kill(pid, 0); n += 1 } catch { /* 进程不在 ⇒ 僵尸槽位 */ }
        }
        return n
      } catch { return 0 }
    })()
    // DEBUG：把槽位读取的中间结果也吐出来，避免"显示 0 但实际在跑"无法定位
    try {
      out.slotsDebug = (() => {
        const r = { dir: join(NS_DIR, 'slots'), entries: [], error: null }
        try {
          for (const d of readdirSync(join(NS_DIR, 'slots'))) {
            if (!/^\d+$/.test(d)) continue
            let pid = null, alive = false, err = null
            try {
              pid = Number((readFileSync(join(NS_DIR, 'slots', d, 'pid'), 'utf8') || '').trim())
              try { process.kill(pid, 0); alive = true } catch (e) { err = String(e && e.code || e) }
            } catch (e) { err = String(e && e.code || e) }
            r.entries.push({ slot: d, pid, alive, err })
          }
        } catch (e) { r.error = String(e && e.code || e) }
        return r
      })()
    } catch { /* 忽略 */ }
    // SLOT-CARD-MUST-BE-INPROGRESS：只把"槽位里的卡确实处于 in_progress"的算作正在跑。
    // 否则卡已结算（review/done）但 worker 还活着时会显示"正在跑 1、待审 0"这种矛盾状态。
    try {
      const _bf = readJson(board.path) || {}
      const _ipIds = new Set((Array.isArray(_bf.cards) ? _bf.cards : []).filter((c) => c.status === 'in_progress').map((c) => c.id))
      let _real = 0
      for (const d of readdirSync(join(NS_DIR, 'slots'))) {
        if (!/^\d+$/.test(d)) continue
        let pid = 0, card = ''
        try { pid = Number((readFileSync(join(NS_DIR, 'slots', d, 'pid'), 'utf8') || '').trim()) } catch { continue }
        try { card = (readFileSync(join(NS_DIR, 'slots', d, 'card'), 'utf8') || '').trim() } catch { /* 老格式没有 card */ }
        let alive = false
        if (pid) { try { process.kill(pid, 0); alive = true } catch { /* 僵尸 */ } }
        if (alive && card && _ipIds.has(card)) _real += 1
      }
      busySlots = _real
    } catch { /* 保持原值 */ }
    const st = busySlots > 0 ? readJson(boardState(board)) || {} : {}
    // 正在跑的卡以 current* 为准（lastCardId 只在跑完更新，否则会显示上一张 + 错误时长）
    const cid0 = (busySlots > 0 && st.currentCardId) ? st.currentCardId : (st.lastCardId || '')
    const since0 = (busySlots > 0 && st.currentSince) ? st.currentSince : (st.lastRunAt || null)
    const bf0 = readJson(board.path) || {}
    const ttl0 = (Array.isArray(bf0.cards) ? bf0.cards.find((c) => c.id === cid0) : null)
    out.runningNow = { count: busySlots, cardId: cid0, since: since0, title: ttl0 ? (ttl0.title || '') : '', status: ttl0 ? (ttl0.status || '') : '', out: lastOutFor(cid0), workerSessionId: workerSessionOf(ttl0) }
  } catch (e) {
    // RUNNINGNOW-VISIBLE：以前这里是静默 catch ⇒ 任何异常都变成"正在跑 0"且无痕迹。
    // 现在把真实错误记进 problems，并在 count 上留 -1 标记，避免"看起来正常其实是假的"。
    out.runningNow = { count: -1, cardId: '', since: null, error: String((e && e.message) || e) }
    out.problems.push('正在跑统计失败：' + String((e && e.message) || e).slice(0, 120))
  }
      out.settings = { keys: BUDGET_KEYS, overrides: bud.overrides, effective: bud.effective, file: bud.file }
    }
  } catch {
    out.problems.push(`读不到 ${boardDay(board)}（今日预算未知）`)
  }

  // 今日花费（低谷价估算；零 token：只读 runs/ 里已存的 usage）
  try {
    const r = await runCapture('python3', [nsPyOf(CFG), 'day-cost'], 8000)
    const m = /COST=([0-9.]+)\s+UNC=(\d+)\s+CACHE=(\d+)\s+OUT=(\d+)\s+RUNS=(\d+)/.exec(r.out || '')
    if (m) out.cost = { cny: Number(m[1]), outTokens: Number(m[4]), runs: Number(m[5]) }
  } catch {
    /* 花费读不到不影响其它状态 */
  }

  // 看板：待办 / 待审 / 回执（**本面板正在看的那个板**）
  try {
    const boardFile = readJson(board.path)
    if (!boardFile || !Array.isArray(boardFile.cards)) {
      out.problems.push(`看板文件读不到或格式不对：${board.path}`)
    } else {
      for (const card of boardFile.cards) {
        const c = classify(card)
        const item = {
          id: card.id,
          title: card.title || '(无标题)',
          tags: Array.isArray(card.tags) ? card.tags : [],
          auto: c.auto,
          hold: c.hold,
          decision: c.decision,
          updatedAt: card.updatedAt || null,
          sourceSessionId: card.sourceSessionId || '',
          sessionLabel: sessionLabel(card.sourceSessionId),
          // 面板要能"展开看详情"：带上人读字段的截断版（看板仍是唯一真源）
          detail: card.description || '',
          why: clip(card.rationale, 400),
          rejected: clip(card.rejected, 200),
          summary: clip(card.summary, 400),
          // 处理会话 id（P5 写进卡片的机器块）⇒ 面板可一键用官方「对话/轨迹」窗口打开它
          superagentIssue: card.superagentIssue || null,
          superagentPr: card.superagentPr || null,
          superagentState: card.superagentState || '',
          workerSessionId: (() => {
            const m = /<!--\s*nightshift:\s*worker=([^\s]+)/.exec(String(card.description || ''))
            return m ? m[1] : ''
          })(),
        }
        if (card.status === 'todo') out.todos.push(item)
        else if (card.status === 'review') out.reviews.push({ ...item, note: approvalOrNote(card.description) })
        else if (card.status === 'in_progress') out.running.push(item)
        if (card.title === RECEIPT_TITLE) out.recent.receipt = card.summary || null
      }
    }
  } catch {
    out.problems.push('读看板失败')
  }

  // 最近日志（只取本板的行；我的日志格式是 `<时间> [<板>] ...`）
  try {
    const raw = readText(LOG)
    if (raw) {
      const lines = raw.split('\n').filter((l) => l.includes(`[${board.key}]`))
      out.recent.log = tailLines(lines.length ? lines.join('\n') : raw, LOG_TAIL)
    } else {
      out.recent.log = []
    }
  } catch { /* 没有日志=还没跑过，不是故障 */ }
  try {
    out.recent.runs = readdirSync(RUNS)
      .filter((f) => f.endsWith('.out') || f.endsWith('.err'))
      .map((f) => ({ name: f, mtime: (() => { try { return statSync(join(RUNS, f)).mtimeMs } catch { return 0 } })() }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, RUNS_SHOWN)
      .map((f) => f.name)
  } catch {
    out.recent.runs = []
  }

  if (!configured) {
    // 未配置时只展示 setup 卡片；不要把空 path 触发的“看板读不到/冷却未知”当错误吓用户。
    out.problems = []
    out.todos = []
    out.reviews = []
    out.running = []
    out.recent = { log: [], receipt: null, runs: [] }
    out.timer.raw = 'unconfigured'
  }
  return out
}

// ----------------------------------------------------------------- 操作
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let data = ''
    let done = false
    const finish = (v) => {
      if (!done) {
        done = true
        resolve(v)
      }
    }
    try {
      req.on('data', (chunk) => {
        data += chunk
        if (data.length > limit) finish(null)
      })
      req.on('end', () => {
        try {
          finish(JSON.parse(data || '{}'))
        } catch {
          finish(null)
        }
      })
      req.on('error', () => finish(null))
      setTimeout(() => finish(null), 3000)
    } catch {
      finish(null)
    }
  })
}

async function runAction(name, boardArg, payload) {
  const action = String(name || '')
  const board = resolveBoard(boardArg)
  if (action === 'pause') {
    try {
      writeFileSync(DISABLED, `paused from the nightshift panel at ${new Date().toISOString()}\n`, 'utf8')
      return { ok: true, action, message: '已暂停：**两个看板**的无人值守跑批都不会再启动（DISABLED 是全局开关）' }
    } catch (e) {
      return { ok: false, action, error: `暂停失败：${(e && e.message) || e}` }
    }
  }
  if (action === 'rename-session') {
    // 给 live 会话改标题（C 方案：只改标题，不动首条消息 ⇒ 缓存前缀不受影响）
    try {
      const c2 = NS_CTX
      const svc = c2 ? c2.get('sessionTitle') : undefined
      if (!svc || typeof svc.rename !== 'function') return { ok: false, action, error: 'sessionTitle 服务不可用' }
      const sid = String((payload && payload.sessionId) || '')
      const title = String((payload && payload.title) || '').slice(0, 120)
      if (!sid || !title) return { ok: false, action, error: '需要 sessionId 与 title' }
      const sess = c2 && c2.sessions && typeof c2.sessions.get === 'function' ? c2.sessions.get(sid) : undefined
      if (!sess) return { ok: false, action, error: '会话不在线（可能已结束）: ' + sid }
      const got = svc.rename(sess, title)
      return { ok: true, action, title: (got && got.title) || title }
    } catch (e) {
      return { ok: false, action, error: String(e && e.message || e) }
    }
  }
  if (action === 'resume') {
    try {
      if (existsSync(DISABLED)) rmSync(DISABLED)
      return { ok: true, action, message: '已恢复：下次满足「低谷 + 空闲」时会自动开工' }
    } catch (e) {
      return { ok: false, action, error: `恢复失败：${(e && e.message) || e}` }
    }
  }
  if (action === 'scan' || action === 'scan-now') {
    try {
      if (!existsSync(SCAN)) return { ok: false, action, error: `找不到 ${SCAN}` }
      const forced = action === 'scan-now'
      const args = forced ? ['--force', '--max-cards=1'] : []
      const r = launchScan(CFG, board, args)
      if (!r.ok) return { ok: false, action, error: `启动扫描失败：${r.error || r.mode}` }
      return {
        ok: true,
        action,
        message: forced
          ? `已强制启动「${board.label}」一轮（跳过空闲/冷却，只做 1 张；高峰仍会被硬拦）——结果见下方日志与看板回执`
          : `已启动一次「${board.label}」扫描；是否真正开工由正常门控决定（日志里会写原因）`,
      }
    } catch (e) {
      return { ok: false, action, error: `启动扫描失败：${(e && e.message) || e}` }
    }
  }
  if (action === 'confirm') {
    // 人工确认一张「待审」卡：结论写回卡片 → 状态回 todo（零 token；由 ns.py 机械执行）
    const cardId = String((payload && payload.cardId) || '')
    const decision = String((payload && payload.decision) || '')
    const detail = String((payload && payload.detail) || '')
    if (!cardId) return { ok: false, action, error: '缺少 cardId' }
    if (decision.trim().length < 8) return { ok: false, action, error: '结论太短（至少 8 个字）——写清你拍的是什么，下一个 worker 才能照着做' }
    const args = [nsPyOf(CFG), 'confirm', board.path, cardId, decision, detail, '--by', '面板']
    if (payload && payload.unhold) args.push('--unhold')
    const res = await runCapture('python3', args)
    const text = (res.out || res.err || '').trim()
    if (res.code !== 0) return { ok: false, action, error: text ? text.slice(0, 300) : 'ns.py confirm 失败（无输出）' }
    return { ok: true, action, message: text ? text.slice(0, 300) : '已确认（卡片已回到待办）' }
  }
  if (action === 'bulk-cards') {
    // 面板批量处理：run-now（按列表逐张执行）/ add-tag / remove-tag（走 ns.py bulk 的形状护栏）
    const ids = Array.isArray(payload && payload.ids) ? payload.ids.map((x) => String(x)).filter(Boolean) : []
    const op = String((payload && payload.op) || '')
    if (!ids.length) return { ok: false, action, error: '没有选中卡片' }
    if (op === 'add-tag' || op === 'remove-tag') {
      const tag = String((payload && payload.value) || '')
      if (!['auto', 'hold', 'temp'].includes(tag)) return { ok: false, action, error: `标签白名单：auto / hold / temp（收到 ${tag}）` }
      const res = await runCapture('python3', [nsPyOf(CFG), 'bulk', board.path, op === 'add-tag' ? 'add' : 'remove', tag, ...ids], 30000)
      const text = (res.out || res.err || '').trim()
      if (res.code !== 0 && !/成功/.test(text)) return { ok: false, action, error: text.slice(0, 300) || 'bulk 失败' }
      return { ok: true, action, message: text.split('\n').slice(-1)[0] || '已批量改标签' }
    }
    if (op === 'run-now') {
      if (!existsSync(SCAN)) return { ok: false, action, error: `找不到 ${SCAN}` }
      const n = Math.min(ids.length, 8)
      const r = launchScan(CFG, board, ['--force', `--max-cards=${n}`, `--only=${ids.slice(0, n).join(',')}`])
      if (!r.ok) return { ok: false, action, error: `启动扫描失败：${r.error || r.mode}` }
      return { ok: true, action, message: `已启动「${board.label}」按顺序做选中的 ${n} 张（跳过空闲/冷却；高峰仍被拦）——结果见日志与回执` }
    }
    return { ok: false, action, error: `未知批量操作：${op}` }
  }
  if (action === 'scan-this') {
    const cardId = String((payload && payload.cardId) || '')
    if (!cardId) return { ok: false, action, error: '缺少 cardId' }
    if (!existsSync(SCAN)) return { ok: false, action, error: `找不到 ${SCAN}` }
    const r = launchScan(CFG, board, ['--force', '--max-cards=1', `--only=${cardId}`])
    if (!r.ok) return { ok: false, action, error: `启动扫描失败：${r.error || r.mode}` }
    return { ok: true, action, message: `已启动「${board.label}」只做 ${cardId} 的一轮（跳过空闲/冷却；高峰仍被拦）——结果见下方日志与回执` }
  }
  if (action === 'confirm-all') {
    // 审批窗口的「全部按推荐批准」：逐张按审批单里的推荐选项确认（结论仍写回各自的卡）
    const args = [nsPyOf(CFG), 'confirm-recommended', board.path, '--by', '面板-审批窗口']
    const res = await runCapture('python3', args, 60000)
    const text = (res.out || res.err || '').trim()
    if (res.code !== 0 && !text) return { ok: false, action, error: 'confirm-recommended 失败（无输出）' }
    return { ok: true, action, message: text ? text.slice(0, 400) : '已按推荐批准' }
  }
  if (action === 'set-budget') {
    // 面板改预算：白名单键 + 范围校验 + 原子写 env-<board>（unit 的 EnvironmentFile 下次启动即生效）
    const values = (payload && payload.values) || {}
    const me = readBudget(board)
    const next = { ...me.overrides }
    const applied = []
    for (const [k, raw] of Object.entries(values)) {
      const spec = BUDGET_KEYS[k]
      if (spec === undefined) return { ok: false, action, error: `不允许改这个键：${k}` }
      const s = String(raw).trim()
      if (s === '') { delete next[k]; applied.push(`${k}=默认`); continue }
      const n = spec.bool ? (s === '1' || s === 'true' ? 1 : 0) : Number(s)
      if (!Number.isFinite(n) || n < spec.min || n > spec.max) {
        return { ok: false, action, error: `${k} 取值非法（${spec.min}–${spec.max}${spec.float ? '，可小数' : ''}）：${s}` }
      }
      next[k] = String(n)
      applied.push(`${k}=${next[k]}`)
    }
    if (CFG.scheduler !== 'systemd') {
      const map = {
        MAX_CARDS_PER_DAY: 'maxCardsPerDay', MAX_CNY_PER_DAY: 'maxCnyPerDay', IDLE_MIN: 'idleMin',
        COOLDOWN_MIN: 'cooldownMin', MAX_CARDS_PER_RUN: 'maxCardsPerRun', RUN_TIMEOUT: 'runTimeout',
        STORM_MAX: 'stormMax', MAX_PARALLEL_PER_BOARD: 'maxParallel',
      }
      for (const [k, v] of Object.entries(next)) {
        const ck = map[k]
        if (ck) CFG.gates[ck] = Number(v)
      }
      try {
        saveConfig(CFG._path, CFG)
      } catch (e) {
        return { ok: false, action, error: `写入配置失败：${(e && e.message) || e}` }
      }
      return { ok: true, action, message: `已写入 ${CFG._path}：${applied.join('；') || '（无变化）'}。下一个 tick 起生效。`.slice(0, 500) }
    }
    const body = Object.keys(next).sort().map((k) => `${k}=${next[k]}`).join('\n') + (Object.keys(next).length ? '\n' : '')
    try {
      const tmp = `${me.file}.tmp-${process.pid}`
      writeFileSync(tmp, body, 'utf8')
      renameSync(tmp, me.file)
    } catch (e) {
      return { ok: false, action, error: `写入 ${me.file} 失败：${(e && e.message) || e}` }
    }
    const after = readBudget(board)
    return { ok: true, action, message: `已写入 ${me.file}：${applied.join('；') || '（无变化）'}。下一个 tick 起生效（无需重启）。`.slice(0, 500) }
  }
  return { ok: false, action, error: `未知操作：${action || '(空)'}` }
}

// ----------------------------------------------------------------- 注册路由
function sendJson(res, code, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function registerRoutes(ctx, handler) {
  const install = (c) => {
    const ws = c.get?.('webServer')
    if (!ws || typeof ws.register !== 'function') return
    c.effect(() => ws.register({ kind: 'prefix', path: '/nightshift/api', handler }))
    c.effect(() => ws.register({ kind: 'prefix', path: '/offhours/api', handler }))
  }
  if (ctx.get?.('webServer')) install(ctx)
  else if (typeof ctx.inject === 'function') ctx.inject(['webServer'], install)
}

function registerSkill(ctx) {
  try {
    const skills = ctx.get?.('skills')
    if (!skills || typeof skills.register !== 'function') {
      if (typeof ctx.inject === 'function') ctx.inject(['skills'], (c) => registerSkill(c))
      return
    }
    const file = CFG.skillFile
    if (!file || !existsSync(file)) return
    const text = readFileSync(file, 'utf8')
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text)
    if (!m) return
    const meta = {}
    for (const line of m[1].split(/\r?\n/)) {
      const mm = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim())
      if (mm) meta[mm[1]] = mm[2].replace(/^["']|["']$/g, '')
    }
    if (!meta.name || !meta.description) return
    const disposer = skills.register({ name: meta.name, description: meta.description, content: m[2].trim(), source: 'runtime' })
    if (typeof disposer === 'function') ctx.effect?.(() => disposer, 'offhours: skill')
  } catch { /* 技能注册失败不影响面板 */ }
}

function registerCommand(ctx) {
  try {
    const cmds = ctx.get?.('commands')
    if (!cmds || typeof cmds.register !== 'function') {
      if (typeof ctx.inject === 'function') ctx.inject(['commands'], (c) => registerCommand(c))
      return
    }
    const disposer = cmds.register({
      name: 'offhours',
      description: '夜间跑批：查看状态/立即跑一轮/暂停/恢复',
      input: { hint: '[status|run|pause|resume]' },
      handler: async (invocation) => {
        const input = String((invocation && invocation.rawInput) || '').trim()
        try {
          if (input === 'pause' || input === 'resume') {
            const r = await runAction(input, '', {})
            return { kind: r.ok ? 'text' : 'error', text: r.message || r.error || input }
          }
          if (input === 'run' || input === 'scan') {
            const board = resolveBoard('')
            const r = await runAction('scan', board.id, {})
            return { kind: r.ok ? 'text' : 'error', text: r.message || r.error || 'run' }
          }
          const st = await buildStatus('')
          const lines = [
            `offhours · ${st.board ? st.board.label : '(未配置)'}${st.timer ? ' · 调度=' + (st.timer.scheduler || st.timer.active) : ''}`,
            `todo=${st.todos.length} review=${st.reviews.length} running=${st.runningNow ? st.runningNow.count : 0}` +
              (st.cost ? ` · 今日≈¥${st.cost.cny}` : ''),
          ]
          if (st.problems && st.problems.length) lines.push('问题：' + st.problems.slice(0, 3).join('；'))
          return { kind: st.board ? 'text' : 'error', text: lines.join('\n') }
        } catch (e) {
          return { kind: 'error', text: `offhours: ${(e && e.message) || e}` }
        }
      },
    })
    if (typeof disposer === 'function') ctx.effect?.(() => disposer, 'offhours: command')
  } catch { /* 命令注册失败不影响面板 */ }
}

export function apply(ctx, config = {}) {
  const loaded = loadConfig(config && config.configFile)
  applyConfig(loaded.config, loaded.path)
  const handler = async (req, res) => {
    try {
      // 安全面（2026-10-16）：本插件所有端点都要求自定义头 x-nightshift: 1。
      // 为什么：浏览器跨站表单/简单请求带不了自定义头 ⇒ 天然挡 CSRF；本机其它进程也必须显式声明。
      const _u = new URL(req.url || '/', 'http://127.0.0.1')
      const _p = _u.pathname.replace(/\/+$/, '')
      // 只读使用手册：浏览器直接打开（手机端常驻入口）。仅静态文档，无写操作 ⇒ 免自定义头。
      if (_p.endsWith('/doc-page') || _p.endsWith('/doc')) {
        const file = join(NS_DIR, 'docs', 'USAGE.zh.md')
        let md = ''
        try { md = readFileSync(file, 'utf8') } catch (e) { md = '' }
        if (_p.endsWith('/doc')) { sendJson(res, 200, { ok: !!md, text: md, file }); return }
        const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        const html = '<!doctype html><html lang="zh"><head><meta charset="utf-8">'
          + '<meta name="viewport" content="width=device-width,initial-scale=1">'
          + '<title>夜间跑批 · 使用手册</title><style>'
          + 'body{margin:0;padding:14px;background:#f6f7f9;color:#1a1c1f;font:15px/1.65 system-ui,-apple-system,"PingFang SC",sans-serif}'
          + 'pre{background:#fff;border:1px solid #e3e6ea;border-radius:10px;padding:12px;overflow-x:auto;'
          + 'white-space:pre;font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}'
          + '.hint{font-size:12px;color:#666;margin:0 0 10px}</style></head><body>'
          + '<p class="hint">' + (md ? `来自 ${join(NS_DIR, 'docs', 'USAGE.zh.md')}（可常驻；手机可缩放/横滑）` : '手册未部署：请先执行 ./deploy/install.sh') + '</p>'
          + '<pre>' + esc(md || '（未找到使用手册文件）') + '</pre></body></html>'
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(html)
        return
      }
      if (String((req.headers || {})['x-nightshift'] || '') !== '1') {
        sendJson(res, 403, { ok: false, error: '缺少 x-nightshift: 1 请求头（面板会自动带；curl 需 -H 指定）' })
        return
      }
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const path = url.pathname.replace(/\/+$/, '')
      if (path.endsWith('/live')) {
        // 实时输出：把 worker 的 --json 事件流渲染成人可读的行（面板「正在跑」窗口轮询这个）
        const b = resolveBoard(url.searchParams.get('board'))
        const st = readJson(boardState(b)) || {}
        let slots = 0
        for (const d of (() => { try { return readdirSync(join(NS_DIR, 'slots')) } catch { return [] } })()) {
          if (!/^\d+$/.test(d)) continue
          const pid = Number(((() => { try { return readFileSync(join(NS_DIR, 'slots', d, 'pid'), 'utf8') } catch { return '' } })() || '').trim())
          if (!pid) continue
          try { process.kill(pid, 0); slots += 1 } catch { /* 僵尸 */ }
        }
        let cid = (!slots && st.lastCardId) ? st.lastCardId : (st.currentCardId || st.lastCardId || '')
        let outPath = lastOutFor(cid)
        let finishedRun = false
        if (!outPath || slots === 0) {
          // 没有在跑（或该卡没有输出）⇒ 显示**最近一次跑批的输出**，别让窗口空着
          try {
            const all = readdirSync(join(NS_DIR, 'runs')).filter((f) => f.endsWith('.out')).sort()
            if (all.length) {
              outPath = join(NS_DIR, 'runs', all[all.length - 1])
              finishedRun = slots === 0
              const mm = /-(card-[0-9a-f-]+)\.out$/.exec(all[all.length - 1])
              if (mm) cid = mm[1]
            }
          } catch { /* 无 runs 目录 */ }
        }
        const lines = []
        if (outPath && existsSync(outPath)) {
          const raw = readFileSync(outPath, 'utf8').slice(-160000)
          for (const line of raw.split('\n')) {
            const s = line.trim()
            if (!s) continue
            let pushed = false
            if (s.startsWith('{')) {
              try {
                const o = JSON.parse(s)
                const ty = o.type
                if (ty === 'thinking') { lines.push({ kind: 'think', text: String(o.text || '') }); pushed = true }
                else if (ty === 'text') { lines.push({ kind: 'text', text: String(o.text || '') }); pushed = true }
                else if (ty === 'final') { lines.push({ kind: 'final', text: String(o.text || '') }); pushed = true }
                else if (ty === 'status') { lines.push({ kind: 'phase', text: String(o.phase || '') }); pushed = true }
                else if (ty === 'session') { lines.push({ kind: 'meta', text: 'session ' + String(o.sessionId || '') }); pushed = true }
              } catch { /* 落回 raw */ }
            }
            if (!pushed) lines.push({ kind: 'raw', text: s.slice(0, 240) })
          }
        }
        const bf = readJson(b.path) || {}
        const ttl = Array.isArray(bf.cards) ? bf.cards.find((c) => c.id === cid) : null
        sendJson(res, 200, {
          ok: true, board: b.key, out: outPath, finishedRun,
          outBytes: (outPath && existsSync(outPath)) ? statSync(outPath).size : 0,
          running: { count: slots, cardId: cid, since: st.lastRunAt || null, title: ttl ? (ttl.title || '') : '', status: ttl ? (ttl.status || '') : '', workerSessionId: workerSessionOf(ttl) },
          lines: lines.slice(-300),
        })
        return
      }
      if (path.endsWith('/status')) {
        sendJson(res, 200, await buildStatus(url.searchParams.get('board')))
        return
      }
      if (path.endsWith('/action')) {
        // 安全面：/action 是唯一会改状态/花钱的入口 ⇒ 必须带自定义头
        // （浏览器跨站表单/简单请求带不了自定义头 ⇒ 天然挡 CSRF；本机其它进程也需显式声明）
        if (String((req.headers || {})['x-nightshift'] || '') !== '1') {
          sendJson(res, 403, { ok: false, error: '缺少 x-nightshift: 1 请求头（面板会自动带；curl 需 -H 指定）' })
          return
        }
        if (String(req.method || 'GET').toUpperCase() !== 'POST') {
          sendJson(res, 405, { ok: false, error: '操作需用 POST /nightshift/api/action' })
          return
        }
        const body = await readBody(req)
        const result = await runAction(body && (body.action || body.name), body && body.board, body)
        sendJson(res, result.ok ? 200 : 400, result)
        return
      }
      sendJson(res, 404, { ok: false, error: `未知端点：${path}` })
    } catch (e) {
      try {
        sendJson(res, 500, { ok: false, error: `nightshift 面板内部错误：${(e && e.message) || e}` })
      } catch {
        /* 连回包都失败时放弃，避免把异常抛回宿主 */
      }
    }
  }

  NS_CTX = ctx
  registerRoutes(ctx, handler)
  registerSkill(ctx)
  registerCommand(ctx)
  const stop = startScheduler(ctx, CFG, (m) => ctx.logger?.info?.(m))
  if (stop) ctx.effect(() => stop)
}
