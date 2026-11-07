/**
 * 从 panel/client.js 生成社区包的 lib/client.js：
 * dsh 的 client module loader 按「包名」索引 bundle（注册 id 必须等于 package name），
 * 所以这里只替换注册 id，其余逐字节保持一致。prepack 与测试共用这一份逻辑。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'panel', 'client.js')
const OUT = join(ROOT, 'lib', 'client.js')
const OLD_ID = "id: '@local/dsh-nightshift-panel'"
const NEW_ID = "id: 'dsh-offhours'"

export function generate() {
  const text = readFileSync(SRC, 'utf8')
  if (!text.includes(OLD_ID)) {
    throw new Error(`panel/client.js 里找不到注册 id（${OLD_ID}）；拒绝生成错误的 client bundle`)
  }
  const out = text.replace(OLD_ID, NEW_ID)
  writeFileSync(OUT, out, 'utf8')
  return { src: SRC, out: OUT, oldId: OLD_ID, newId: NEW_ID }
}

if (process.argv[1] && process.argv[1].endsWith('gen-client.mjs')) {
  const r = generate()
  console.log(`generated ${r.out} (id ${r.newId})`)
}
