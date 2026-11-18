/**
 * 懂他（2026-11-18 用户）：
 *   ④ 他自己在 B站 看什么 —— 用他扫码登录的 owner-credentials 只读拉观看历史（缓存 2 小时）：
 *      · 他看过的不再推给他（feed 排除）；
 *      · 唤醒提示里给她几条「他最近在看」+ 他的口味标签（B站 给的 tag），她能接「你也刷到这个了？」。
 *   ⑤ 他对她分享的反应 —— 她私信分享的（pending kind=share）回了 / 没理，统计近 14 天：
 *      · 回得多 → 分享门槛降一点（多分享）；老不理 → 门槛升一点（少烦他）；
 *      · 唤醒提示里列出他回过 / 没理的那几条，她自己往他喜欢的方向偏。
 * 只读他的数据，不替他做任何操作；没登录就整段跳过（不报错）。
 */
import fs from 'node:fs'
import path from 'node:path'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const GENERIC = new Set(['日常', '搞笑', '生活', '生活记录', '视频', '综合', '必剪创作', '原创', '全程高能', '娱乐', '热门'])

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

// ── ④ 他的观看历史 ─────────────────────────────────────────────────────────
export function parseOwnerHistory(list = []) {
  const items = []
  const seen = new Set()
  for (const it of Array.isArray(list) ? list : []) {
    const business = it?.history?.business ?? it?.business
    if (business && business !== 'archive') continue
    const bv = String(it?.history?.bvid ?? it?.bvid ?? '')
    if (!/^BV[0-9A-Za-z]{10}$/.test(bv) || seen.has(bv)) continue // 两页之间会重叠
    seen.add(bv)
    items.push({
      bv,
      title: String(it?.title ?? '').slice(0, 80),
      tags: String(it?.tag_name ?? '').split(/[,，\s]+/).map((t) => t.trim()).filter((t) => t && !GENERIC.has(t)),
      at: Number(it?.view_at) ? new Date(Number(it.view_at) * 1000).toISOString() : '',
    })
  }
  return items
}

export function tasteFrom(items = [], limit = 8) {
  const counts = new Map()
  for (const it of items) for (const t of it.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1)
  return [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([tag, count]) => ({ tag, count }))
}

/** 拉他的观看历史（只读、2 小时缓存）。返回 { ok, items, taste, cached } 或 { ok:false, code }。 */
export async function refreshOwnerHistory({ credFile, cacheFile, force = false, maxAgeMs = 2 * 3_600_000, fetchImpl = (...a) => fetch(...a), now = Date.now() } = {}) {
  const cache = readJson(cacheFile, null)
  if (!force && cache?.at && now - new Date(cache.at).getTime() < maxAgeMs) return { ok: true, ...cache, cached: true }
  const cred = readJson(credFile, null)
  if (!cred?.sessdata) return { ok: false, code: 'owner-watch.no-login', error: '主人账号没登录（设置 → B站 → 扫码登录主人）' }
  const headers = { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct ?? ''}; buvid3=${cred.buvid3 ?? ''}` }
  const list = []
  for (const pn of [1, 2]) {
    try {
      const r = await fetchImpl(`https://api.bilibili.com/x/web-interface/history/cursor?ps=30&pn=${pn}`, { headers, signal: AbortSignal.timeout(8000) })
      const j = await r.json()
      if (j?.code !== 0) { if (pn === 1) return { ok: false, code: 'owner-watch.api', error: `观看历史接口 code=${j?.code} ${j?.message ?? ''}` }; break }
      list.push(...(j?.data?.list ?? []))
    } catch (e) {
      if (pn === 1) return { ok: false, code: 'owner-watch.network', error: String(e?.message ?? e).slice(0, 80) }
      break
    }
  }
  const items = parseOwnerHistory(list).slice(0, 120)
  const out = { at: new Date(now).toISOString(), items, taste: tasteFrom(items) }
  try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, `${JSON.stringify(out, null, 2)}\n`) } catch {}
  return { ok: true, ...out, cached: false }
}

export function ownerSeen(cacheFile) {
  return new Set((readJson(cacheFile, {})?.items ?? []).map((x) => x.bv))
}

export function ownerLines(cacheFile, { recent = 5 } = {}) {
  const c = readJson(cacheFile, null)
  if (!c?.items?.length) return []
  const lines = [`【他最近自己在 B站 看的】（他的观看历史，${String(c.at).slice(5, 16).replace('T', ' ')} 更新）：`]
  for (const it of c.items.slice(0, recent)) lines.push(`   · 「${it.title}」${it.tags?.length ? `（${it.tags.slice(0, 2).join('/')}）` : ''}`)
  if (c.taste?.length) lines.push(`   他最近的口味：${c.taste.map((t) => t.tag).join('、')}`)
  lines.push('   → 他看过的你推不过去（feed 已经排掉了）；聊到时可以接「你也刷到这个了？」，别把他的记录一条条念出来')
  return lines
}

// ── ⑤ 他对分享的反应 ──────────────────────────────────────────────────────
/** 近 days 天她私信分享的：回了几条、没理几条、还在等几条。 */
export function shareReactions(moodState = {}, { days = 14, now = Date.now() } = {}) {
  const since = now - days * 86_400_000
  const shares = (moodState.pending ?? []).filter((p) => p.kind === 'share' && new Date(p.at).getTime() >= since)
  return {
    answered: shares.filter((p) => p.answered),
    ignored: shares.filter((p) => p.expired && !p.answered),
    waiting: shares.filter((p) => !p.answered && !p.expired),
  }
}

/** 分享门槛跟着他的反应走：至少 4 条有结果才调；回得多降、老不理升，最多 ±2。 */
export function effectiveMinScore(base, moodState = {}, opts = {}) {
  const b = Number.isFinite(Number(base)) ? Number(base) : 13
  const { answered, ignored } = shareReactions(moodState, opts)
  const n = answered.length + ignored.length
  if (n < 4) return { minScore: b, offset: 0, rate: null, samples: n }
  const rate = answered.length / n
  const offset = rate >= 0.8 ? -2 : rate >= 0.6 ? -1 : rate <= 0.1 ? 2 : rate <= 0.25 ? 1 : 0
  return { minScore: Math.max(0, Math.min(20, b + offset)), offset, rate: Math.round(rate * 100) / 100, samples: n }
}

/** 给提示用：他回过 / 没理的分享（带标题，标题从评分里找）。 */
export function reactionLines(moodState = {}, scores = {}, base = 13, opts = {}) {
  const title = new Map()
  for (const rows of Object.values(scores ?? {})) for (const r of Array.isArray(rows) ? rows : []) if (r?.bv) title.set(r.bv, r.title || r.bv)
  const { answered, ignored } = shareReactions(moodState, opts)
  const eff = effectiveMinScore(base, moodState, opts)
  const name = (p) => `「${title.get(String(p.target ?? '').replace(/^BV:/, '')) ?? String(p.target ?? '?').replace(/^BV:/, '')}」`
  const lines = []
  if (answered.length) lines.push(`   他回过的分享：${answered.slice(-4).map(name).join('、')} → 往这种偏`)
  if (ignored.length) lines.push(`   他没理的：${ignored.slice(-4).map(name).join('、')} → 这种少推`)
  if (eff.offset) lines.push(`   所以现在分享门槛是 ${eff.minScore} 分（平时 ${base}，${eff.offset < 0 ? '他最近很买账，可以多分享' : '他最近不太理，挑更好的再发'}）`)
  return lines.length ? ['【他对你分享的反应】（近 14 天）', ...lines] : []
}
