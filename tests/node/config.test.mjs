import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, normalizeConfig, resolveBoard, scanEnv } from '../../lib/config.js'

test('默认配置安全：未配置时 boards 为空且带 problems', () => {
  const cfg = normalizeConfig({})
  assert.equal(cfg.version, 1)
  assert.equal(cfg.scheduler, 'plugin')
  assert.deepEqual(cfg.boards, [])
  assert.ok(cfg.problems.some((p) => p.includes('boards')))
})

test('相对路径按配置文件目录解析，gates 会被夹到合法范围', () => {
  const dir = mkdtempSync(join(tmpdir(), 'offhours-cfg-'))
  writeFileSync(join(dir, 'board.json'), '{"version":1,"cards":[]}\n')
  const cfg = normalizeConfig({
    stateDir: './state', featuresRoot: './features',
    repos: { demo: { path: '../repo', baseBranch: 'master' } },
    boards: [{ id: 'demo', file: './board.json', workdir: '.', repos: ['demo'] }],
    gates: { maxCardsPerRun: 999, maxCnyPerDay: -1, cooldownMin: 0 },
  }, { path: join(dir, 'config.json') })
  assert.equal(cfg.stateDir, join(dir, 'state'))
  assert.equal(cfg.featuresRoot, join(dir, 'features'))
  assert.equal(cfg.boards[0].file, join(dir, 'board.json'))
  assert.equal(cfg.boards[0].workdir, dir)
  assert.equal(cfg.repos.demo.baseBranch, 'master')
  assert.equal(cfg.gates.maxCardsPerRun, 16)
  assert.equal(cfg.gates.maxCnyPerDay, 0)
  assert.equal(cfg.gates.cooldownMin, 0)
})

test('loadConfig 对坏 JSON 降级而不抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'offhours-bad-'))
  const p = join(dir, 'config.json')
  writeFileSync(p, '{ not json')
  const { config, exists } = loadConfig(p)
  assert.equal(exists, true)
  assert.ok(config.problems.some((x) => x.includes('JSON')))
})

test('resolveBoard + scanEnv：引擎环境不依赖主机路径', () => {
  const cfg = normalizeConfig({
    stateDir: '/tmp/state', featuresRoot: '/tmp/features', dshBin: '/bin/echo',
    repos: { demo: { path: '/tmp/repo', baseBranch: 'master' } },
    boards: [{ id: 'demo', file: '/tmp/board.json', workdir: '/tmp/repo', repos: ['demo'], requireAuto: true }],
  })
  const b = resolveBoard(cfg, 'demo')
  assert.equal(b.id, 'demo')
  const env = scanEnv(cfg, b)
  assert.equal(env.NIGHTSHIFT_BOARD, '/tmp/board.json')
  assert.equal(env.NIGHTSHIFT_RUNTIME_DIR, '/tmp/state')
  assert.equal(env.FEATURE_ROOT, '/tmp/features')
  assert.equal(env.DSH_BIN, '/bin/echo')
  assert.equal(env.NIGHTSHIFT_REQUIRE_AUTO, '1')
  assert.equal(env.NIGHTSHIFT_WORKER_PERMISSION_MODE, 'danger-full-access')
  for (const k of ['NIGHTSHIFT_BOARD', 'NIGHTSHIFT_RUNTIME_DIR', 'FEATURE_ROOT', 'DSH_BIN']) {
    assert.ok(!String(env[k]).includes('/root/'), `${k} 不应带主机路径`)
  }
})
