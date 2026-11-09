/**
 * dsh-offhours · 运行时适配器
 *
 * 把「谁在调度」和「面板怎么触发」从面板主体里拆出来：
 *   · scheduler=systemd：主机现役形态，面板用 systemd-run / systemctl（行为与升级前一致）；
 *   · scheduler=plugin ：社区形态，插件进程内 interval，面板直接 spawn scan.sh。
 * 两条路最终都只调用同一个 scan.sh，不复制跑批逻辑。
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { scanEnv } from './config.js'

export function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

export function writeJsonAtomic(path, value) {
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(tmp, path)
}

export function heartbeatPath(cfg) {
  return join(cfg.stateDir, 'heartbeat.json')
}

export function readHeartbeat(cfg) {
  const h = readJson(heartbeatPath(cfg))
  if (!h || !h.at) return null
  return { ...h, ageSec: Math.max(0, Math.floor(Date.now() / 1000 - h.at / 1000)) }
}

/** 启动一轮扫描；返回 { ok, mode, pid?, message? }。只负责点火，不解析结果。 */
export function launchScan(cfg, board, args = []) {
  const env = scanEnv(cfg, board)
  if (cfg.scheduler === 'systemd') {
    const unit = `ns-panel-${Date.now()}`
    const sysArgs = ['--unit=' + unit, '--collect']
    for (const [k, v] of Object.entries(env)) if (k.startsWith('NIGHTSHIFT_')) sysArgs.push(`--setenv=${k}=${v}`)
    try {
      const child = spawn('systemd-run', [...sysArgs, cfg.scanScript, ...args], { detached: true, stdio: 'ignore' })
      child.unref()
      return { ok: true, mode: 'systemd-run', unit }
    } catch (e) {
      return { ok: false, mode: 'systemd-run', error: String((e && e.message) || e) }
    }
  }
  try {
    const child = spawn('bash', [cfg.scanScript, ...args], {
      env,
      detached: true,
      stdio: 'ignore',
      cwd: board.workdir && existsSync(board.workdir) ? board.workdir : process.cwd(),
    })
    child.unref()
    return { ok: true, mode: 'spawn', pid: child.pid }
  } catch (e) {
    return { ok: false, mode: 'spawn', error: String((e && e.message) || e) }
  }
}

/** 插件内调度器：interval + 抖动 + 单飞 + 心跳；返回 disposer。 */
export function startScheduler(ctx, cfg, log = () => {}) {
  if (cfg.scheduler !== 'plugin' || !cfg.schedule.enabled || !cfg.boards.length) return null
  const ms = Math.max(60_000, cfg.schedule.intervalMin * 60_000)
  const jitter = Math.max(0, cfg.schedule.jitterSec * 1000)
  let stopped = false
  let inFlight = false

  // 首帧心跳：面板/CLI 在启动后的第一秒就能看到“调度器在跑”，
  // 而不是等第一个 interval/抖动（默认最多 30s）才出现，避免新用户一打开面板就看到假故障。
  try { writeJsonAtomic(heartbeatPath(cfg), { at: Date.now(), startedAt: Date.now(), fired: [], initial: true }) } catch { /* 忽略 */ }

  const tick = async () => {
    if (stopped || inFlight) return
    inFlight = true
    const started = Date.now()
    const fired = []
    try {
      if (existsSync(join(cfg.stateDir, 'DISABLED'))) {
        writeJsonAtomic(heartbeatPath(cfg), { at: Date.now(), skipped: 'DISABLED', fired })
        return
      }
      for (const board of cfg.boards.filter((b) => b.enabled !== false)) {
        const r = launchScan(cfg, board, [`--max-cards=${cfg.gates.maxCardsPerRun}`])
        fired.push({ board: board.id, ...r })
        if (!r.ok) log(`offhours: board ${board.id} 启动失败：${r.error || r.mode}`)
      }
      writeJsonAtomic(heartbeatPath(cfg), { at: Date.now(), startedAt: started, fired })
    } catch (e) {
      log(`offhours: tick 异常：${(e && e.message) || e}`)
      try { writeJsonAtomic(heartbeatPath(cfg), { at: Date.now(), error: String((e && e.message) || e), fired }) } catch { /* 忽略 */ }
    } finally {
      inFlight = false
    }
  }

  const first = setTimeout(tick, Math.floor(Math.random() * Math.max(1, jitter)))
  const timer = setInterval(tick, ms)
  log(`offhours: 插件内调度已启动（每 ${cfg.schedule.intervalMin} 分钟，抖动 ${cfg.schedule.jitterSec}s）`)
  return () => {
    stopped = true
    clearTimeout(first)
    clearInterval(timer)
  }
}

/** systemd 面板适配：不假设 unit 一定存在。 */
export function unitActive(unit) {
  return new Promise((resolve) => {
    if (!unit) return resolve('n/a')
    execFile('systemctl', ['is-active', unit], { timeout: 3000 }, (err, stdout) => {
      resolve(err ? 'inactive' : String(stdout || '').trim() || 'unknown')
    })
  })
}

export function listNightshiftTimers(units) {
  return new Promise((resolve) => {
    const list = (units || []).filter(Boolean)
    if (!list.length) return resolve([])
    execFile('systemctl', ['list-timers', '--all', '--no-pager', '--no-legend', ...list], { timeout: 5000, maxBuffer: 256 * 1024 }, (err, stdout) => {
      if (err || !stdout) return resolve([])
      resolve(String(stdout).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const i = l.search(/[A-Za-z0-9_.-]+\.timer/)
        if (i < 0) return null
        const unit = l.slice(i).split(/\s+/)[0]
        return { unit, next: l.slice(0, i).trim(), activates: l.slice(i + unit.length).trim() }
      }).filter(Boolean))
    })
  })
}
