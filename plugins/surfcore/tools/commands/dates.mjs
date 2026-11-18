// 他说过的日子（2026-11-18）：
//   node bili.mjs dates list
//   node bili.mjs dates add --when 2026-12-03 --what "他考试" [--yearly]     （生日这种每年的用 --when 03-15 或加 --yearly）
//   node bili.mjs dates del --id N
// 硬规矩：只记他自己说的 —— 他 48 小时内真私信过你才能加（插件私信监听记的）；最多 50 条。
import fs from 'node:fs'
import { biliState } from '../lib/state-paths.mjs'
import { dueDates, parseWhen, readDates, writeDates } from '../lib/dates.mjs'

const argv = process.argv.slice(2)
const opt = {}
for (let i = 0; i < argv.length; i += 1) {
  if (!argv[i].startsWith('--')) continue
  const v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) opt[argv[i].slice(2)] = true
  else { opt[argv[i].slice(2)] = v; i += 1 }
}
const FILE = biliState('dates.json')
const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'list'
const items = readDates(FILE)

if (cmd === 'add') {
  const what = String(opt.what ?? '').trim().slice(0, 40)
  const w = parseWhen(opt.when, { yearly: opt.yearly === true })
  if (!w) { console.error('✗ [dates.bad-when] --when 写 2026-12-03（一次性）或 03-15（每年）'); process.exit(2) }
  if (!what) { console.error('✗ [dates.no-what] --what 写是什么日子（他的原话里的）'); process.exit(2) }
  let recent = false
  try { recent = Date.now() - new Date(JSON.parse(fs.readFileSync(biliState('owner-last-dm.json'), 'utf8')).at).getTime() < 48 * 3_600_000 } catch {}
  if (!recent) { console.error('✗ [dates.no-source] 只记他自己说的：他 48 小时内没私信过你，这个日子从哪来的？不记'); process.exit(4) }
  if (items.some((d) => d.when === w.when && d.what === what)) { console.log('（这个日子已经记过了）'); process.exit(0) }
  const id = items.reduce((m, d) => Math.max(m, d.id ?? 0), 0) + 1
  writeDates(FILE, [...items, { id, ...w, what, at: new Date().toISOString() }])
  console.log(`✓ 记下了 #${id}：${w.when}${w.yearly ? '（每年）' : ''} ${what}`)
  process.exit(0)
}
if (cmd === 'del') {
  const id = Number(opt.id)
  if (!items.some((d) => d.id === id)) { console.error('✗ [dates.not-found] 没这条（dates list 看编号）'); process.exit(2) }
  writeDates(FILE, items.filter((d) => d.id !== id))
  console.log(`✓ 删了 #${id}`)
  process.exit(0)
}
if (!items.length) { console.log('还没记他说过的日子'); process.exit(0) }
const due = new Set(dueDates(items).map((d) => d.id))
console.log(`他说过的日子（${items.length}）：`)
for (const d of items) console.log(`  #${d.id} ${d.when}${d.yearly ? '（每年）' : ''} ${d.what}${due.has(d.id) ? '  ← 快到了' : ''}`)
