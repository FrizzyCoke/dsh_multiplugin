// 心情（2026-11-18）：看 / 记一笔。规则与上下限在 lib/mood.mjs。
//   node bili.mjs mood                      看现在的心情（回落后）+ 最近几笔
//   node bili.mjs mood note --delta 2 --why "他发的梗笑死" [--kind dm]
//     ⚠️ 只记你**真的**有感觉的：他说的好笑/暖心 +1~+2，冲你/敷衍 -1；普通的话不用记。代码会夹住幅度和速度。
import { biliState } from '../lib/state-paths.mjs'
import { config } from '../lib/config.mjs'
import { applyMood, decayedMood, moodGuidance, readMood, writeMood } from '../lib/mood.mjs'

const argv = process.argv.slice(2)
const opt = {}
for (let i = 0; i < argv.length; i += 1) {
  if (!argv[i].startsWith('--')) continue
  const v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) opt[argv[i].slice(2)] = true
  else { opt[argv[i].slice(2)] = v; i += 1 }
}
const FILE = biliState('mood.json')
const cfg = config().mood ?? {}
const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'status'

if (cmd === 'note') {
  const delta = Number(opt.delta)
  const why = String(opt.why ?? '').trim()
  if (!Number.isFinite(delta) || delta === 0) { console.error('✗ [mood.bad-delta] --delta 要给 ±1~±3'); process.exit(2) }
  if (!why) { console.error('✗ [mood.no-why] --why 写一句为什么（他说了啥 / 看到了啥）'); process.exit(2) }
  const kind = ['dm', 'video', 'manual'].includes(String(opt.kind)) ? String(opt.kind) : 'dm'
  const r = applyMood(readMood(FILE), delta, { why, kind, cfg })
  writeMood(FILE, r.state)
  const g = moodGuidance(r.value, cfg)
  console.log(`✓ 心情 ${r.applied >= 0 ? '+' : ''}${r.applied}${r.applied !== delta ? '（被限速/上限夹了）' : ''} → ${r.value}（${g.label}）`)
  process.exit(0)
}

const st = readMood(FILE)
const v = decayedMood(st, Date.now(), cfg)
const g = moodGuidance(v, cfg)
console.log(`心情：${v}（${g.label}）—— ${g.how}`)
for (const e of (st.events ?? []).slice(-6).reverse()) console.log(`  ${e.at.slice(5, 16).replace('T', ' ')}  ${e.applied >= 0 ? '+' : ''}${e.applied}  [${e.kind}] ${e.why}`)
const open = (st.pending ?? []).filter((p) => !p.answered && !p.expired).length
if (open) console.log(`  （你主动发的还有 ${open} 条他没回）`)
