// 关注 UP（2026-11-18）：同一个 UP 的视频她 14 天里有 ≥3 条打到分享线以上，才配关注 —— 像真人一样「这人做的我老爱看，关注了」。
//   node bili.mjs follow --suggest            看哪些 UP 够格了（只读）
//   node bili.mjs follow --mid <UP的mid> --dry|--go
// 硬规矩（写死）：够格才能关；一天最多 2 个；不爱看的沾边的不关；关过的不重复；B站风控报错就停。
// 失败都带 [follow.*] 代码。
import fs from 'node:fs'
import path from 'node:path'
import { accountBili, biliState } from '../lib/state-paths.mjs'
import { config } from '../lib/config.mjs'
import { loadScores } from '../lib/scores.mjs'
import { assertInteractEnabled } from '../lib/interact.mjs'
import { candidatesFrom, FOLLOW_NEED as NEED } from '../lib/follow-core.mjs'

const argv = process.argv.slice(2)
const opt = {}
for (let i = 0; i < argv.length; i += 1) {
  if (!argv[i].startsWith('--')) continue
  const v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) opt[argv[i].slice(2)] = true
  else { opt[argv[i].slice(2)] = v; i += 1 }
}
const STATE = biliState('follows.json')
const DAILY = 2
const today = () => new Date().toLocaleDateString('sv-SE')
const load = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { return { followed: {} } } }
const save = (o) => { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(`${STATE}.tmp`, `${JSON.stringify(o, null, 2)}\n`); fs.renameSync(`${STATE}.tmp`, STATE) }

const cfg = config()
const minScore = Number(cfg.share?.minScore ?? 13)
const st = load()
st.followed = st.followed ?? {}
const list = candidatesFrom(loadScores(), minScore, st.followed, cfg.preferences?.dislike ?? [])

if (opt.suggest || (!opt.mid && !opt.go && !opt.dry)) {
  if (!list.length) { console.log(`还没有够格的 UP（同一个 UP 14 天里 ≥${NEED} 条到 ${minScore} 分才算）`); process.exit(0) }
  console.log(`够格关注的 UP（14 天里 ≥${NEED} 条到 ${minScore} 分）：`)
  for (const c of list) console.log(`  mid ${c.mid}  ${c.up}  ${c.count} 条：${c.titles.map((t) => `「${t.slice(0, 18)}」`).join(' ')}`)
  console.log(`今天还能关 ${Math.max(0, DAILY - (st.date === today() ? st.count ?? 0 : 0))} 个：follow --mid <mid> --dry → --go`)
  process.exit(0)
}

const mid = String(opt.mid ?? '').trim()
const target = list.find((c) => c.mid === mid)
if (!/^\d{3,}$/.test(mid)) { console.error('✗ [follow.bad-mid] --mid 要给 UP 的数字 mid（follow --suggest 里有）'); process.exit(2) }
if (st.followed[mid]) { console.error('✗ [follow.already] 这个 UP 已经关注过了'); process.exit(4) }
if (!target) { console.error(`✗ [follow.not-qualified] 这个 UP 还不够格（要 14 天里 ≥${NEED} 条到 ${minScore} 分）—— 先跑 follow --suggest`); process.exit(4) }
const used = st.date === today() ? Number(st.count ?? 0) : 0
if (used >= DAILY) { console.error(`✗ [follow.daily] 今天已经关了 ${used}/${DAILY} 个，明天再说`); process.exit(4) }
console.log(`[follow] ${target.up}（mid ${mid}）· ${target.count} 条对胃口 · 今天第 ${used + 1}/${DAILY} 个`)
if (opt.dry) { console.log('  [dry] 没关 ✓ 确认后把 --dry 换成 --go'); process.exit(0) }
if (!opt.go) { console.error('✗ 必须给 --dry 或 --go'); process.exit(2) }
if (!assertInteractEnabled('关注 UP')) process.exit(3)

const cred = JSON.parse(fs.readFileSync(accountBili('credentials.json'), 'utf8'))
const body = new URLSearchParams({ fid: mid, act: '1', re_src: '11', csrf: String(cred.bili_jct) })
let j
try {
  const res = await fetch('https://api.bilibili.com/x/relation/modify', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      referer: `https://space.bilibili.com/${mid}`,
      cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`,
    },
    body,
    signal: AbortSignal.timeout(10000),
  })
  j = await res.json()
} catch (e) {
  console.error(`✗ [follow.network] 网络失败：${String(e?.message ?? e).slice(0, 80)} —— 下次再试`); process.exit(1)
}
if (j?.code !== 0) {
  console.error(`✗ [follow.rejected] B站拒绝 code=${j?.code} ${j?.message ?? ''} —— 可能是风控，今天别再关了`)
  save({ ...st, date: today(), count: DAILY })
  process.exit(1)
}
st.followed[mid] = { up: target.up, at: new Date().toISOString(), count: target.count }
save({ ...st, date: today(), count: used + 1 })
console.log(`  ✓ 关注了 ${target.up}`)
