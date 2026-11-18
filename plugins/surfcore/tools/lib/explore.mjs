/**
 * 「出去逛」：她按自己的记忆（日记、最近刷到对胃口的）临时决定今天往哪个方向搜（2026-11-18 用户：
 * 让搜索跟着她的记忆走，方向能自己换）。方向由模型定（feed --explore "词1,词2"），这里只管硬规矩：
 *   · 一次最多 2 个词；跟「不爱看」沾边的直接拒（防止她自己逛回去）；
 *   · 总权重最多占全部偏好的 30%（主人在设置页调的口味权重始终说了算）；
 *   · 每次逛了什么、推了哪几条记下来，配合评分算「这个方向值不值得接着挖」。
 * 只用 B站侧的东西（日记 / 评分 / 收藏），不碰桌宠和看屏幕的记忆（用户 2026-11 定：两边记忆不互通）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { splitTokens } from './feed-core.mjs'

export const MAX_EXPLORE_TERMS = 2
export const MAX_EXPLORE_SHARE = 0.3

/** 拆词 + 去重 + 拒掉跟 dislike 沾边的。返回 { terms, rejected:[{term, why}] }。 */
export function normalizeExploreTerms(raw, dislike = []) {
  const list = (Array.isArray(raw) ? raw : String(raw ?? '').split(/[,，、\n]/))
    .map((t) => String(t).replace(/\s+/g, ' ').trim().slice(0, 30))
    .filter((t) => t.length >= 2)
  const bad = (Array.isArray(dislike) ? dislike : []).flatMap((d) => splitTokens(d))
  // 英文 token 按词边界比（「ai」不该误伤「aim」「rain」）；中文照旧按包含。
  const latin = (tok) => /^[a-z0-9+#._-]+$/.test(tok)
  const wordHit = (text, tok) => new RegExp(`(^|[^a-z0-9])${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(text)
  const touches = (low, tok) => (latin(tok) ? wordHit(low, tok) : (low.includes(tok) || tok.includes(low)))
  const terms = []
  const rejected = []
  const seen = new Set()
  for (const term of list) {
    const low = term.toLowerCase()
    if (seen.has(low)) continue
    seen.add(low)
    const hit = bad.find((tok) => touches(low, tok))
    if (hit) { rejected.push({ term, why: `和「不爱看」的「${hit}」沾边` }); continue }
    if (terms.length >= MAX_EXPLORE_TERMS) { rejected.push({ term, why: `一次最多 ${MAX_EXPLORE_TERMS} 个方向` }); continue }
    terms.push(term)
  }
  return { terms, rejected }
}

/** 每个探索词的权重：合计不超过全部权重的 30%，单个不超过 1。 */
export function exploreWeight(baseEntries = [], count = 1) {
  const k = Math.max(1, Number(count) || 1)
  const sum = (Array.isArray(baseEntries) ? baseEntries : []).reduce((s, e) => s + Math.max(0, Number(e?.weight) || 0), 0)
  if (sum <= 0) return 1
  const total = (MAX_EXPLORE_SHARE / (1 - MAX_EXPLORE_SHARE)) * sum
  return Math.round(Math.min(1, total / k) * 1000) / 1000
}

export function exploreEntries(terms = [], baseEntries = []) {
  const w = exploreWeight(baseEntries, terms.length)
  return terms.map((term) => ({ key: `explore:${term.toLowerCase()}`, label: term, kind: 'explore', weight: w, tokens: splitTokens(term) }))
}

/**
 * 从探索词搜出来的候选，算作命中这个探索词（中文短语如「狼叔整活」很少原样出现在标题里，
 * 只靠标题匹配会全部落进「无偏好」那一堆 → 战绩永远是 0 条，她会误判方向不行）。
 */
export function withExploreHits(hits = [], candidate = {}, explore = []) {
  const out = [...hits]
  for (const e of explore) if (candidate?.kw === e.label && !out.includes(e)) out.push(e)
  return out
}

export function readExploreLog(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(j?.entries) ? j.entries : []
  } catch { return [] }
}

export function appendExploreLog(file, entry, { keep = 60 } = {}) {
  const entries = [...readExploreLog(file), entry].slice(-keep)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`)
  fs.renameSync(tmp, file)
  return entries
}

/** 每个方向的战绩：推了几条、评了几条、平均分。scores = scores.json（日期 → [{bv, score}]）。 */
export function exploreSummary(entries = [], scores = {}, { limit = 6 } = {}) {
  const scoreOf = new Map()
  for (const rows of Object.values(scores ?? {})) {
    for (const r of Array.isArray(rows) ? rows : []) if (r?.bv && Number.isFinite(Number(r.score))) scoreOf.set(r.bv, Number(r.score))
  }
  const byTerm = new Map()
  for (const e of entries) {
    const key = String(e?.term ?? '').toLowerCase()
    if (!key) continue
    const cur = byTerm.get(key) ?? { term: e.term, last: e.date, times: 0, bvs: new Set() }
    cur.times += 1
    cur.last = e.date > cur.last ? e.date : cur.last
    for (const bv of e.bvs ?? []) cur.bvs.add(bv)
    byTerm.set(key, cur)
  }
  return [...byTerm.values()]
    .map((t) => {
      const scored = [...t.bvs].filter((bv) => scoreOf.has(bv)).map((bv) => scoreOf.get(bv))
      const avg = scored.length ? Math.round((scored.reduce((a, b) => a + b, 0) / scored.length) * 10) / 10 : null
      return { term: t.term, last: t.last, times: t.times, picked: t.bvs.size, scored: scored.length, avg }
    })
    .sort((a, b) => String(b.last).localeCompare(String(a.last)))
    .slice(0, limit)
}

export function exploreSummaryLines(summary = [], minScore = 13) {
  return summary.map((s) => {
    const verdict = s.avg === null ? '还没评分' : s.avg >= minScore ? '对胃口 ✓ 可以接着挖' : s.avg >= minScore - 4 ? '一般' : '不行 ✗ 换方向'
    return `  · ${s.last}「${s.term}」逛了 ${s.times} 次、推了 ${s.picked} 条、评了 ${s.scored} 条${s.avg === null ? '' : `、平均 ${s.avg} 分`} → ${verdict}`
  })
}
