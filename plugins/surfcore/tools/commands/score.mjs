// 记一次「今天这条视频值几分」（2026-10-21 加）
//
// 用途：每天那条动态必须写**当天评分最高的视频**。所以每深读一条就记一次分，
//   晚上（或当轮）取最高分的来写。**没到 13 分也要记** —— 动态不看阈值，只看排名。
//
//   node bili.mjs score <BV> --score 16 [--reason "为什么给这个分"] [--title "视频标题"]
//   node bili.mjs score --today     看今天评过哪些（从高到低）
//   node bili.mjs score --best      只看最高分那条
import { recordScore, todayScores, bestToday } from '../lib/scores.mjs'
import { biliState } from '../lib/state-paths.mjs'
import { config } from '../lib/config.mjs'
import { applyMood, readMood, writeMood } from '../lib/mood.mjs'

const argv = process.argv.slice(2)
const opt = {}
const pos = []
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a.startsWith('--')) {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) opt[a.slice(2)] = true
    else { opt[a.slice(2)] = v; i += 1 }
  } else pos.push(a)
}

const line = (x) => `  ${String(x.score).padStart(2)}/20  ${x.bv}  ${x.title ? x.title.slice(0, 40) + '  ' : ''}${x.reason ? '· ' + x.reason.slice(0, 40) : ''}`

if (opt.today || opt.best) {
  const list = todayScores()
  if (!list.length) { console.log('今天还没评过分（用 score <BV> --score N 记一条）'); process.exit(1) }
  console.log(`今天评过的（${list.length} 条，从高到低）：`)
  for (const x of list) console.log(line(x))
  if (opt.best) {
    const b = bestToday()
    console.log(`\n最高分：${b.bv}（${b.score}/20）`)
    console.log(`BV:${b.bv}`)
  }
  process.exit(0)
}

const bv = String(pos[0] ?? '').trim()
const score = Number(opt.score)
if (!/^BV[0-9A-Za-z]{10}$/.test(bv)) { console.error('用法: score <BV号> --score 0-20 [--reason "…"] [--title "…"]'); process.exit(2) }
if (!Number.isFinite(score) || score < 0 || score > 20) { console.error('✗ --score 必须是 0~20 的数字（每项 0-4，满 20）'); process.exit(2) }

// 2026-11-18：顺手记下 UP 主（关注 UP 要按「同一个 UP 有几条对胃口」来判断）；查不到不影响记分。
let up = { mid: '', name: '', title: '' }
try {
  const r = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`, {
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', referer: 'https://www.bilibili.com/' },
    signal: AbortSignal.timeout(8000),
  })
  const j = await r.json()
  if (j?.code === 0) up = { mid: String(j.data?.owner?.mid ?? ''), name: String(j.data?.owner?.name ?? ''), title: String(j.data?.title ?? '') }
} catch { /* 网络不好就只记分 */ }
const list = recordScore({ bv, score, reason: String(opt.reason ?? ''), title: String(opt.title ?? '') || up.title, up: up.name, mid: up.mid })
// 2026-11-18：视频内容影响心情 —— 很对胃口 +1、很烂 -1（限速在 lib/mood.mjs）。
try {
  const minScore = Number(config().share?.minScore ?? 13)
  const delta = score >= minScore + 3 ? 1 : score <= 4 ? -1 : 0
  if (delta) {
    const file = biliState('mood.json')
    const r = applyMood(readMood(file), delta, { why: `${delta > 0 ? '刷到好的' : '刷到垃圾'}：${(String(opt.title ?? '') || up.title || bv).slice(0, 30)}`, kind: 'video', cfg: config().mood ?? {} })
    writeMood(file, r.state)
  }
} catch { /* 心情记不上不影响记分 */ }
const best = [...list].sort((a, b) => Number(b.score) - Number(a.score))[0]
console.log(`✓ 记下了：${bv} → ${score}/20`)
console.log(`  今天最高分：${best.bv}（${best.score}/20）${best.bv === bv ? '  ← 就是这条' : ''}`)
