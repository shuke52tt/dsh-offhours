/**
 * dsh-offhours · 共享配置层
 *
 * 一个配置文件就是唯一真源：插件、面板、CLI 都读它。
 * 设计约束：
 *   · 包内不出现任何主机绝对路径；主机差异全部收进配置文件；
 *   · 配置坏了只降级（返回带 problems 的默认配置），绝不让 dsh 启动失败；
 *   · 所有相对路径按配置文件所在目录解析；~ 展开到当前用户 home。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const VERSION = 1

export function dshHome() {
  return process.env.DSH_HOME || join(process.env.HOME || homedir(), '.dsh')
}

export function defaultConfigPath() {
  return process.env.OFFHOURS_CONFIG || join(dshHome(), 'offhours', 'config.json')
}

export function expandHome(p) {
  const s = String(p || '')
  if (s === '~') return homedir()
  if (s.startsWith('~/')) return join(homedir(), s.slice(2))
  return s
}

function absPath(p, base) {
  const s = expandHome(p)
  if (!s) return s
  return isAbsolute(s) ? s : resolve(base, s)
}

function asBool(v, def = false) {
  if (v === undefined || v === null || v === '') return def
  if (typeof v === 'boolean') return v
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase())
}

function asInt(v, def, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function asNum(v, def, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, n))
}

export function packageRoot() {
  return PKG_ROOT
}

export function scanScript(cfg) {
  return cfg.scanScript || join(PKG_ROOT, 'mechanism', 'scan.sh')
}

export function nsPy(cfg) {
  return cfg.nsPy || join(PKG_ROOT, 'mechanism', 'ns.py')
}

export function featureBin(cfg) {
  return cfg.featureBin || join(PKG_ROOT, 'feature-worktrees', 'feature')
}

export function skillFile(cfg) {
  return cfg.skillFile || join(PKG_ROOT, 'skills', 'offhours', 'SKILL.md')
}

/** 默认配置（未配置时也安全：boards 为空，面板显示「未配置」而不是崩）。 */
export function defaultConfig() {
  return {
    version: VERSION,
    stateDir: join(dshHome(), 'offhours', 'state'),
    featuresRoot: join(dshHome(), 'offhours', 'features'),
    dshHome: dshHome(),
    dshBin: process.env.DSH_BIN || 'dsh',
    dshProfile: 'headless',
    scheduler: 'plugin',
    daemonUnit: '',
    repos: {},
    boards: [],
    gates: {
      maxCardsPerRun: 3,
      maxCardsPerDay: 8,
      maxCnyPerDay: 20,
      runTimeout: 1800,
      cooldownMin: 10,
      idleMin: 5,
      maxParallel: 2,
      stormMax: 10,
    },
    schedule: { enabled: true, intervalMin: 5, jitterSec: 30 },
    worker: { permissionMode: 'danger-full-access' },
  }
}

function normalizeBoard(raw, base, cfg) {
  if (!raw || typeof raw !== 'object') return null
  const id = String(raw.id || raw.key || '').trim()
  const file = absPath(raw.file || raw.path || '', base)
  if (!id || !file) return null
  return {
    id,
    key: id,
    label: String(raw.label || id),
    file,
    path: file,
    workdir: absPath(raw.workdir || dirname(file), base),
    repos: Array.isArray(raw.repos) ? raw.repos.map(String) : [],
    unit: String(raw.unit || raw.timer || ''),
    timer: String(raw.unit || raw.timer || ''),
    envFile: String(raw.envFile || ''),
    requireAuto: asBool(raw.requireAuto, false),
    enabled: raw.enabled === undefined ? true : asBool(raw.enabled, true),
  }
}

