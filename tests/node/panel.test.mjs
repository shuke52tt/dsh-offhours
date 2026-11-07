import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = mkdtempSync(join(tmpdir(), 'offhours-panel-'))
const stateDir = join(root, 'state')
const featuresRoot = join(root, 'features')
mkdirSync(stateDir, { recursive: true })
mkdirSync(featuresRoot, { recursive: true })
const board = join(root, 'KANBAN.json')
writeFileSync(board, JSON.stringify({ version: 1, cards: [
  { id: 'card-1', title: '待办一', status: 'todo', tags: ['auto'], createdAt: 1, updatedAt: 1 },
  { id: 'card-2', title: '待审一', status: 'review', tags: [], createdAt: 1, updatedAt: 1 },
] }))
const configFile = join(root, 'config.json')
writeFileSync(configFile, JSON.stringify({
  version: 1,
  stateDir, featuresRoot,
  scheduler: 'plugin',
  schedule: { enabled: false, intervalMin: 5, jitterSec: 0 },
  repos: { demo: { path: root } },
  boards: [{ id: 'demo', label: 'demo', file: board, workdir: root, repos: ['demo'] }],
}))

const { apply } = await import('../../panel/index.js')

function fakeCtx() {
  const routes = []
  return {
    routes,
    effect(fn) { const d = fn(); if (typeof d === 'function') d() },
    get(name) { return name === 'webServer' ? this.webServer : undefined },
    logger: { info() {}, warn() {} },
    webServer: { register(o) { routes.push(o) } },
  }
}

function call(handler, url, { method = 'GET', headers = { 'x-nightshift': '1' }, body } = {}) {
  return new Promise((resolve) => {
    const res = { code: 0, body: '', writeHead(c) { this.code = c }, end(b) { this.body = String(b); resolve(this) } }
    const req = {
      url, method, headers,
      on(ev, cb) { if (ev === 'data' && body) cb(Buffer.from(JSON.stringify(body))); if (ev === 'end') cb() },
    }
    handler(req, res)
  })
}

test('面板按配置装载：/offhours/api/status 与 /nightshift/api/status 等价', async () => {
  const ctx = fakeCtx()
  apply(ctx, { configFile })
  assert.equal(ctx.routes.length >= 2, true)
  const h = ctx.routes[0].handler
  const a = await call(h, '/offhours/api/status?board=demo')
  const b = await call(h, '/nightshift/api/status?board=demo')
  assert.equal(a.code, 200)
  assert.equal(b.code, 200)
  const ja = JSON.parse(a.body)
  const jb = JSON.parse(b.body)
  assert.equal(ja.ok, true)
  assert.equal(ja.board.key, 'demo')
  assert.equal(ja.todos.length, 1)
  assert.equal(ja.reviews.length, 1)
  assert.equal(ja.timer.scheduler, 'in-process')
  assert.equal(jb.board.key, 'demo')
})

test('面板 action 的安全面：缺 x-nightshift 头被拒', async () => {
  const ctx = fakeCtx()
  apply(ctx, { configFile })
  const h = ctx.routes[0].handler
  const res = await call(h, '/offhours/api/action', { method: 'POST', headers: {}, body: { action: 'pause' } })
  assert.equal(res.code, 403)
})
