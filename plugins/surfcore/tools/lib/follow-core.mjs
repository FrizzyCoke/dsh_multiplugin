// 关注 UP 的够格判断（纯函数，follow.mjs 用；单测直接调）。
export const FOLLOW_NEED = 3

/** 14 天评分里，每个 UP 有几条 ≥ minScore。 */
export function candidatesFrom(scores, minScore, followed = {}, dislike = []) {
  const byMid = new Map()
  for (const rows of Object.values(scores ?? {})) {
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r?.mid || Number(r.score) < minScore) continue
      const cur = byMid.get(r.mid) ?? { mid: r.mid, up: r.up ?? '', bvs: new Set(), titles: [] }
      cur.bvs.add(r.bv)
      if (r.title) cur.titles.push(r.title)
      byMid.set(r.mid, cur)
    }
  }
  const bad = dislike.map((d) => String(d).toLowerCase()).filter(Boolean)
  return [...byMid.values()]
    .map((c) => ({ mid: c.mid, up: c.up, count: c.bvs.size, titles: c.titles.slice(0, 3) }))
    .filter((c) => c.count >= FOLLOW_NEED && !followed[c.mid])
    .filter((c) => !bad.some((d) => `${c.up} ${c.titles.join(' ')}`.toLowerCase().includes(d)))
    .sort((a, b) => b.count - a.count)
}

