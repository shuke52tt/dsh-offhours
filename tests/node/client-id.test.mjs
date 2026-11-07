import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

test('社区 client bundle 与主机源只差注册 id 行（id 必须等于包名）', () => {
  const src = readFileSync(join(ROOT, 'panel', 'client.js'), 'utf8').split('\n')
  const gen = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8').split('\n')
  assert.equal(src.length, gen.length)
  const diffs = src.map((line, i) => [line, gen[i]]).filter(([a, b]) => a !== b)
  assert.equal(diffs.length, 1, `期望只差 1 行，实际 ${diffs.length} 行`)
  assert.match(diffs[0][0], /@local\/dsh-nightshift-panel/)
  assert.match(diffs[0][1], /dsh-offhours/)
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.ok(diffs[0][1].includes(`'${pkg.name}'`), 'client id 必须等于 package name')
})
