// 你们之间的梗（2026-11-18）：他真的被逗到 / 你们来回聊起来的那些，记下来以后偶尔翻出来用。
//   node bili.mjs joke list
//   node bili.mjs joke add --text "狼叔职业病" --source BV1xxxx | --source dm  [--note "他回了三个笑死"]
//   node bili.mjs joke use --id 3         （用了记一笔：同一个梗 3 天内别再用，一天最多翻一个旧梗）
// 硬规矩：必须有出处（BV 号，或他 48 小时内真私信过你 = dm），不许编；最多存 30 个。
import fs from 'node:fs'
import path from 'node:path'
import { biliState } from '../lib/state-paths.mjs'

const argv = process.argv.slice(2)
const opt = {}
for (let i = 0; i < argv.length; i += 1) {
  if (!argv[i].startsWith('--')) continue
  const v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) opt[argv[i].slice(2)] = true
  else { opt[argv[i].slice(2)] = v; i += 1 }
}
const FILE = biliState('jokes.json')
const MAX = 30
const load = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return { items: [] } } }
const save = (o) => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(`${FILE}.tmp`, `${JSON.stringify(o, null, 2)}\n`); fs.renameSync(`${FILE}.tmp`, FILE) }
const today = () => new Date().toLocaleDateString('sv-SE')
const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'list'
const db = load()
db.items = Array.isArray(db.items) ? db.items : []

if (cmd === 'add') {
  const text = String(opt.text ?? '').trim().slice(0, 40)
  const source = String(opt.source ?? '').trim()
  if (!text) { console.error('✗ [joke.no-text] --text 写梗本身（短）'); process.exit(2) }
  let ok = /^BV[0-9A-Za-z]{10}$/.test(source)
  if (source === 'dm') {
    try { ok = Date.now() - new Date(JSON.parse(fs.readFileSync(biliState('owner-last-dm.json'), 'utf8')).at).getTime() < 48 * 3_600_000 } catch { ok = false }
  }
  if (!ok) { console.error('✗ [joke.no-source] 梗要有出处：--source BV号（那条视频），或 --source dm（他 48 小时内真私信过你）—— 没出处就是编的，不记'); process.exit(4) }
  if (db.items.some((j) => j.text.toLowerCase() === text.toLowerCase())) { console.log('（这个梗已经记过了）'); process.exit(0) }
  const id = (db.items.reduce((m, j) => Math.max(m, j.id), 0) || 0) + 1
  db.items = [...db.items, { id, text, source, note: String(opt.note ?? '').slice(0, 60), at: new Date().toISOString(), uses: 0, lastUsed: '' }].slice(-MAX)
  save(db)
  console.log(`✓ 记下梗 #${id}：${text}（出处 ${source}）`)
  process.exit(0)
}
if (cmd === 'use') {
  const j = db.items.find((x) => x.id === Number(opt.id))
  if (!j) { console.error('✗ [joke.not-found] 没这个梗（joke list 看编号）'); process.exit(2) }
  if (db.usedDate === today()) { console.error('✗ [joke.daily] 今天已经翻过一个旧梗了，明天再说'); process.exit(4) }
  if (j.lastUsed && Date.now() - new Date(j.lastUsed).getTime() < 3 * 86_400_000) { console.error('✗ [joke.recent] 这个梗 3 天内用过了，换一个或者不用'); process.exit(4) }
  j.uses += 1
  j.lastUsed = new Date().toISOString()
  db.usedDate = today()
  save(db)
  console.log(`✓ 用了梗 #${j.id}：${j.text}`)
  process.exit(0)
}
if (!db.items.length) { console.log('还没有你们之间的梗'); process.exit(0) }
const usable = (j) => !(j.lastUsed && Date.now() - new Date(j.lastUsed).getTime() < 3 * 86_400_000)
console.log(`你们之间的梗（${db.items.length}）${db.usedDate === today() ? '——今天已经翻过一个了' : ''}：`)
for (const j of db.items.slice(-12).reverse()) console.log(`  #${j.id} ${j.text}  [${j.source}]${j.note ? ` ${j.note}` : ''}${usable(j) ? '' : '（最近用过）'}`)