/** 把原始 JSON 收敛成稳定形状；任何缺陷都记进 problems，不抛。 */
export function normalizeConfig(raw, { path = '' } = {}) {
  const def = defaultConfig()
  const base = path ? dirname(path) : process.cwd()
  const problems = []
  const cfg = { ...def, ...(raw && typeof raw === 'object' ? raw : {}) }
  if (raw && typeof raw === 'object' && raw.version !== undefined && Number(raw.version) !== VERSION) {
    problems.push(`配置版本 ${raw.version} 与当前插件 ${VERSION} 不一致（按 ${VERSION} 解析）`)
  }
  cfg.version = VERSION
  cfg.stateDir = absPath(cfg.stateDir || def.stateDir, base)
  cfg.featuresRoot = absPath(cfg.featuresRoot || def.featuresRoot, base)
  cfg.dshHome = absPath(cfg.dshHome || def.dshHome, base)
  cfg.scanScript = cfg.scanScript ? absPath(cfg.scanScript, base) : join(PKG_ROOT, 'mechanism', 'scan.sh')
  cfg.nsPy = cfg.nsPy ? absPath(cfg.nsPy, base) : join(PKG_ROOT, 'mechanism', 'ns.py')
  cfg.featureBin = cfg.featureBin ? absPath(cfg.featureBin, base) : join(PKG_ROOT, 'feature-worktrees', 'feature')
  cfg.skillFile = cfg.skillFile ? absPath(cfg.skillFile, base) : join(PKG_ROOT, 'skills', 'offhours', 'SKILL.md')
  cfg.scheduler = cfg.scheduler === 'systemd' ? 'systemd' : 'plugin'
  cfg.dshBin = String(cfg.dshBin || def.dshBin)
  cfg.dshProfile = String(cfg.dshProfile || def.dshProfile)

  const gates = cfg.gates && typeof cfg.gates === 'object' ? cfg.gates : {}
  cfg.gates = {
    maxCardsPerRun: asInt(gates.maxCardsPerRun, def.gates.maxCardsPerRun, 1, 16),
    maxCardsPerDay: asInt(gates.maxCardsPerDay, def.gates.maxCardsPerDay, 0, 64),
    maxCnyPerDay: asNum(gates.maxCnyPerDay, def.gates.maxCnyPerDay, 0, 1000),
    runTimeout: asInt(gates.runTimeout, def.gates.runTimeout, 60, 7200),
    cooldownMin: asInt(gates.cooldownMin, def.gates.cooldownMin, 0, 240),
    idleMin: asInt(gates.idleMin, def.gates.idleMin, 0, 240),
    maxParallel: asInt(gates.maxParallel, def.gates.maxParallel, 1, 8),
    stormMax: asInt(gates.stormMax, def.gates.stormMax, 0, 200),
  }
  const sch = cfg.schedule && typeof cfg.schedule === 'object' ? cfg.schedule : {}
  cfg.schedule = {
    enabled: asBool(sch.enabled, true),
    intervalMin: asInt(sch.intervalMin, 5, 1, 240),
    jitterSec: asInt(sch.jitterSec, 30, 0, 600),
  }
  const worker = cfg.worker && typeof cfg.worker === 'object' ? cfg.worker : {}
  cfg.worker = {
    permissionMode: String(worker.permissionMode || def.worker.permissionMode),
    dshBin: String(worker.dshBin || cfg.dshBin),
    dshProfile: String(worker.dshProfile || cfg.dshProfile),
  }

  const repos = cfg.repos && typeof cfg.repos === 'object' ? cfg.repos : {}
  cfg.repos = {}
  for (const [name, value] of Object.entries(repos)) {
    if (typeof value === 'string') cfg.repos[name] = { path: absPath(value, base) }
    else if (value && typeof value === 'object') {
      cfg.repos[name] = {
        path: absPath(value.path || '', base),
        baseBranch: String(value.baseBranch || ''),
        remote: String(value.remote || ''),
      }
    }
  }
  const boards = Array.isArray(cfg.boards) ? cfg.boards : []
  cfg.boards = boards.map((b) => normalizeBoard(b, base, cfg)).filter(Boolean)
  if (!cfg.boards.length) problems.push('配置里没有可用看板（boards 为空）')
  for (const b of cfg.boards) {
    if (!cfg.repos[b.repos[0]] && b.repos.length) {
      problems.push(`看板 ${b.id} 引用了未登记的仓库：${b.repos[0]}`)
    }
  }
  cfg.problems = problems
  return cfg
}

