// 记一次「今天这条视频值几分」（2026-10-21 加）
//
// 用途：每天那条动态必须写**当天评分最高的视频**。所以每深读一条就记一次分，
//   晚上（或当轮）取最高分的来写。**没到 13 分也要记** —— 动态不看阈值，只看排名。
//
//   node bili.mjs score <BV> --fits "类别1,类别2" --funny 0-4 --hooked 0-4 --reason "…" [--dislike "类别"] [--title "视频标题"]
//   （2026-11-18 起总分由代码按标尺算，见 lib/score-rubric.mjs；她只给有锚点的几样判断）
//   node bili.mjs score --today     看今天评过哪些（从高到低）
//   node bili.mjs score --best      只看最高分那条
import fs from 'node:fs'
import { recordScore, todayScores, bestToday, loadScores } from '../lib/scores.mjs'
import { computeScore, normalizeScoringConfig, pickLabels } from '../lib/score-rubric.mjs'
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
  if (!list.length) { console.log('今天还没评过分（用 score <BV> --fits "…" --funny 0-4 --hooked 0-4 --reason "…" 记一条）'); process.exit(1) }
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
if (!/^BV[0-9A-Za-z]{10}$/.test(bv)) { console.error('用法: score <BV号> --fits "类别1,类别2" --funny 0-4 --hooked 0-4 --reason "…" [--dislike "类别"]'); process.exit(2) }
// 2026-11-18：不再收她自己报的总分 —— 14 分由代码按口味 / 他的口味 / 记忆 / 新鲜算，她只给两样有锚点的判断（lib/score-rubric.mjs）。
if (opt.score !== undefined && opt.funny === undefined && opt.hooked === undefined) {
  console.error('✗ [score.old-form] 不再直接报总分了。改成：score <BV> --fits "你口味里的哪几类" --funny 0-4 --hooked 0-4 --reason "…"（总分代码算）')
  process.exit(2)
}
const funny = Number(opt.funny)
const hooked = Number(opt.hooked)
if (![funny, hooked].every((v) => Number.isInteger(v) && v >= 0 && v <= 4)) { console.error('✗ [score.bad-item] --funny 和 --hooked 都要给 0~4 的整数（锚点见唤醒提示）'); process.exit(2) }
if (String(opt.reason ?? '').trim().length < 4) { console.error('✗ [score.no-reason] --reason 写一句为什么（≥4 字）'); process.exit(2) }

// 视频信息（公开接口，只读）：标题 / 分区 / UP / 标签。查不到就按已知的算，不影响记分。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const getJson = async (url) => { try { return await (await fetch(url, { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(8000) })).json() } catch { return null } }
let up = { mid: '', name: '', title: '' }
let tname = ''
let tags = []
if (process.env.SURFCORE_SCORE_OFFLINE !== '1') {
  const view = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`)
  if (view?.code === 0) {
    up = { mid: String(view.data?.owner?.mid ?? ''), name: String(view.data?.owner?.name ?? ''), title: String(view.data?.title ?? '') }
    tname = String(view.data?.tname ?? '')
  }
  const tagJ = await getJson(`https://api.bilibili.com/x/tag/archive/tags?bvid=${bv}`)
  if (tagJ?.code === 0) tags = (tagJ.data ?? []).map((t) => String(t?.tag_name ?? '')).filter(Boolean).slice(0, 12)
}
const title = String(opt.title ?? '') || up.title

// 算分要用的「她的口味 / 他的口味 / 她的记忆」——全是本地文件
const cfgAll = config()
const readJ = (name, d) => { try { return JSON.parse(fs.readFileSync(biliState(name), 'utf8')) } catch { return d } }
const allScores = loadScores()
const shareBar = Number(cfgAll.share?.minScore ?? 13)
const rows = Object.entries(allScores).flatMap(([day, list]) => (Array.isArray(list) ? list.map((r) => ({ ...r, day })) : []))
const todayStr = new Date().toLocaleDateString('sv-SE')
const threeDaysAgo = Date.now() - 3 * 86_400_000
const ctx = {
  like: cfgAll.preferences?.like ?? [],
  dislike: cfgAll.preferences?.dislike ?? [],
  prefWeights: cfgAll.preferences?.weights ?? {},
  ownerTaste: readJ('owner-history.json', {})?.taste ?? [],
  favorites: (readJ('favorites.json', {})?.items ?? []).flatMap((x) => [x.title, x.reason]).filter(Boolean).slice(-40),
  highTitles: rows.filter((r) => r.bv !== bv && Number(r.score) >= shareBar + 3).map((r) => r.title).filter(Boolean).slice(-30),
  goodExplore: (readJ('explore-log.json', {})?.entries ?? []).map((e) => e.term).filter(Boolean).slice(-10),
  jokes: (readJ('jokes.json', {})?.items ?? []).map((j) => j.text).filter(Boolean),
  recent: rows.filter((r) => r.bv !== bv && new Date(r.at ?? 0).getTime() >= threeDaysAgo).map((r) => ({ title: r.title, mid: r.mid })),
  exploreToday: (readJ('explore-log.json', {})?.entries ?? []).filter((e) => e.date === todayStr).map((e) => e.term),
}
const fitsPick = pickLabels(opt.fits === true ? '' : opt.fits, ctx.like)
const disPick = pickLabels(opt.dislike === true ? '' : opt.dislike, ctx.dislike)
for (const u of [...fitsPick.unknown, ...disPick.unknown]) console.error(`（「${u}」不在你的口味 / 不爱看列表里，没算）`)
const result = computeScore(
  { title, tname, tags, mid: up.mid, kw: String(opt.kw ?? '') },
  { fits: fitsPick.ok, dislikes: disPick.ok, funny, hooked },
  ctx,
  normalizeScoringConfig(cfgAll.scoring),
)
const score = result.total
const list = recordScore({ bv, score, reason: String(opt.reason ?? ''), title, up: up.name, mid: up.mid, items: result.items, fits: result.fits, dislikes: result.dislikes, tname })
const nm = { taste: '口味', him: '他会喜欢', memory: '记忆', fresh: '新鲜', funny: '好笑', hooked: '上头' }
console.log(`  分项：${Object.entries(result.items).map(([k, v]) => `${nm[k]} ${v}`).join(' · ')}${result.capped ? '（沾了不爱看的 → 封顶）' : ''}`)
if (result.notes.length) console.log(`  依据：${result.notes.join('；')}`)
// 2026-11-18：视频内容影响心情 —— 很对胃口 +1、很烂 -1（限速在 lib/mood.mjs）。
try {
  const minScore = Number(config().share?.minScore ?? 13)
  const delta = score >= minScore + 3 ? 1 : (result.capped || result.dislikes.length || score <= 4) ? -1 : 0 // 沾了不爱看的也算刷到垃圾
  if (delta) {
    const file = biliState('mood.json')
    const r = applyMood(readMood(file), delta, { why: `${delta > 0 ? '刷到好的' : '刷到垃圾'}：${(String(opt.title ?? '') || up.title || bv).slice(0, 30)}`, kind: 'video', cfg: config().mood ?? {} })
    writeMood(file, r.state)
  }
} catch { /* 心情记不上不影响记分 */ }
const best = [...list].sort((a, b) => Number(b.score) - Number(a.score))[0]
console.log(`✓ 记下了：${bv} → ${score}/20`)
console.log(`  今天最高分：${best.bv}（${best.score}/20）${best.bv === bv ? '  ← 就是这条' : ''}`)