/** 读配置；返回 {config, path, exists}。文件不存在/JSON 坏都只降级。 */
export function loadConfig(configFile) {
  const path = absPath(configFile || defaultConfigPath(), process.cwd())
  if (!existsSync(path)) {
    const cfg = normalizeConfig({}, { path })
    cfg.problems.unshift(`配置文件不存在：${path}（先运行 offhours init 或安装时生成）`)
    return { config: cfg, path, exists: false }
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return { config: normalizeConfig(raw, { path }), path, exists: true }
  } catch (e) {
    const cfg = normalizeConfig({}, { path })
    cfg.problems.unshift(`配置不是合法 JSON：${path}（${(e && e.message) || e}）`)
    return { config: cfg, path, exists: true }
  }
}

export function saveConfig(path, cfg) {
  const raw = {
    version: VERSION,
    stateDir: cfg.stateDir,
    featuresRoot: cfg.featuresRoot,
    dshHome: cfg.dshHome,
    dshBin: cfg.dshBin,
    dshProfile: cfg.dshProfile,
    scheduler: cfg.scheduler,
    daemonUnit: cfg.daemonUnit || '',
    repos: cfg.repos,
    boards: cfg.boards.map(({ id, label, file, workdir, repos, unit, envFile, requireAuto, enabled }) => ({
      id, label, file, workdir, repos, unit, envFile, requireAuto, enabled,
    })),
    gates: cfg.gates,
    schedule: cfg.schedule,
    worker: cfg.worker,
  }
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', 'utf8')
  renameSync(tmp, path)
  return path
}

export function resolveBoard(cfg, requested) {
  const want = String(requested || '').trim()
  return cfg.boards.find((b) => b.id === want || b.file === want || b.label === want) || cfg.boards[0] || null
}

/** 引擎环境：插件调度器与 CLI 共用；systemd 场景由单元 EnvironmentFile 提供同类键。 */
export function scanEnv(cfg, board, extra = {}) {
  const env = {
    ...process.env,
    NIGHTSHIFT_BOARD: board.file,
    NIGHTSHIFT_WORKDIR: board.workdir,
    NIGHTSHIFT_RUNTIME_DIR: cfg.stateDir,
    FEATURE_ROOT: cfg.featuresRoot,
    DSH_HOME: cfg.dshHome,
    DSH_BIN: cfg.worker.dshBin,
    NIGHTSHIFT_FEATURE_BIN: cfg.featureBin,
    NIGHTSHIFT_BOARDS: cfg.boards.map((b) => b.file).join(' '),
    NIGHTSHIFT_WORKER_PERMISSION_MODE: cfg.worker.permissionMode,
    NIGHTSHIFT_SANDBOX: 'auto',
    MAX_CARDS_PER_RUN: String(cfg.gates.maxCardsPerRun),
    MAX_CARDS_PER_DAY: String(cfg.gates.maxCardsPerDay),
    MAX_CNY_PER_DAY: String(cfg.gates.maxCnyPerDay),
    RUN_TIMEOUT: String(cfg.gates.runTimeout),
    COOLDOWN_MIN: String(cfg.gates.cooldownMin),
    IDLE_MIN: String(cfg.gates.idleMin),
    MAX_PARALLEL_PER_BOARD: String(cfg.gates.maxParallel),
    STORM_MAX: String(cfg.gates.stormMax),
  }
  if (board.requireAuto) env.NIGHTSHIFT_REQUIRE_AUTO = '1'
  return { ...env, ...extra }
}
